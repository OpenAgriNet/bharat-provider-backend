import * as crypto from "crypto";
import { FFS_COMMON_CROPS, FFS_STATE_CODES } from "./ffs-states";
import { FfsSessionStore } from "./ffs-session.store";

/**
 * FFS authentication, resumable crop mapping and fertilizer shop discovery.
 * Moved here from bharat-oan-api so the FFS credentials and API identifiers stay on
 * the provider side. The chat API keeps only the LLM crop/product interpretation: when
 * free-text names need matching, a call answers `needs_resolution` with the catalogue
 * and is repeated with `args.resolution`.
 */

const USER = "/ufa-user-service/ufa-user/v1/api";
const MASTER = "/ufa-master-service/ufa-master/v1/api";
const APPROVAL = "/ufa-approval-service/ufa-approval-service/v1/api";
const FERT = "/ufa-fertilizer-service/ufa-fertilizer/v1/api";
const APPLICANT_FETCH = "/bharatVistar/applicantFetch";
const LEVELS = ["V", "T", "D", "S"];
const PRODUCTS: Record<number, number> = { 11: 1089, 12: 1005 }; // group -> generic product
const RUN_TIMEOUT_MS = 40_000;

export interface FfsConfig {
  baseUrl: string;
  esaKey: string;
  esaIv: string;
  appVersion: string;
  timeoutMs: number;
}

export interface FfsHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  timeoutMs: number;
}

export type FfsHttp = (request: FfsHttpRequest) => Promise<{ status: number; text: string }>;

export class FfsTransportError extends Error {}

export class FfsError extends Error {
  constructor(
    readonly status: string,
    public nextAction: string,
    readonly providerError?: any
  ) {
    super(status);
  }
}

export const ffsResult = (status: string, nextAction: string, data: any = {}) => ({
  status,
  data,
  next_action: nextAction,
  source: "FFS",
});

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const isInt = (value: any) => Number.isInteger(value);
const finite = (value: any) => typeof value === "number" && Number.isFinite(value);
const pick = (source: any, keys: string[]) => {
  const out: any = {};
  for (const key of keys) if (source && key in source) out[key] = source[key];
  return out;
};
const unique = <T>(values: T[]) => Array.from(new Set(values));

/** Compact model view of shop and booking results; never reveals stock volumes. */
export function compactFfsResult(value: any): any {
  if (!isRecord(value)) return value;
  const clean = clone(value);
  const data = clean.data;
  if (!isRecord(data)) return clean;
  for (const key of ["backend_exchanges", "booking_tool_exchanges", "shop_retained"]) delete data[key];
  if (isRecord(data.selected_shop)) data.selected_shop = pick(data.selected_shop, ["shop_ref", "name", "territory"]);
  if ("shops" in data) {
    data.shops = (data.shops as any[])
      .filter(isRecord)
      .map((row, i) => ({ number: i + 1, ...pick(row, ["shop_ref", "name", "territory", "coverage", "supply"]) }));
    clean.next_action =
      "Present the numbered shops, territory and ordered product availability. Never reveal stock volumes or change the order; offer more if available";
  }
  return clean;
}

function istNow() {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date())) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    stamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/** Validates the wire arguments at the trust boundary; a bad value is a clarification, not a crash. */
class BadArgs extends Error {}

function cropSelections(value: any) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadArgs("crop_selections must be an array");
  return value.map((item) => {
    const cropCode = item?.crop_code ?? null;
    if (
      !isRecord(item) ||
      typeof item.land_ref !== "string" ||
      typeof item.crop_name !== "string" ||
      !item.crop_name.length ||
      item.crop_name.length > 100 ||
      (cropCode !== null && typeof cropCode !== "string")
    ) {
      throw new BadArgs("each crop selection needs land_ref, crop_name and an optional crop_code");
    }
    return { land_ref: item.land_ref as string, crop_name: item.crop_name as string, crop_code: cropCode as string | null };
  });
}

function orderItems(value: any) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadArgs("order must be an array");
  return value.map((item) => {
    const bags = typeof item?.bags === "string" && /^\d+$/.test(item.bags) ? Number(item.bags) : item?.bags;
    const productId = item?.product_id ?? null;
    if (
      !isRecord(item) ||
      typeof item.product !== "string" ||
      !item.product.length ||
      item.product.length > 150 ||
      (productId !== null && !isInt(productId)) ||
      !isInt(bags) ||
      bags < 1
    ) {
      throw new BadArgs("each order item needs product, an optional integer product_id and bags >= 1");
    }
    return { product: item.product as string, product_id: productId as number | null, bags: bags as number };
  });
}

export class FfsWorkflow {
  state: any = {};
  diagnostics: any = { api_calls: 0, decisions: [] };
  private lastEnvelope: any;
  private lastHttpStatus = 0;
  private deadline = 0;

  constructor(
    private readonly sessionId: string,
    private readonly questionId: string,
    private readonly store: FfsSessionStore,
    private readonly config: FfsConfig,
    private readonly http: FfsHttp,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  // ── infrastructure ──────────────────────────────────────────────────────────────

  async save() {
    this.store.set(this.sessionId, this.state);
  }

  note(event: string, fields: any = {}) {
    const events = this.diagnostics.decisions;
    if (events.length < 100) events.push({ event, ...fields });
    else this.diagnostics.decisions_omitted = (this.diagnostics.decisions_omitted ?? 0) + 1;
  }

  private encrypt(body: any): string {
    const key = Buffer.from(this.config.esaKey, "utf-8");
    const iv = Buffer.from(this.config.esaIv, "utf-8");
    if (key.length !== 32 || iv.length !== 16) {
      throw new FfsError("unavailable", "FFS login encryption is not configured correctly");
    }
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]).toString("base64");
  }

  async call(
    method: string,
    prefix: string,
    path: string,
    body?: any,
    opts: { encrypted?: boolean; params?: Record<string, string> } = {}
  ): Promise<any> {
    const encrypted = !!opts.encrypted;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new FfsTransportError("FFS run timed out");
    const headers: Record<string, string> = {
      "X-Session-Id": this.sessionId,
      "Content-Type": "application/json",
    };
    if (path === "/authenticate/user/loginByFarmerId") {
      Object.assign(headers, { isForMobile: "false", appType: "APPLICANT", platform: "ANDROID" });
    }
    if (!encrypted) {
      if (!this.state.token) throw new FfsError("needs_otp", "Ask whether the farmer wants to log in to FFS");
      headers.Authorization = "Bearer " + this.state.token;
    }
    if (this.config.appVersion) headers.version = this.config.appVersion;
    const data = encrypted ? this.encrypt(body) : body !== undefined && body !== null ? JSON.stringify(body) : undefined;

    this.diagnostics.api_calls += 1;
    const response = await this.http({
      method,
      url: this.config.baseUrl.replace(/\/+$/, "") + prefix + path,
      headers,
      params: opts.params,
      data,
      timeoutMs: Math.min(this.config.timeoutMs, remaining),
    });
    this.log(`ffs.api ${method} ${prefix}${path} status=${response.status}`);

    let responseData: any = null;
    try {
      responseData = JSON.parse(response.text);
    } catch {
      // Non-JSON bodies are classified below.
    }
    if (path === "/bharatVistar/createMultipleBookingV2") {
      // Booking has its own structural outcome check. HTTP 500 alone is not the
      // outcome; a FAILED/null envelope guarantees no write.
      if (response.status === 401) {
        delete this.state.token;
        this.state.stage = "login_expired";
        await this.save();
      }
      this.lastEnvelope = responseData;
      this.lastHttpStatus = response.status;
      return responseData;
    }
    const providerError: any = { http_status: response.status };
    if (isRecord(responseData)) Object.assign(providerError, pick(responseData, ["code", "status", "message"]));
    if (response.status === 401) {
      delete this.state.token;
      this.state.stage = "login_expired";
      await this.save();
      throw new FfsError("needs_otp", "FFS rejected the login. Explain its response and offer a new OTP", providerError);
    }
    const validation = encrypted && path.includes("validate");
    if (validation && (response.status === 400 || response.status === 429)) {
      throw new FfsError(
        response.status === 400 ? "invalid_otp" : "needs_otp",
        "Explain the FFS response; ask for the correct OTP or offer a resend",
        providerError
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new FfsError("unavailable", "Explain the FFS response; do not repeat a write automatically", providerError);
    }
    if (!isRecord(responseData)) throw new FfsError("unavailable", "FFS returned an invalid response");
    if (responseData.code !== 200) {
      throw new FfsError(
        validation && responseData.code === 400 ? "invalid_otp" : "unavailable",
        validation
          ? "Explain the FFS response; ask for the correct OTP"
          : "Explain the FFS response; FFS could not complete this request",
        providerError
      );
    }
    this.lastEnvelope = responseData;
    return responseData.data;
  }

  authenticated() {
    if (!this.state.token || (this.state.token_expires ?? 0) <= Date.now() / 1000) {
      throw new FfsError("needs_otp", "Ask whether the farmer wants to log in to FFS");
    }
  }

  ready() {
    this.authenticated();
    if (!["season", "profile", "crops"].every((k) => k in this.state)) {
      throw new FfsError("setup_incomplete", "Call ffs_verify_otp with no arguments to resume loading");
    }
  }

  // ── login ───────────────────────────────────────────────────────────────────────

  async send_otp(args: any) {
    const farmerId = String(args.farmer_id ?? "").replace(/[\s-]/g, "");
    const stateCode = String(args.state_lgd_code ?? "").trim();
    const resend = args.resend === true;
    if (!/^\d{11}$/.test(farmerId) || !FFS_STATE_CODES.has(stateCode)) {
      return ffsResult(
        "needs_clarification",
        "Use the farmer's 11-digit Farmer ID and a state LGD code from the tool's list; clarify unknown or ambiguous details"
      );
    }
    const s = this.state;
    const same = s.farmer_id === farmerId && s.state_code === stateCode;
    if (s.otp_turn === this.questionId) {
      this.note("otp_send_suppressed", { reason: "same_turn" });
      return ffsResult("already_started", "An OTP request was already attempted this turn");
    }
    const restartNeeded =
      s.stage === "login_expired" ||
      (s.token && (s.token_expires ?? 0) <= Date.now() / 1000) ||
      (!s.token && (s.otp_attempts ?? 0) > 0);
    if (same && s.stage !== "not_started" && !resend && !restartNeeded) {
      this.note("otp_send_suppressed", { reason: "already_started" });
      return ffsResult("already_started", "OTP already requested; ask for it or offer an explicit resend if needed");
    }
    this.note("otp_requested", { state_code: stateCode, resend });
    this.state = {
      farmer_id: farmerId,
      state_code: stateCode,
      village_scope: { mode: "single_village" },
      stage: "otp_outcome_unknown",
      otp_turn: this.questionId,
      otp_attempts: 0,
    };
    await this.save();
    await this.call(
      "POST",
      USER,
      "/authenticate/user/loginByFarmerId",
      { userStateLgdCode: stateCode, userFarmerId: farmerId },
      { encrypted: true }
    );
    this.note("otp_send_accepted");
    this.state.stage = "otp_pending";
    await this.save();
    return ffsResult("otp_sent", "Ask for the six-digit SMS OTP");
  }

  async verify_otp(args: any) {
    const otp = args.otp === undefined || args.otp === null ? null : String(args.otp).replace(/[\s-]/g, "");
    let s = this.state;
    if (!s.token) {
      if (!["otp_pending", "otp_outcome_unknown"].includes(s.stage)) {
        return ffsResult("needs_otp", "Ask whether to send a new OTP");
      }
      if (!otp || !/^\d{6}$/.test(otp)) return ffsResult("needs_otp", "Ask the farmer for the six-digit SMS OTP");
      if (s.verify_turn === this.questionId) {
        return ffsResult("invalid_otp", "Ask for a new OTP entry; this attempt was already processed");
      }
      s.verify_turn = this.questionId;
      this.note("otp_verification_attempted", { previous_failures: s.otp_attempts });
      await this.save();
      let data: any;
      try {
        data = await this.call(
          "POST",
          USER,
          "/authenticate/user/validateLoginByFarmerId",
          { userStateLgdCode: s.state_code, userFarmerId: s.farmer_id, otp },
          { encrypted: true }
        );
      } catch (error) {
        if (error instanceof FfsError && error.status === "invalid_otp") {
          s.otp_attempts += 1;
          await this.save();
          if (s.otp_attempts >= 3) {
            error.nextAction =
              "Three OTP verifications failed. Explain the FFS response and offer a resend; do not send automatically";
          }
        }
        throw error;
      }
      if (!isRecord(data) || !data.userToken || !data.userId || !data.userAadhaarHash) {
        throw new FfsError("unavailable", "FFS login returned an incomplete profile");
      }
      let expires: number;
      try {
        const claims = JSON.parse(Buffer.from(String(data.userToken).split(".")[1], "base64").toString("utf8"));
        expires = Number(claims.exp);
        if (!Number.isFinite(expires) || expires <= Date.now() / 1000) throw new Error("expired");
      } catch {
        throw new FfsError("unavailable", "FFS login returned an invalid token expiry");
      }
      Object.assign(s, {
        token: data.userToken,
        token_expires: expires,
        user: pick(data, ["userId", "userAadhaarHash", "userFullName", "userMobileNumber"]),
        stage: "loading",
      });
      this.note("otp_verified");
      delete s.verify_turn;
      await this.save();
    }
    this.authenticated();
    s = this.state;
    const steps: [string, string, string, string, any, any][] = [
      ["season", MASTER, "/common/getCurrentSeasonAndYear", "GET", null, null],
      ["profile", APPROVAL, APPLICANT_FETCH, "POST", "profile", null],
      ["crops", MASTER, "/common/getCropListByState", "GET", null, { stateLgdCode: s.state_code }],
    ];
    for (const [name, prefix, path, method, bodySpec, params] of steps) {
      if (name in s) {
        this.note("setup_step_reused", { step: name });
        continue;
      }
      this.note("setup_step_fetch", { step: name });
      const body =
        bodySpec === "profile"
          ? {
              stateCode: Number(s.state_code),
              aadhaarHash: s.user.userAadhaarHash,
              seasonId: s.season.season.seasonId,
              yearId: s.season.year.yearId,
            }
          : null;
      // Public reference data is shared per provider/state, never farmer-specific.
      const cropKey = crypto.createHash("sha256").update(this.config.baseUrl).digest("hex") + ":" + s.state_code;
      let data: any = name === "crops" ? this.store.getCrops(cropKey) : undefined;
      const cachedCrops = name === "crops" && data !== undefined;
      if (!cachedCrops) data = await this.call(method, prefix, path, body, { params });
      let valid: boolean;
      if (name === "profile") {
        valid = isRecord(data) && Array.isArray(data.landData);
        if (valid) {
          const ids = [
            "farmlandPlotRegistryId",
            "farmlandOwnershipId",
            "stateLgdCode",
            "districtLgdCode",
            "subDistrictLgdCode",
            "villageLgdCode",
          ];
          const rows: any[] = data.landData;
          valid = rows.every(
            (l) =>
              isRecord(l) &&
              ids.every((k) => isInt(l[k]) && l[k] > 0) &&
              Array.isArray(l.crops) &&
              l.crops.every(isRecord) &&
              String(l.stateLgdCode) === s.state_code
          );
          if (valid) valid = new Set(rows.map((l) => l.farmlandPlotRegistryId)).size === rows.length;
        }
      } else if (name === "season") {
        valid =
          isRecord(data) &&
          ["season", "year"].every((k) => isRecord(data[k]) && isInt(data[k][k + "Id"]) && data[k][k + "Id"] > 0);
      } else {
        valid = Array.isArray(data) && data.every(isRecord);
        if (valid) valid = data.every((row: any) => typeof row.cropCode === "string" && typeof row.cropName === "string");
      }
      if (!valid) {
        const details = pick(this.lastEnvelope ?? {}, ["code", "status", "message"]);
        if (isRecord(data) && data.message) details.message = data.message;
        throw new FfsError(
          "setup_incomplete",
          "Explain the FFS response. Setup can resume through ffs_verify_otp without another OTP",
          details
        );
      }
      if (name === "crops") {
        data = (data as any[]).map((row) => ({ cropCode: row.cropCode, cropName: row.cropName }));
        if (!cachedCrops) this.store.setCrops(cropKey, data);
        this.note("crop_catalog", { cached: cachedCrops, count: data.length });
      }
      s[name] = data;
      await this.save();
    }
    if (s.stage === "loading") s.stage = "farmer_ready";
    await this.save();
    return this.farmerView();
  }

  // ── farmer lands ────────────────────────────────────────────────────────────────

  landEntries(): [string, any][] {
    return (this.state.profile.landData as any[]).map((land, i) => [`land-${i + 1}`, land]);
  }

  landMap(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [ref, land] of this.landEntries()) out[ref] = land;
    return out;
  }

  villages(): [string, string][] {
    const codes = unique(this.landEntries().map(([, land]) => String(land.villageLgdCode)));
    return codes.map((code, i) => [`village-${i + 1}`, code]);
  }

  farmerView() {
    const s = this.state;
    const lands = this.landEntries();
    const villages = this.villages().map(([ref, code]) => {
      const inVillage = lands.filter(([, land]) => String(land.villageLgdCode) === code);
      return {
        village_ref: ref,
        name: inVillage[0][1].villageName ?? "",
        plots: inVillage.map(([landRef, land]) => ({
          land_ref: landRef,
          survey: String(land.surveyNumber ?? ""),
          sub_survey: String(land.subSurveyNumber ?? ""),
          area_ha: land.landAreaHectares ?? null,
        })),
      };
    });
    const supported = new Set((s.crops as any[]).map((row) => row.cropCode));
    return ffsResult(
      villages.length ? "ok" : "no_lands",
      villages.length
        ? "Explain that this booking flow supports one village at a time. Ask only for missing village and crops"
        : "Explain that FFS returned no land records",
      {
        farmer_name: s.user.userFullName ?? null,
        villages,
        village_scope: clone(s.village_scope ?? { mode: "single_village" }),
        common_crops: Object.keys(FFS_COMMON_CROPS)
          .filter((code) => supported.has(code))
          .map((code) => ({ crop_name: FFS_COMMON_CROPS[code], crop_code: code })),
      }
    );
  }

  // ── entitlement ─────────────────────────────────────────────────────────────────

  async entitlement(args: any) {
    this.ready();
    const s = this.state;
    const lands = this.landMap();
    const villageRef: string = args.village_ref;
    const village = this.villages().find(([ref]) => ref === villageRef)?.[1];
    const villageLands = new Set(
      Object.keys(lands).filter((ref) => village !== undefined && String(lands[ref].villageLgdCode) === village)
    );
    if (!village || !villageLands.size) return ffsResult("needs_clarification", "Choose a returned village with land records");

    let selections = cropSelections(args.crop_selections);
    let cropName: string | null = args.crop_name ?? null;
    let cropCode: string | null = args.crop_code ?? null;
    const selectedPlotsOnly = args.selected_plots_only === true;
    if (selections && (cropName !== null || cropCode !== null)) {
      const consistent = selections.every(
        (item) =>
          (cropCode !== null && item.crop_code === cropCode) ||
          (item.crop_name === cropName && (cropCode === null || item.crop_code === null || item.crop_code === cropCode))
      );
      if (!consistent) {
        return ffsResult(
          "needs_clarification",
          "The village crop and per-plot mappings conflict. Supply the farmer's intended per-plot mappings"
        );
      }
      selections = selections.map((item) => ({ ...item, crop_code: item.crop_code || cropCode }));
      cropName = cropCode = null;
    }
    if (cropName !== null) {
      if (selections || selectedPlotsOnly || !cropName.trim()) {
        return ffsResult(
          "needs_clarification",
          "For one crop on the whole village, supply crop_name and optional crop_code only; for fewer plots use crop_selections and selected_plots_only=true"
        );
      }
      selections = Object.keys(lands)
        .filter((ref) => villageLands.has(ref))
        .map((ref) => ({ land_ref: ref, crop_name: cropName as string, crop_code: cropCode }));
    } else if (cropCode !== null) {
      return ffsResult("needs_clarification", "Supply the farmer's crop wording with the common crop code");
    }
    if (!selections || !selections.length || new Set(selections.map((x) => x.land_ref)).size !== selections.length) {
      return ffsResult("needs_clarification", "Supply one crop for the village or one crop mapping per selected plot");
    }
    const requested = new Set(selections.map((x) => x.land_ref));
    if (!Array.from(requested).every((ref) => villageLands.has(ref))) {
      return ffsResult(
        "needs_clarification",
        "This booking flow supports one village at a time. Explain this and ask which village to use; do not call separately and add allowances. A new village selection replaces the previous one. No selection was changed",
        { village_scope: clone(s.village_scope ?? { mode: "single_village" }) }
      );
    }
    if (!selectedPlotsOnly && requested.size !== villageLands.size) {
      const missingPlots = Object.keys(lands)
        .filter((ref) => villageLands.has(ref) && !requested.has(ref))
        .map((ref) => ({ land_ref: ref, survey: String(lands[ref].surveyNumber ?? "") }));
      return ffsResult(
        "needs_clarification",
        "Collect the missing crop mappings. Use selected_plots_only=true only if the farmer explicitly requested fewer plots",
        { missing_plots: missingPlots }
      );
    }
    const codes = new Map<string, string>((s.crops as any[]).map((row) => [row.cropCode, row.cropName]));
    for (const item of selections) {
      const area = lands[item.land_ref].landAreaHectares;
      if (!finite(area) || area <= 0) {
        return ffsResult("unavailable", "FFS returned an invalid plot area; do not save crops or estimate quantities");
      }
      if (item.crop_code !== null && (!(item.crop_code in FFS_COMMON_CROPS) || !codes.has(item.crop_code))) {
        return ffsResult(
          "needs_clarification",
          "Use a code from common_crops, or omit crop_code to resolve the farmer's crop wording"
        );
      }
    }
    const supplied = selections.filter((item) => item.crop_code !== null).length;
    if (supplied) this.note("common_crop_codes_used", { plots: supplied });
    const names = unique(selections.filter((item) => item.crop_code === null).map((item) => item.crop_name));
    const resolved: Record<string, string> = (s.resolved_crops ??= {});
    for (const name of unique(selections.filter((item) => item.crop_code !== null).map((item) => item.crop_name))) {
      const suppliedCodes = unique(
        selections.filter((item) => item.crop_name === name && item.crop_code !== null).map((item) => item.crop_code as string)
      );
      if (suppliedCodes.length === 1) resolved[name] = suppliedCodes[0];
      else delete resolved[name];
    }
    const missing = names.filter((name) => !codes.has(resolved[name]));
    if (missing.length) {
      const matches = this.resolutionFor(missing, args.resolution);
      if (!matches) {
        return ffsResult("needs_resolution", "Match the crop names against the catalogue and repeat this call with resolution", {
          kind: "crops",
          names: missing,
          catalogue: clone(s.crops),
          state_code: s.state_code,
        });
      }
      const unresolved: any[] = [];
      for (const name of missing) {
        const match = matches[name];
        const candidates: string[] = Array.isArray(match?.candidates) ? match.candidates : [];
        if (match?.status === "matched" && codes.has(match.crop_code)) {
          resolved[name] = match.crop_code;
        } else if (match?.status === "matched" || !candidates.every((code) => codes.has(code))) {
          return ffsResult("unavailable", "Crop resolution failed; no crops were saved. Retry without restarting OTP login");
        } else {
          unresolved.push({
            crop_name: name,
            status: match?.status === "ambiguous" ? "ambiguous" : "not_found",
            candidates: candidates.map((code) => ({ crop_code: code, crop_name: codes.get(code) })),
          });
        }
      }
      await this.save();
      if (unresolved.length) {
        return ffsResult(
          "needs_clarification",
          "Ask the farmer which intended crop they mean using these candidates; do not default to maize",
          { crops: unresolved }
        );
      }
    } else if (names.length) {
      this.note("crop_resolution_reused", { count: names.length });
    }
    const selected = selections.map((item) => ({
      land_ref: item.land_ref,
      crop_code: item.crop_code || resolved[item.crop_name],
    }));
    const signature = JSON.stringify([villageRef, selected]);
    if (s.selection_signature === signature && "entitlement" in s) {
      this.note("entitlement_reused");
      return clone(s.entitlement);
    }
    const previousScope = s.village_scope ?? {};
    const scope: any = {
      mode: "single_village",
      village_ref: villageRef,
      village_name: lands[selected[0].land_ref].villageName ?? "",
    };
    if (previousScope.village_ref && previousScope.village_ref !== villageRef) {
      scope.replaces_village = pick(previousScope, ["village_ref", "village_name"]);
    }
    for (const key of [
      "entitlement", "shops", "selected_shop", "products", "gfr", "quota", "pending_booking",
      "booking_limits", "booking_tool_exchanges", "order", "product_catalog_groups",
      "resolved_products", "product_candidates", "prior_order",
    ]) {
      delete s[key];
    }
    s.village_scope = scope;
    s.selection_signature = signature;
    s.selection = selected;
    s.stage = "mapping_crops";
    await this.save();
    const seasonId = s.season.season.seasonId;
    const yearId = s.season.year.yearId;
    const applicantBody = () => ({
      stateCode: Number(s.state_code),
      aadhaarHash: s.user.userAadhaarHash,
      seasonId,
      yearId,
    });
    if (s.uncertain_plot) {
      this.note("crop_mapping_reconciliation");
      const fresh = await this.call("POST", APPROVAL, APPLICANT_FETCH, applicantBody());
      if (!isRecord(fresh) || !Array.isArray(fresh.landData)) {
        throw new FfsError("partial_crop_update", "Land refresh failed; crop update outcome remains unknown");
      }
      const current = new Map<string, any>(fresh.landData.map((l: any) => [String(l.farmlandPlotRegistryId), l]));
      for (const item of selected) {
        const land = lands[item.land_ref];
        const key = String(land.farmlandPlotRegistryId);
        if (!current.has(key)) {
          throw new FfsError(
            "partial_crop_update",
            "A selected plot is no longer returned by FFS. Explain this and ask which returned plots the farmer wants"
          );
        }
        land.crops = current.get(key).crops ?? [];
      }
      delete s.uncertain_plot;
      await this.save();
    }
    for (const item of selected) {
      const land = lands[item.land_ref];
      if (
        (land.crops ?? []).some(
          (c: any) => c.cropCode === item.crop_code && c.seasonId === seasonId && c.yearId === yearId
        )
      ) {
        this.note("crop_mapping_reused", { land_ref: item.land_ref });
        continue;
      }
      this.note("crop_mapping_write", {
        land_ref: item.land_ref,
        crop_code: /^[0-9]{1,12}$/.test(item.crop_code) ? item.crop_code : "invalid",
      });
      s.uncertain_plot = item.land_ref;
      await this.save();
      const data = await this.call("POST", APPROVAL, "/applicant/land/crop/add", {
        applicantUserId: s.user.userId,
        farmlandPlotRegistryId: land.farmlandPlotRegistryId,
        farmlandOwnershipRegistryId: land.farmlandOwnershipId,
        cropCode: item.crop_code,
        seasonId,
        yearId,
        stateLgdCode: Number(s.state_code),
      });
      if (!isRecord(data) || data.cropCode !== item.crop_code || data.farmlandPlotRegistryId !== land.farmlandPlotRegistryId) {
        throw new FfsError("partial_crop_update", "FFS crop result did not match this plot; refetch before retrying");
      }
      this.note("crop_mapping_saved", { land_ref: item.land_ref });
      land.crops = [data];
      delete s.uncertain_plot;
      await this.save();
    }
    const recommendations = await this.call("POST", FERT, "/fertilizerRecommendation/getRecommendationsByGFRV4", {
      lands: selected.map((x) => ({
        farmlandPlotRegistryId: lands[x.land_ref].farmlandPlotRegistryId,
        areaHa: lands[x.land_ref].landAreaHectares,
        cropCode: x.crop_code,
        stateLgdCode: Number(s.state_code),
        districtLgdCode: lands[x.land_ref].districtLgdCode,
      })),
      isProceedWithGfr: true,
    });
    if (!Array.isArray(recommendations) || recommendations.length !== 1 || !isRecord(recommendations[0])) {
      throw new FfsError("unavailable", "FFS returned unsupported GFR alternatives; do not combine them");
    }
    const gfr = recommendations[0];
    const groups: any[] = [];
    for (const r of gfr.recommendations ?? []) {
      if (!(r.productGroupId in PRODUCTS)) continue;
      const bags = r.offeredBags;
      if (!isInt(bags) || bags < 0) {
        throw new FfsError(
          "unavailable",
          "FFS did not return usable offeredBags; do not infer an allowance from required bags or weight"
        );
      }
      this.note("entitlement_quantity", { group: r.productGroupId, bags, quantity_field: "offeredBags" });
      groups.push({ group: r.productGroupId, name: r.productGroupId === 11 ? "urea" : "DAP", bags, kg_per_bag: r.kgPerBag });
    }
    if (new Set(groups.map((g) => g.group)).size !== groups.length) {
      throw new FfsError("unavailable", "FFS did not return supported fertilizer groups");
    }
    s.gfr = gfr;
    s.stage = "entitlement_ready";
    const anyOffered = (gfr.recommendations ?? []).some((r: any) => isInt(r.offeredBags) && r.offeredBags > 0);
    s.entitlement = ffsResult(
      anyOffered ? "ok" : "zero_entitlement",
      "Name the selected village and explain that this allowance covers only the returned plots in that village. If replaces_village is present, explain that this selection replaces the previous village, not adds to it. Never add allowances from separate calls. Report bags exactly as the FFS offered allowance; do not subtract purchases or recalculate it. Collect the requested eligible products and bag counts, reusing earlier requests; never default to entitlement. Confirm the order before shop search. If it exceeds GFR, explain the returned limit and ask for a smaller choice",
      {
        village_scope: clone(scope),
        products: groups,
        plots: selected.map((x) => x.land_ref),
        crops: selected.map((x) => ({
          land_ref: x.land_ref,
          crop: (s.crops as any[]).find((c) => c.cropCode === x.crop_code)?.cropName,
        })),
      }
    );
    await this.save();
    return clone(s.entitlement);
  }

  /** Index the API's LLM matches by phrase; undefined when the API has not resolved yet. */
  private resolutionFor(names: string[], resolution: any): Record<string, any> | undefined {
    if (!Array.isArray(resolution)) return undefined;
    const byName: Record<string, any> = {};
    for (const match of resolution) if (isRecord(match) && typeof match.name === "string") byName[match.name] = match;
    return names.every((name) => name in byName) ? byName : undefined;
  }

  // ── order and shops ─────────────────────────────────────────────────────────────

  private async loadProducts(groups: Set<number>, geo: any) {
    const wanted = Array.from(new Set([...Array.from(groups), ...(this.state.product_catalog_groups ?? [])])).sort(
      (a, b) => a - b
    );
    if (JSON.stringify(wanted) === JSON.stringify(this.state.product_catalog_groups)) return;
    const data = await this.call("POST", MASTER, "/product/getProductsByAvailability", {
      ...geo,
      productGroupIds: wanted.join(","),
    });
    if (!Array.isArray(data) || !data.every(isRecord)) {
      throw new FfsError("unavailable", "FFS returned an invalid product catalogue");
    }
    this.state.products = data;
    this.state.product_catalog_groups = wanted;
    await this.save();
  }

  private async setOrder(order: { product: string; product_id: number | null; bags: number }[], geo: any, resolution: any) {
    const s = this.state;
    // Invalidate the old order immediately: an incomplete correction must not leave a
    // previously valid order available to the booking tool. The old order is parked in
    // prior_order only while the API resolves product names, so an unchanged order can
    // still reuse its shop search afterwards.
    const parked = s.prior_order;
    delete s.prior_order;
    const previous = parked ? parked.order : s.order;
    const previousSearch = parked ? parked.shops : s.shops;
    delete s.order;
    delete s.shops;
    await this.save();
    if (!order.length) {
      return ffsResult(
        "needs_order",
        "Ask which products and how many bags the farmer wants; never use eligibility as the order"
      );
    }
    const commonGroups: Record<number, number> = {};
    for (const group of Object.keys(PRODUCTS)) commonGroups[PRODUCTS[Number(group)]] = Number(group);
    // Discovery also needs urea/DAP metadata for the agreed shop ranking.
    // Loading those products does not add them to the farmer's order.
    const groups = new Set<number>(Object.keys(PRODUCTS).map(Number));
    if (order.some((item) => item.product_id === null || !(item.product_id in commonGroups))) {
      for (const r of s.gfr.recommendations) groups.add(r.productGroupId);
    }
    await this.loadProducts(groups, geo);
    const catalogue: any[] = (s.products as any[]).filter(
      (p) =>
        isInt(p.productId) &&
        isInt(p.productGroupId) &&
        p.productName &&
        finite(p.bagWeightKg) &&
        p.bagWeightKg > 0
    );
    const ids = new Set(catalogue.map((p) => p.productId));
    const allowedIds = new Set<number>([
      ...Object.keys(commonGroups).map(Number),
      ...(s.product_candidates ?? []),
      ...Object.keys(s.resolved_products ?? {}).map((k) => s.resolved_products[k]),
    ]);
    if (order.some((item) => item.product_id !== null && !allowedIds.has(item.product_id))) {
      return ffsResult(
        "needs_clarification",
        "Use 1089/1005 for generic urea/DAP, a returned candidate ID, or omit the ID to resolve the farmer's named product"
      );
    }
    const resolved: Record<string, number> = (s.resolved_products ??= {});
    const missing = unique(
      order.filter((item) => item.product_id === null && !ids.has(resolved[item.product])).map((item) => item.product)
    );
    if (missing.length) {
      const matches = this.resolutionFor(missing, resolution);
      if (!matches) {
        s.prior_order = { order: previous, shops: previousSearch };
        await this.save();
        return ffsResult(
          "needs_resolution",
          "Match the fertilizer names against the catalogue and repeat this call with resolution",
          { kind: "products", names: missing, catalogue: clone(catalogue) }
        );
      }
      const unresolved: any[] = [];
      for (const name of missing) {
        const match = matches[name];
        const candidates: number[] = Array.isArray(match?.candidates) ? match.candidates : [];
        if (match?.status === "matched" && ids.has(match.product_id)) {
          resolved[name] = match.product_id;
        } else if (match?.status === "matched" || !candidates.every((id) => ids.has(id))) {
          return ffsResult(
            "unavailable",
            "Product matching failed; retry without restarting login. No order or booking was submitted"
          );
        } else {
          s.product_candidates = Array.from(new Set([...(s.product_candidates ?? []), ...candidates])).sort((a: number, b: number) => a - b);
          unresolved.push({
            product: name,
            status: match?.status === "ambiguous" ? "ambiguous" : "not_found",
            candidates: catalogue
              .filter((p) => candidates.includes(p.productId))
              .map((p) => ({ product_id: p.productId, name: p.productName, group: p.productGroupId, kg_per_bag: p.bagWeightKg })),
          });
        }
      }
      await this.save();
      if (unresolved.length) {
        return ffsResult(
          "needs_clarification",
          "Clarify ambiguous products using the candidates. If not found, explain that FFS did not return a match for this location and eligible groups. Never substitute a named variant",
          { products: unresolved }
        );
      }
    }
    const chosen: any[] = [];
    for (const item of order) {
      const pid = item.product_id !== null ? item.product_id : resolved[item.product];
      const rows = catalogue.filter((p) => p.productId === pid);
      if (!rows.length) {
        const group = commonGroups[pid];
        const alternatives = catalogue
          .filter((p) => p.productGroupId === group)
          .map((p) => ({ product_id: p.productId, name: p.productName, kg_per_bag: p.bagWeightKg }));
        s.product_candidates = Array.from(new Set([...(s.product_candidates ?? []), ...alternatives.map((p) => p.product_id)])).sort(
          (a: number, b: number) => a - b
        );
        await this.save();
        return ffsResult(
          "product_unavailable",
          "FFS did not return the requested product locally. Offer named alternatives only with the farmer's choice; never substitute",
          { product: item.product, alternatives }
        );
      }
      const product = rows[0];
      const mappings = new Set(rows.map((p) => JSON.stringify([p.plantId ?? null, p.productGroupId, p.bagWeightKg])));
      if (mappings.size !== 1 || !isInt(product.plantId) || product.plantId <= 0) {
        return ffsResult("unavailable", "FFS returned missing or ambiguous product/plant mappings; do not invent a plant ID");
      }
      chosen.push({
        product_id: pid,
        name: product.productName,
        group: product.productGroupId,
        bags: item.bags,
        kg_per_bag: product.bagWeightKg,
        plant_id: product.plantId,
      });
    }
    if (new Set(chosen.map((p) => p.product_id)).size !== chosen.length) {
      return ffsResult("needs_order", "Specify each requested product once with its total requested bags");
    }
    const error = this.checkOrderAllowance(chosen);
    if (error) return error;
    chosen.sort((a, b) => a.product_id - b.product_id);
    if (JSON.stringify(chosen) === JSON.stringify(previous) && previousSearch !== undefined) s.shops = previousSearch;
    s.order = chosen;
    s.order_turn = this.questionId;
    await this.save();
    return null;
  }

  private checkOrderAllowance(order: any[]) {
    const recommendations: any[] = this.state.gfr.recommendations;
    for (const group of unique(order.map((p) => p.group))) {
      const rows = recommendations.filter((r) => r.productGroupId === group);
      if (!rows.length) {
        return ffsResult("not_eligible", "FFS returned no allowance for this product group; ask for a different eligible product", { group });
      }
      if (rows.length !== 1 || !isInt(rows[0].offeredBags) || rows[0].offeredBags < 0) {
        return ffsResult("unavailable", "FFS did not return an unambiguous offeredBags allowance for this group");
      }
      const allowed = rows[0].offeredBags;
      const requestedBags = order.filter((p) => p.group === group).reduce((sum, p) => sum + p.bags, 0);
      if (requestedBags > allowed) {
        return ffsResult(
          "needs_order",
          "We need to follow the GFR recommendation; explain the returned allowed bags and ask for a lower number. Never change the farmer's quantity yourself",
          { group, allowed_bags: allowed, requested_bags: requestedBags }
        );
      }
    }
    return null;
  }

  async find_shops(args: any) {
    this.ready();
    const s = this.state;
    if (!s.entitlement) throw new FfsError("needs_entitlement", "Collect village/crops and call ffs_get_entitlement first");
    let action: string = args.action ?? "initial";
    const order = orderItems(args.order);
    const first = this.landMap()[s.selection[0].land_ref];
    const geo = pick(first, ["stateLgdCode", "districtLgdCode", "subDistrictLgdCode", "villageLgdCode"]);
    if (args.shop_ref !== undefined && args.shop_ref !== null) {
      const shop = this.findShop(args.shop_ref);
      if (!shop) return ffsResult("needs_shops", "Use the chosen shop's returned shop_ref, never its display number");
      s.selected_shop = clone(shop);
    }
    if (order) {
      const previousOrder = s.prior_order ? s.prior_order.order : clone(s.order);
      const error = await this.setOrder(order, geo, args.resolution);
      if (error) return error;
      if (JSON.stringify(s.order) !== JSON.stringify(previousOrder)) action = "initial";
    }
    if (!s.order) {
      return ffsResult("needs_order", "Ask for the products and bag counts the farmer wants; never default to entitlement");
    }
    const selected = s.selected_shop;
    if (order && action === "initial" && selected) {
      const answer = ffsResult(
        "ok",
        "Order updated; keep the chosen shop. Submit the farmer's agreed correction using this shop_ref. FFS checks current stock at booking; never silently switch retailer",
        { selected_shop: this.shopView(selected) }
      );
      s.stage = "shops_ready";
      await this.save();
      return answer;
    }
    // This is an availability probe, not a proposed booking. Asking for one bag keeps
    // smaller-stock shops discoverable. Include common products for ranking, but count
    // shops against the separately stored order below.
    const discovery = new Map<number, any>();
    const probe = (productId: number, group: number, kg: number) =>
      discovery.set(productId, { productGroupId: group, productId, quantityOfBagKg: kg, noBagsRequested: 1 });
    for (const p of s.products ?? []) {
      if ((p.productId === 1089 || p.productId === 1005) && finite(p.bagWeightKg) && p.bagWeightKg > 0) {
        probe(p.productId, p.productGroupId, p.bagWeightKg);
      }
    }
    for (const p of s.order) probe(p.product_id, p.group, p.kg_per_bag);
    const chosen = Array.from(discovery.values());
    const search = (s.shops ??= { level: 0, page: 1, pool: {}, shown: [], complete_levels: [], turn_results: {} });
    const turnKey = this.questionId + ":" + action;
    if (turnKey in search.turn_results) return clone(search.turn_results[turnKey]);
    if (action === "initial" && search.shown.length) return clone(search.last_result);
    if (action === "widen") {
      if (search.level >= LEVELS.length - 1) return ffsResult("no_more_shops", "The search is already at state level");
      search.level += 1;
      search.page = 1;
      search.minimum_level = search.level;
    }
    await this.collectShopPages(search, geo, chosen);
    const answer = this.shopResult(search);
    search.last_result = answer;
    search.turn_results[turnKey] = answer;
    s.stage = "shops_ready";
    await this.save();
    return clone(answer);
  }

  private pendingShops(search: any): any[] {
    return (Object.keys(search.pool).map((k) => search.pool[k]) as any[]).filter(
      (shop) =>
        !search.shown.includes(shop.shop_ref) &&
        shop.coverage.length &&
        shop.rank[0] >= (search.minimum_level ?? 0)
    );
  }

  private async collectShopPages(search: any, geo: any, chosen: any[]) {
    // Count distinct shops carrying an ordered product, not raw retailer rows. Keep
    // paging this territory before widening, stopping as soon as we have three
    // choices. The run timeout bounds calls; every page saves its cursor.
    while (this.pendingShops(search).length < 3) {
      while (search.complete_levels.includes(LEVELS[search.level]) && search.level < LEVELS.length - 1) {
        search.level += 1;
        search.page = 1;
      }
      if (search.complete_levels.includes(LEVELS[search.level])) break;
      this.note("shop_page_requested", { territory: LEVELS[search.level], page: search.page });
      const data = await this.call("POST", MASTER, "/retailer/getRetailersByProductAvailabilityV4", {
        ...geo,
        selectedProducts: chosen,
        territoryLevel: LEVELS[search.level],
        farmerLatitude: null,
        farmerLongitude: null,
        pageNo: search.page,
        pageSize: 3,
      });
      const pages = this.lastEnvelope?.totalPages;
      if (!Array.isArray(data) || !isInt(pages) || pages < 0) {
        throw new FfsError("unavailable", "FFS returned invalid retailer pagination");
      }
      for (const row of data) this.addRetailer(search, row);
      search.page += 1;
      if (search.page > pages) search.complete_levels.push(LEVELS[search.level]);
      await this.save();
    }
  }

  private addRetailer(search: any, row: any) {
    if (!isRecord(row) || !isInt(row.retailerId)) throw new FfsError("unavailable", "FFS returned an invalid retailer");
    const rid = String(row.retailerId);
    if (rid in search.pool) return;
    const stocks = new Map<number, number>();
    const groupsWithStock = new Set<number>();
    const knownGroups = new Map<number, number>();
    for (const p of this.state.products ?? []) knownGroups.set(p.productId, p.productGroupId);
    for (const group of Object.keys(PRODUCTS)) knownGroups.set(PRODUCTS[Number(group)], Number(group));
    for (const group of Array.isArray(row.availableProducts) ? row.availableProducts : []) {
      for (const product of Array.isArray(group?.products) ? group.products : []) {
        const stock = product?.noBagsAvailable;
        if (finite(stock) && stock >= 0) {
          stocks.set(product.productId, stock);
          if (stock > 0) groupsWithStock.add(group.productGroupId ?? knownGroups.get(product.productId));
        }
      }
    }
    const order: any[] = this.state.order;
    const complete = order.every((p) => (stocks.get(p.product_id) ?? -1) >= p.bags);
    const unknown = order.some((p) => !stocks.has(p.product_id));
    const supply = complete ? "full" : unknown ? "unknown" : "partial";
    // Within a supply class: both urea/DAP, then urea, then DAP, then other shops;
    // descending reported volumes within each bucket.
    const bucket = groupsWithStock.has(11) && groupsWithStock.has(12) ? 0 : groupsWithStock.has(11) ? 1 : groupsWithStock.has(12) ? 2 : 3;
    let total = 0;
    const stock: Record<string, number> = {};
    stocks.forEach((value, key) => {
      total += value;
      stock[String(key)] = value;
    });
    search.pool[rid] = {
      shop_ref: "retailer-" + rid,
      name: row.retailerName ?? "",
      territory: LEVELS[search.level],
      coverage: order.filter((p) => (stocks.get(p.product_id) ?? 0) > 0).map((p) => ({ product_id: p.product_id, name: p.name })),
      supply,
      retailer_id: row.retailerId,
      stock,
      rank: [search.level, bucket, -total, row.retailerId],
    };
    const selected = this.state.selected_shop;
    if (selected && selected.retailer_id === row.retailerId) {
      search.pool[rid].shop_ref = selected.shop_ref;
      this.state.selected_shop = clone(search.pool[rid]);
    }
  }

  // This is the selected retailer's identity, not a fresh availability check.
  private shopView(shop: any) {
    return clone(pick(shop, ["shop_ref", "name", "territory"]));
  }

  private findShop(shopRef: string) {
    const selected = this.state.selected_shop;
    if (selected && selected.shop_ref === shopRef) return selected;
    const pool = this.state.shops?.pool ?? {};
    return Object.keys(pool)
      .map((k) => pool[k])
      .find((shop) => shop.shop_ref === shopRef);
  }

  private shopResult(search: any) {
    // Apply full-order supply before product buckets. Territory remains first; do not
    // renumber shops already shown.
    const batch = this.pendingShops(search)
      .sort((a, b) => {
        const ka = [a.rank[0], a.supply !== "full" ? 1 : 0, a.rank[1], a.rank[2], a.rank[3]];
        const kb = [b.rank[0], b.supply !== "full" ? 1 : 0, b.rank[1], b.rank[2], b.rank[3]];
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
        return 0;
      })
      .slice(0, 3);
    for (const shop of batch) search.shown.push(shop.shop_ref);
    const exhausted = search.complete_levels.includes(LEVELS[LEVELS.length - 1]);
    const shops = batch.map((shop, i) => ({
      number: i + 1,
      ...pick(shop, ["shop_ref", "name", "territory", "coverage", "supply"]),
    }));
    return ffsResult(
      batch.length ? "ok" : exhausted ? "no_more_shops" : "search_incomplete",
      "Present these numbered shops with their territory and ordered product availability. Explain partial or unknown supply without stock volumes. Never change the order. Offer more only when has_more is true",
      { shops, has_more: this.pendingShops(search).length > 0 || !exhausted }
    );
  }

  // ── booking ─────────────────────────────────────────────────────────────────────

  async create_booking(args: any) {
    const s = this.state;
    this.ready();
    if (!s.order) {
      return ffsResult("needs_order", "Ask for products and bags, then pass the farmer's order to ffs_find_shops before booking");
    }
    const shop = this.findShop(args.shop_ref);
    if (!shop) return ffsResult("needs_shops", "Search for the stored order and ask the farmer to choose a returned shop");
    s.selected_shop = clone(shop);
    await this.save();
    const confirmed = args.confirmed === true;
    this.note("booking_consent", { confirmed });
    if (!confirmed) {
      this.note("booking_confirmation_requested");
      return ffsResult(
        "needs_confirmation",
        "Ask once whether to book these products and quantities at this shop. If the farmer has already confirmed, call with confirmed=true now; no token or extra turn is required",
        {
          summary: {
            shop_ref: args.shop_ref,
            shop_name: shop.name ?? "",
            products: s.order.map((p: any) => pick(p, ["name", "bags", "kg_per_bag"])),
          },
          booking_enabled: true,
        }
      );
    }
    return this.submitBooking(shop, s.order, this.bookingLands());
  }

  private bookingLands() {
    const lands = this.landMap();
    const selectedLands = (this.state.selection ?? []).map((item: any) => {
      const land = lands[item.land_ref];
      if (!land) throw new FfsError("unavailable", "Selected plot details are missing; refresh entitlement");
      return {
        land_ref: item.land_ref,
        survey: String(land.surveyNumber ?? ""),
        farmLandPlotRegistryId: String(land.farmlandPlotRegistryId),
        farmLandOwnershipId: String(land.farmlandOwnershipId),
        cropCode: item.crop_code,
      };
    });
    if (!selectedLands.length) throw new FfsError("needs_entitlement", "Select plots and get entitlement before booking");
    return selectedLands;
  }

  private async submitBooking(shop: any, chosen: any[], selectedLands: any[]) {
    const s = this.state;
    const mobile = s.user.userMobileNumber;
    const now = istNow();
    const lines = chosen.map((x) => ({
      productId: x.product_id,
      plantId: Number(x.plant_id),
      productGroupId: x.group,
      noBagsRequested: x.bags,
      quantityOfBagKg: x.kg_per_bag,
      isLooseBuy: false,
      totalQuantityKgRequested: x.bags * x.kg_per_bag,
    }));
    const first = this.landMap()[s.selection[0].land_ref];
    const payload = {
      seasonId: s.season.season.seasonId,
      year: now.year,
      month: now.month,
      requestedDatetime: now.stamp,
      applicantUserId: s.user.userId,
      contactNoForCommunication: mobile,
      isReceiverApplicantSame: true,
      receiverUserId: s.user.userId,
      receiverName: s.user.userFullName,
      receiverMobileNo: mobile,
      receiverAadharHash: s.user.userAadhaarHash,
      stateLgdCode: Number(s.state_code),
      ...pick(first, ["districtLgdCode", "subDistrictLgdCode", "villageLgdCode"]),
      selectedLandIds: selectedLands.map((x) => pick(x, ["farmLandOwnershipId", "cropCode", "farmLandPlotRegistryId"])),
      bookingRequest: [{ retailerId: shop.retailer_id, productLines: lines }],
      GFRRecommendation: s.gfr.recommendations,
      gfrType: s.gfr.gfrType,
      isProceedWithGfr: true,
    };
    this.note("booking_submitted", { products_count: lines.length, plots_count: selectedLands.length });
    this.diagnostics.booking_dispatched = true;
    const envelope = await this.call("POST", FERT, "/bharatVistar/createMultipleBookingV2", payload);
    return this.finishBooking(envelope, shop);
  }

  async finishBooking(envelope: any, shop: any) {
    const status = this.lastHttpStatus;
    const feedback: any = { http_status: status };
    if (isRecord(envelope)) Object.assign(feedback, clone(pick(envelope, ["code", "status", "message", "data"])));
    const uncertain = (reason: string) =>
      new FfsError(
        "booking_uncertain",
        reason +
          ". The same farmer-approved request may be retried; FFS rejects existing or parallel bookings. Do not claim success without a conclusive response",
        feedback
      );
    if (!isRecord(envelope)) throw uncertain("FFS returned an unreadable booking response");
    const data = envelope.data;
    const failed = envelope.status === "FAILED";
    // Confirmed provider contract: FAILED with explicit null data means no write,
    // including code/HTTP 500. Never infer this from English wording.
    let rejected = failed && "data" in envelope && data === null;
    let row: any = null;
    let success = false;
    if (isRecord(data)) {
      const rows = data.bookingResults ?? [];
      if (!Array.isArray(rows) || rows.length > 1 || rows.some((r) => !isRecord(r) || r.retailerId !== shop.retailer_id)) {
        throw uncertain("FFS booking result did not match the selected retailer");
      }
      row = rows[0] ?? null;
      success = data.isValid === true && row !== null && row.isValid === true;
      rejected = data.isValid === false && isInt(data.totalBookingsSuccessful) && data.totalBookingsSuccessful === 0;
      if (
        rejected &&
        rows.some((r) => r.isValid !== false || r.procurementId || r.procurementApplicationCode || r.isWaitlisted === true)
      ) {
        throw uncertain("FFS rejection contradicts its booking results");
      }
      if (rejected && (data.procurementId || data.procurementApplicationCode)) {
        throw uncertain("FFS rejection also contains a booking reference");
      }
      if (rejected && ((data.totalBookingsFailed ?? 1) !== 1 || (data.totalBookingsRequested ?? 1) !== 1)) {
        throw uncertain("FFS rejection contains contradictory booking counts");
      }
      if (
        success &&
        (failed ||
          !(status >= 200 && status < 300) ||
          envelope.code !== 200 ||
          !row.procurementId ||
          !row.procurementApplicationCode ||
          typeof row.isWaitlisted !== "boolean" ||
          data.totalBookingsSuccessful !== 1 ||
          data.totalBookingsFailed !== 0)
      ) {
        throw uncertain("FFS success response is incomplete or inconsistent");
      }
    }
    if (!success && !rejected) throw uncertain("FFS did not establish whether the booking was created");
    // Even the null-data failure shape cannot contradict a top-level success.
    if (
      rejected &&
      (envelope.isValid === true ||
        (envelope.totalBookingsSuccessful ?? 0) ||
        envelope.procurementId ||
        envelope.procurementApplicationCode)
    ) {
      throw uncertain("FFS failure response also reports a booking");
    }
    const waitlisted = success && row.isWaitlisted === true;
    const pub = {
      is_valid: success,
      bookings: success
        ? [
            {
              procurement_id: row.procurementId ?? null,
              booking_code: row.procurementApplicationCode ?? null,
              is_waitlisted: waitlisted,
              expires_at: (waitlisted ? row.waitlistExpiresOn : row.expiryDatetime) ?? null,
              total_bags_requested: row.totalBagsRequested ?? null,
            },
          ]
        : [],
    };
    const s = this.state;
    s.stage = success ? "booking_done" : s.token ? "shops_ready" : "login_expired";
    const answer = ffsResult(
      success ? "ok" : "booking_failed",
      success
        ? "Share the booking reference and expiry; distinguish waitlisting from confirmed allocation. Mention SMS confirmation or a registered-mobile update for a waitlist. Close only with a neutral Can I help with anything else? in the farmer's language; do not offer another fertilizer, extra bags, another shop or another booking"
        : "FFS rejected this attempt; it did not create a new booking. Explain its message without shop stock volumes. If an existing booking prevents this attempt, explain that and stop; do not infer its products or reference. Ask for a correction only when the provider response supports changing the choice; use the farmer's instruction without another confirmation",
      {
        booking: pub,
        order: (s.order ?? []).map((p: any) => pick(p, ["product_id", "name", "bags", "kg_per_bag"])),
        booking_enabled: true,
        ...(rejected ? { provider_error: feedback } : {}),
      }
    );
    this.note("booking_outcome", { outcome: success ? "success" : "rejected" });
    await this.save();
    return clone(answer);
  }

  // ── chat-turn context ───────────────────────────────────────────────────────────

  /** Workflow summary the chat API adds to the model prompt; read-only. */
  context(): any {
    const state = this.state;
    if (!Object.keys(state).length) return {};
    const context: any = {
      stage: state.stage ?? "not_started",
      authenticated: !!(state.token && (state.token_expires ?? 0) > Date.now() / 1000),
      village_scope: clone(state.village_scope ?? { mode: "single_village" }),
    };
    if (["profile", "crops", "season"].every((k) => k in state)) {
      const farmer = this.farmerView().data;
      context.villages = farmer.villages;
      context.common_crops = farmer.common_crops;
      if (state.entitlement) context.entitlement = state.entitlement.data;
      if (state.shops?.last_result) context.last_shops = compactFfsResult(state.shops.last_result).data;
      if (state.order) {
        context.order = state.order.map((row: any) => pick(row, ["product_id", "name", "group", "bags", "kg_per_bag"]));
      }
      if (state.selected_shop) context.selected_shop = this.shopView(state.selected_shop);
    }
    return context;
  }

  // ── entry point ─────────────────────────────────────────────────────────────────

  async run(operation: string, args: any): Promise<any> {
    if (!this.config.baseUrl || !this.sessionId) {
      this.diagnostics.reason = "missing_configuration_or_session";
      return ffsResult("unavailable", "FFS is not configured or the conversation has no session ID");
    }
    this.deadline = Date.now() + RUN_TIMEOUT_MS;
    this.state = this.store.get(this.sessionId);
    if (operation === "context") return this.context();
    // Old local booking guards are no longer authoritative. FFS owns existing/parallel booking enforcement.
    for (const key of ["uncertain_booking", "last_booking_result", "booking_tool_exchanges", "pending_booking", "quota"]) {
      delete this.state[key];
    }
    this.diagnostics.stage_before = this.state.stage ?? "not_started";
    const handlers: Record<string, (args: any) => Promise<any>> = {
      send_otp: (a) => this.send_otp(a),
      verify_otp: (a) => this.verify_otp(a),
      entitlement: (a) => this.entitlement(a),
      find_shops: (a) => this.find_shops(a),
      create_booking: (a) => this.create_booking(a),
    };
    const handler = handlers[operation];
    if (!handler) return ffsResult("unavailable", "Unknown FFS operation");
    try {
      let answer: any;
      try {
        answer = await handler(args ?? {});
      } catch (error) {
        if (!(error instanceof FfsError) || !["find_shops", "create_booking"].includes(operation)) throw error;
        this.diagnostics.workflow_status = error.status;
        if (error.status === "needs_otp") {
          delete this.state.token;
          this.state.stage = "login_expired";
        }
        answer = ffsResult(error.status, error.nextAction, error.providerError ? { provider_error: error.providerError } : {});
      }
      if (["find_shops", "create_booking"].includes(operation)) answer = compactFfsResult(answer);
      return answer;
    } catch (error) {
      return this.failure(error);
    } finally {
      this.diagnostics.stage_after = this.state.stage ?? "not_started";
    }
  }

  private failure(error: any) {
    const loading = this.state.token && this.state.stage === "loading";
    if (error instanceof BadArgs) {
      return ffsResult("needs_clarification", "Fix the tool arguments: " + error.message);
    }
    if (error instanceof FfsError) {
      const detail = error.providerError ? { provider_error: error.providerError } : {};
      this.diagnostics.workflow_status = error.status;
      if (error.status === "needs_otp" && Object.keys(this.state).length) {
        delete this.state.token;
        this.state.stage = "login_expired";
        this.store.set(this.sessionId, this.state);
      }
      if (loading) {
        return ffsResult(
          "setup_incomplete",
          "Explain the FFS response. If retrying can help, call ffs_verify_otp without another OTP to resume setup",
          detail
        );
      }
      if (this.state.uncertain_plot) {
        const ref = this.state.uncertain_plot;
        const land = this.landMap()[ref] ?? {};
        return ffsResult(
          "partial_crop_update",
          "Crop mapping is incomplete. Explain the FFS response for the affected plot. Ask the farmer which plots to proceed with before changing the selection; do not silently exclude plots. No new OTP is needed",
          {
            affected_plot: { land_ref: ref, survey: String(land.surveyNumber ?? ""), sub_survey: String(land.subSurveyNumber ?? "") },
            ...detail,
          }
        );
      }
      return ffsResult(error.status, error.nextAction, detail);
    }
    this.diagnostics.error_type = error?.constructor?.name ?? "Error";
    if (this.diagnostics.booking_dispatched) {
      const transport = error instanceof FfsTransportError;
      return ffsResult(
        "booking_uncertain",
        transport
          ? "Could not confirm this booking response. The same farmer-approved request may be retried; FFS rejects existing or parallel bookings. Do not claim that nothing was booked"
          : "Could not retain or interpret this booking outcome. The same farmer-approved request may be retried; FFS rejects existing or parallel bookings. Do not claim that nothing was booked"
      );
    }
    if (error instanceof FfsTransportError) {
      const status = this.state.uncertain_plot ? "partial_crop_update" : loading ? "setup_incomplete" : "unavailable";
      return ffsResult(status, "FFS did not complete the request. Resume setup/crop reconciliation without resending OTP or blindly repeating writes");
    }
    return ffsResult("unavailable", "FFS state or response is unavailable; no booking was attempted");
  }
}
