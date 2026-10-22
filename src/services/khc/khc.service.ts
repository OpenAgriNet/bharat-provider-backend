import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { buildAifResponse as buildResponse } from "../aif/aif-response";
import { KhcMasterService, normalizeName } from "./khc-master.service";
import { REFERENCES } from "./khc-references";
import { KhcLookup, LookupError } from "./khc-lookup";

export { REFERENCES };

type Values = Record<string, unknown>;
type Action = "on_init" | "on_status";
interface KhcRequest {
  context?: { transaction_id?: string };
  message?: {
    order?: {
      provider?: { id?: string };
      items?: { id?: string }[];
      fulfillments?: {
        customer?: {
          person?: {
            tags?: { descriptor?: { code?: string }; value?: unknown }[];
          };
        };
      }[];
    };
  };
}

class KhcError extends Error {
  constructor(message: string, readonly code = "upstream_error") {
    super(message);
  }
}


function record(value: unknown): value is Values {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(input: Values, field: string, maxLength: number): string {
  const value = input[field];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new KhcError(`A valid ${field} is required`, "invalid_request");
  }
  return value.trim();
}

function positiveId(value: unknown, field: string): number {
  const number =
    typeof value === "string" && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) {
    throw new KhcError(
      `A verified KHC ${field} ID is required. Do not guess IDs.`,
      "invalid_request"
    );
  }
  return number;
}

function optionalText(input: Values, field: string, maxLength: number): string | undefined {
  return input[field] === undefined || input[field] === ""
    ? undefined
    : text(input, field, maxLength);
}

function optionalId(value: unknown, field: string): number | undefined {
  return value === undefined || value === "" ? undefined : positiveId(value, field);
}

const listOf = (result: Values) =>
  Object.entries(result).map(([code, value]) => ({
    code,
    name: code,
    value: JSON.stringify(value),
  }));

@Injectable()
export class KhcService {
  private readonly logger = new Logger(KhcService.name);
  // ponytail: single-container verification state; use Redis before running multiple provider replicas.
  private readonly sessions = new Map<
    string,
    {
      mobile: string;
      expiresAt: number;
      verified: boolean;
      isRegistered?: boolean;
      wrongAttempts: number;
    }
  >();
  // ponytail: per-instance send history; share it through Redis before running several replicas.
  private readonly otpSends = new Map<string, number[]>();
  private readonly verificationWindowMs = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly master?: KhcMasterService
  ) {
    this.lookup = new KhcLookup({
      listAll: (kind, parentId) => this.listAll(kind, parentId),
      master,
    });
  }

  readonly lookup: KhcLookup;

  private async request(
    method: "GET" | "POST",
    path: string,
    data?: Values,
    params?: Values
  ): Promise<unknown> {
    const baseUrl = this.config
      .get<string>("KHC_BASE_URL")
      ?.trim()
      .replace(/\/+$/, "");
    const apiKey = this.config.get<string>("KHC_API_KEY")?.trim();
    if (!baseUrl || !apiKey) {
      throw new KhcError("KHC service is not configured");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new KhcError(
        "KHC_BASE_URL must be a valid HTTPS URL",
        "configuration_error"
      );
    }
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      throw new KhcError(
        "KHC_BASE_URL must be a valid HTTPS URL",
        "configuration_error"
      );
    }

    let payload: unknown;
    try {
      const response = await axios.request<unknown>({
        method,
        url: `${baseUrl}${path}`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${apiKey}`,
        },
        timeout: 20000,
        maxRedirects: 0,
        ...(method === "GET" ? { params } : { data }),
      });
      payload = response.data;
    } catch (error: unknown) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      this.logger.error(
        `[KHC] ${method} failed http_status=${status ?? "unavailable"}`
      );
      if (status === 404 && path === "/v1/state/grievances/status") {
        throw new KhcError(
          "Grievance not found. Please check the grievance number.",
          "not_found"
        );
      }
      if (method === "POST" && path === "/v1/state/grievances") {
        if (status === 400 || status === 404) {
          throw new KhcError(
            status === 404
              ? "KHC has no assigned officer for the selected scheme and location."
              : "KHC rejected the grievance details. Check the mobile, location, scheme and category.",
            "invalid_request"
          );
        }
        throw new KhcError(
          "KHC grievance submission was not confirmed. Do not submit again automatically; verify with KHC first.",
          "submission_unconfirmed"
        );
      }
      if (path === "/auth/verify-otp" && (status === 400 || status === 401)) {
        throw new KhcError(
          "OTP verification failed. Check the OTP or request a new one.",
          "invalid_otp"
        );
      }
      throw new KhcError("KHC could not be reached. Please try again later.");
    }

    if (
      !record(payload) ||
      typeof payload.status !== "string" ||
      !/^20[01](?:\s|$)/.test(payload.status) ||
      !("data" in payload)
    ) {
      this.logger.error(
        `[KHC] ${method} returned an invalid or unsuccessful response`
      );
      throw new KhcError(
        path === "/v1/state/grievances" && method === "POST"
          ? "KHC grievance submission was not confirmed. Do not submit again automatically; verify with KHC first."
          : "KHC returned an invalid or unsuccessful response.",
        path === "/v1/state/grievances" && method === "POST"
          ? "submission_unconfirmed"
          : "upstream_error"
      );
    }
    return payload.data;
  }

  private grievanceResult(
    result: unknown,
    method: "GET" | "POST",
    grievanceNo?: string
  ): Values {
    if (
      !record(result) ||
      typeof result.grievanceNo !== "string" ||
      !result.grievanceNo.trim() ||
      (method === "GET" &&
        (result.grievanceNo !== grievanceNo ||
          typeof result.currentStatus !== "string" ||
          !result.currentStatus.trim()))
    ) {
      this.logger.error(
        `[KHC] ${method} response is missing grievance details`
      );
      throw new KhcError(
        method === "POST"
          ? "KHC grievance submission was not confirmed. Do not submit again automatically; verify with KHC first."
          : "KHC returned incomplete grievance details.",
        method === "POST" ? "submission_unconfirmed" : "upstream_error"
      );
    }
    return result;
  }

  private mobile(value: unknown): string {
    if (typeof value !== "string" || !/^[6-9][0-9]{9}$/.test(value)) {
      throw new KhcError(
        "A valid 10-digit mobile number is required.",
        "invalid_request"
      );
    }
    return value;
  }

  private otpLimit(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /** Resend timer and hourly cap per mobile, so OTP SMS cannot be spammed. */
  private checkOtpSendLimits(mobile: string): void {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const sends = (this.otpSends.get(mobile) ?? []).filter((at) => now - at < hour);
    this.otpSends.set(mobile, sends);
    const waitMs =
      sends.length && this.otpLimit("KHC_OTP_RESEND_SECONDS", 30) * 1000 - (now - sends[sends.length - 1]);
    if (waitMs > 0) {
      throw new KhcError(
        `Please wait ${Math.ceil(waitMs / 1000)} seconds before asking for a new OTP.`,
        "rate_limited"
      );
    }
    if (sends.length >= this.otpLimit("KHC_OTP_MAX_SENDS_PER_HOUR", 3)) {
      throw new KhcError(
        "Too many OTP requests for this number. Please try again after an hour.",
        "rate_limited"
      );
    }
  }

  async sendOtp(transactionId: string, value: unknown): Promise<void> {
    const mobile = this.mobile(value);
    if (!transactionId)
      throw new KhcError(
        "A conversation transaction ID is required.",
        "invalid_request"
      );
    this.checkOtpSendLimits(mobile);
    this.sessions.delete(transactionId);
    for (const [key, session] of this.sessions) {
      if (Date.now() >= session.expiresAt) this.sessions.delete(key);
    }
    await this.request("POST", "/auth/send-otp", { mobile });
    this.otpSends.set(mobile, [...(this.otpSends.get(mobile) ?? []), Date.now()]);
    this.sessions.set(transactionId, {
      mobile,
      verified: false,
      wrongAttempts: 0,
      expiresAt: Date.now() + this.verificationWindowMs,
    });
  }

  private session(transactionId: string, mobile: string, verified: boolean) {
    const session = this.sessions.get(transactionId);
    if (
      !session ||
      session.mobile !== mobile ||
      Date.now() >= session.expiresAt ||
      (verified && !session.verified)
    ) {
      if (session && Date.now() >= session.expiresAt)
        this.sessions.delete(transactionId);
      throw new KhcError(
        "Send and verify an OTP for this mobile before creating a grievance.",
        "otp_required"
      );
    }
    return session;
  }

  async verifyOtp(
    transactionId: string,
    value: unknown,
    otp: unknown
  ): Promise<boolean> {
    const mobile = this.mobile(value);
    const session = this.session(transactionId, mobile, false);
    if (typeof otp !== "string" || !/^[0-9]{6}$/.test(otp)) {
      throw new KhcError("A valid 6-digit OTP is required.", "invalid_request");
    }
    const maxAttempts = this.otpLimit("KHC_OTP_MAX_ATTEMPTS", 5);
    if (session.wrongAttempts >= maxAttempts) {
      throw new KhcError(
        "Too many wrong OTP tries. Please ask for a new OTP.",
        "rate_limited"
      );
    }
    session.verified = false;
    let result: unknown;
    try {
      result = await this.request("POST", "/auth/verify-otp", {
        mobile,
        otp,
      });
    } catch (error) {
      if (error instanceof KhcError && error.code === "invalid_otp") {
        session.wrongAttempts += 1;
        const left = maxAttempts - session.wrongAttempts;
        throw new KhcError(
          left > 0
            ? `The OTP is not correct. You have ${left} ${left === 1 ? "try" : "tries"} left.`
            : "Too many wrong OTP tries. Please ask for a new OTP.",
          left > 0 ? "invalid_otp" : "rate_limited"
        );
      }
      throw error;
    }
    if (
      !record(result) ||
      typeof result.isRegistered !== "boolean" ||
      result.mobile !== mobile ||
      typeof result.token !== "string" ||
      !result.token
    ) {
      throw new KhcError("KHC returned an invalid OTP verification response.");
    }
    if (
      this.sessions.get(transactionId) !== session ||
      Date.now() >= session.expiresAt
    ) {
      throw new KhcError(
        "The OTP session changed. Please request and verify a new OTP.",
        "otp_required"
      );
    }
    session.verified = true;
    session.wrongAttempts = 0;
    session.isRegistered = result.isRegistered;
    session.expiresAt = Date.now() + this.verificationWindowMs;
    return result.isRegistered;
  }

  /** Full list from the KHC API for one reference kind (no cache). */
  async fetchReferenceRows(kind: string, parentId?: unknown): Promise<Values[]> {
    const reference = REFERENCES[kind];
    if (!Object.prototype.hasOwnProperty.call(REFERENCES, kind)) {
      throw new KhcError("Unknown KHC reference list.", "invalid_request");
    }
    const params: Values = reference.parent
      ? {
          [reference.parent]: positiveId(parentId, reference.parent),
        }
      : {};
    const data = await this.request(
      "GET",
      `/v1/state/reference/${kind}`,
      undefined,
      params
    );
    if (
      !Array.isArray(data) ||
      !data.every(
        (row) =>
          record(row) &&
          (typeof row[reference.id] === "string" ||
            typeof row[reference.id] === "number") &&
          typeof row[reference.name] === "string"
      )
    ) {
      throw new KhcError("KHC returned an invalid reference list.");
    }
    return data as Values[];
  }

  /** A whole reference list: DB first, then the KHC API (saved), then stale DB if the API is down. */
  async listAll(kind: string, parentId?: number): Promise<Values[]> {
    const cached = await this.master?.readAll(kind, parentId ?? 0);
    if (cached) return cached;
    try {
      const rows = await this.fetchReferenceRows(kind, parentId);
      await this.master?.store(
        kind,
        parentId ?? 0,
        REFERENCES[kind].id,
        REFERENCES[kind].name,
        rows
      );
      return rows;
    } catch (error) {
      const stale = await this.master?.readAll(kind, parentId ?? 0, true);
      if (stale) return stale;
      throw error;
    }
  }

  async getReference(
    kind: string,
    parentId?: unknown,
    name = "",
    page: unknown = 1
  ): Promise<Values> {
    const reference = REFERENCES[kind];
    if (!Object.prototype.hasOwnProperty.call(REFERENCES, kind)) {
      throw new KhcError("Unknown KHC reference list.", "invalid_request");
    }
    const parent = reference.parent
      ? positiveId(parentId, reference.parent)
      : undefined;
    const pageNumber = positiveId(page, "page");

    // DB first. A miss, a stale list, or a name the cache does not know all go to the API.
    const cached = await this.master?.read(kind, parent ?? 0, name, pageNumber);
    if (cached && !(name && cached.total === 0)) return { ...cached };

    let data: Values[];
    try {
      data = await this.fetchReferenceRows(kind, parent);
    } catch (error) {
      const fallback =
        cached ?? (await this.master?.read(kind, parent ?? 0, name, pageNumber, true));
      if (fallback) {
        this.logger.warn(`KHC reference ${kind} served from cache after API failure`);
        return { ...fallback };
      }
      throw error;
    }
    await this.master?.store(kind, parent ?? 0, reference.id, reference.name, data);

    const needle = normalizeName(name);
    const matches = data.filter(
      (row) => !needle || normalizeName(String(row[reference.name])).includes(needle)
    );
    return {
      options: matches.slice((pageNumber - 1) * 50, pageNumber * 50),
      total: matches.length,
      page: pageNumber,
    };
  }

  private async lookupOrFail<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LookupError) {
        throw new KhcError(error.message, "invalid_request");
      }
      throw error;
    }
  }

  async getStatus(grievanceNo: string): Promise<Values> {
    if (
      typeof grievanceNo !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9/-]{0,99}$/.test(grievanceNo)
    ) {
      throw new KhcError(
        "Please provide a valid KHC grievance number.",
        "invalid_request"
      );
    }
    return this.grievanceResult(
      await this.request("GET", "/v1/state/grievances/status", undefined, {
        grievanceNo,
      }),
      "GET",
      grievanceNo
    );
  }

  async createGrievance(input: Values, transactionId: string): Promise<Values> {
    const mobile = this.mobile(input.farmerMobileNumber);
    const session = this.session(transactionId, mobile, true);
    const data: Values = {
      externalReferenceNo: text(input, "externalReferenceNo", 100),
      farmerMobileNumber: mobile,
      farmerLanguage: text(input, "farmerLanguage", 10),
      farmerText: text(input, "farmerText", 5000),
    };
    if (
      ![
        "hi",
        "en",
        "mr",
        "bn",
        "gu",
        "kn",
        "ta",
        "te",
        "pa",
        "or",
        "as",
        "ml",
        "ur",
        "ne",
        "mni",
      ].includes(String(data.farmerLanguage))
    ) {
      throw new KhcError(
        "A supported KHC language code is required.",
        "invalid_request"
      );
    }
    for (const field of [
      "stateId",
      "villageId",
      "scheme",
      "division",
      "problemCategory",
      "problemSubCategory",
    ]) {
      data[field] = positiveId(input[field], field);
    }
    if (!session.isRegistered) {
      data.farmerName = text(input, "farmerName", 200);
      data.gender = text(input, "gender", 1);
      if (!["M", "F", "O"].includes(String(data.gender))) {
        throw new KhcError(
          "A valid gender code (M, F or O) is required.",
          "invalid_request"
        );
      }
    }
    return this.grievanceResult(
      await this.request("POST", "/v1/state/grievances", data),
      "POST"
    );
  }

  async handle(body: KhcRequest, action: Action) {
    try {
      const values: Values = {};
      const tags =
        body.message?.order?.fulfillments?.[0]?.customer?.person?.tags ?? [];
      for (const tag of tags) {
        const code = tag.descriptor?.code;
        if (!code || Object.prototype.hasOwnProperty.call(values, code)) {
          throw new KhcError(
            "Missing or duplicate KHC input tag.",
            "invalid_request"
          );
        }
        Object.defineProperty(values, code, {
          value: tag.value,
          enumerable: true,
        });
      }
      let result: Values;
      if (action === "on_init") {
        const transactionId = body.context?.transaction_id;
        if (!transactionId)
          throw new KhcError(
            "A conversation transaction ID is required.",
            "invalid_request"
          );
        if (values.request_type === "get_reference") {
          const kind = text(values, "reference_type", 30);
          const result = await this.getReference(
            kind,
            values.parent_id,
            typeof values.name === "string" ? values.name : "",
            values.page ?? 1
          );
          return buildResponse(body, action, {
            code: "khc_reference",
            name: "KHC reference data",
            short_desc: "Choose matching KHC reference entries.",
            list: Object.entries(result).map(([code, value]) => ({
              code,
              name: code,
              value: JSON.stringify(value),
            })),
          });
        }
        if (values.request_type === "find_location") {
          const result = await this.lookupOrFail(() =>
            this.lookup.findLocation({
              name: text(values, "name", 200),
              stateId: optionalId(values.state_id, "state_id"),
              stateName: optionalText(values, "state_name", 100),
              districtId: optionalId(values.district_id, "district_id"),
              districtName: optionalText(values, "district_name", 100),
            })
          );
          return buildResponse(body, action, {
            code: "khc_location",
            name: "KHC location",
            short_desc: "Matching places with their state, district and block.",
            list: listOf(result),
          });
        }
        if (values.request_type === "grievance_tree") {
          const result = await this.lookupOrFail(() =>
            this.lookup.grievanceTree({
              stateId: optionalId(values.state_id, "state_id"),
              stateName: optionalText(values, "state_name", 100),
              scheme: optionalText(values, "scheme_name", 100),
            })
          );
          return buildResponse(body, action, {
            code: "khc_grievance_tree",
            name: "KHC grievance options",
            short_desc: "Schemes, categories and sub-categories for the state.",
            list: listOf(result),
          });
        }
        if (values.request_type === "get_otp") {
          await this.sendOtp(transactionId, values.farmerMobileNumber);
          return buildResponse(body, action, {
            code: "otp_sent",
            name: "OTP Sent",
            short_desc: "OTP sent successfully. Ask the farmer for the OTP.",
          });
        }
        if (values.request_type === "verify_otp") {
          const isRegistered = await this.verifyOtp(
            transactionId,
            values.farmerMobileNumber,
            values.otp
          );
          return buildResponse(body, action, {
            code: "otp_verified",
            name: "OTP Verified",
            short_desc: "Mobile verified successfully.",
            list: [
              {
                code: "isRegistered",
                name: "Already registered",
                value: String(isRegistered),
              },
            ],
          });
        }
        if (values.request_type !== "create_grievance") {
          throw new KhcError("Invalid KHC request_type.", "invalid_request");
        }
        if (values.confirmed !== "true") {
          throw new KhcError(
            "Ask the farmer to confirm the grievance details before submission.",
            "invalid_request"
          );
        }
        result = await this.createGrievance(values, transactionId);
      } else {
        result = await this.getStatus(text(values, "grievanceNo", 100));
      }
      const fields = [
        "grievanceNo",
        "externalReferenceNo",
        "currentStatus",
        "currentLevel",
        "createdAt",
      ];
      return buildResponse(body, action, {
        code: action === "on_init" ? "grievance_created" : "grievance_status",
        name: "Kisan Help Center",
        short_desc:
          action === "on_init"
            ? "Grievance registered successfully."
            : "Grievance status retrieved.",
        list: fields
          .filter((field) => typeof result[field] === "string")
          .map((field) => ({
            code: field,
            name: field,
            value: String(result[field]),
          })),
      });
    } catch (error: unknown) {
      const known = error instanceof KhcError;
      this.logger.warn(
        `[KHC] ${action} failed code=${known ? error.code : "internal_error"}`
      );
      return buildResponse(
        body,
        action,
        {
          code: known ? error.code : "upstream_error",
          name: "Kisan Help Center",
          short_desc: known
            ? error.message
            : "KHC request failed. Please try again later.",
        },
        { state: "FAILED" }
      );
    }
  }
}
