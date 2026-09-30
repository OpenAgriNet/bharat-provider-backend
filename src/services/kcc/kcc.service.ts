import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import * as crypto from "crypto";
import { LoggerService } from "../logger/logger.service";

export interface KccOtpSent {
  /** Pairs the OTP with the application status call; never shown to the farmer. */
  requestId: string;
  message: string;
  expiresIn: string;
}

export interface KccStatusHistoryEntry {
  createdAt: string;
  applicationStatus: string;
}

export interface KccCropDetail {
  cropName: string;
  season: string;
  surveyNumber: string;
  subDivisionNumber: string;
  landArea: number | null;
  cropStateName: string;
  cropDistrictName: string;
  cropVillageName: string;
}

export interface KccAnimalDetail {
  activityName: string;
  unitCount: number | null;
  animalStateName: string;
  animalDistrictName: string;
  animalVillageName: string;
}

export interface KccApplicationStatus {
  farmerName: string;
  applicationNo: string;
  applicationCurrentStatus: string;
  requiredLoanAmount: number | null;
  sanctionedAmount: number | null;
  updatedAt: string;
  bankName: string | null;
  branchName: string | null;
  rejectionReason: string | null;
  rejectedBy: string | null;
  applicationCreatedBy: string | null;
  remark: string | null;
  applicationStatusHistory: KccStatusHistoryEntry[];
  cropHusbandryDetails: KccCropDetail[];
  animalHusbandryDetails: KccAnimalDetail[];
}

/**
 * A KCC (Kisan Rin / Krishika) failure. `message` is the upstream `error` text, passed
 * through untouched — as with AIF, PMFBY and PM Kisan, it is what the farmer is shown.
 */
export class KccError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KccError";
  }
}

@Injectable()
export class KccService {
  private cachedToken?: { value: string; expiresAt: number };

  /** A generated token is dropped this many ms before its TTL, so it cannot lapse mid-call. */
  private static readonly TOKEN_SAFETY_MARGIN_MS = 60_000;

  constructor(
    private readonly logger: LoggerService,
    private readonly configService?: ConfigService
  ) {}

  private env(name: string): string | undefined {
    return this.configService?.get<string>(name) || process.env[name];
  }

  /**
   * No hardcoded default on purpose: a fallback to the live fasalrin host would mean a
   * deployment with a missing KCC_BASE_URL silently talks to production.
   * Expected form: https://fasalrin.gov.in/kccintegration
   */
  private getBaseUrl(): string {
    return String(this.env("KCC_BASE_URL") ?? "").replace(/\/+$/, "");
  }

  private getTimeout(): number {
    return Number(this.env("KCC_TIMEOUT")) || 20000;
  }

  // ── AES-256-CBC, hex-encoded, as the BharatVistaar integration keys specify ──

  private cipherKeys(): { key: Buffer; iv: Buffer } {
    const key = Buffer.from(String(this.env("KCC_SECRET_KEY") ?? ""), "utf-8");
    const iv = Buffer.from(String(this.env("KCC_IV") ?? ""), "utf-8");
    if (key.length !== 32 || iv.length !== 16) {
      throw new KccError(
        "KCC encryption is not configured (KCC_SECRET_KEY must be 32 bytes, KCC_IV 16)."
      );
    }
    return { key, iv };
  }

  encrypt(payload: unknown): string {
    const { key, iv } = this.cipherKeys();
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    return (
      cipher.update(JSON.stringify(payload), "utf8", "hex") + cipher.final("hex")
    );
  }

  decrypt(hex: string): any {
    const { key, iv } = this.cipherKeys();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const text =
      decipher.update(hex, "hex", "utf8") + decipher.final("utf8");
    return JSON.parse(text);
  }

  // ── auth ────────────────────────────────────────────────────────────────

  /**
   * Generated from KCC_ENTITY_TYPE / KCC_USER_ID / KCC_PASSWORD via /auth/token and
   * cached for its sessionTTL; a 401 drops the cache so the next call regenerates it.
   */
  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.value;
    }

    const entityType = this.env("KCC_ENTITY_TYPE");
    const userID = this.env("KCC_USER_ID");
    const password = this.env("KCC_PASSWORD");
    if (!entityType || !userID || !password) {
      throw new KccError(
        "KCC credentials are not configured (KCC_ENTITY_TYPE / KCC_USER_ID / KCC_PASSWORD)."
      );
    }

    const data = await this.send({
      method: "post",
      url: `${this.getBaseUrl()}/auth/token`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({ entityType, userID, password }).toString(),
    });

    const token = data?.data?.token;
    if (data?.status !== true || !token) {
      throw this.toKccError("auth/token", data);
    }

    const ttlSeconds = Number(data?.data?.sessionTTL) || 3600;
    this.cachedToken = {
      value: token,
      expiresAt:
        Date.now() + ttlSeconds * 1000 - KccService.TOKEN_SAFETY_MARGIN_MS,
    };
    return token;
  }

  // ── transport ───────────────────────────────────────────────────────────

  private toKccError(path: string, payload: any, status?: number): KccError {
    const message = String(payload?.error ?? payload?.message ?? "").trim();
    this.logger.error(
      `KCC ${path} failed status=${status ?? "(ok)"} error=${message || "(none)"}`
    );
    return new KccError(message || `KCC request failed${status ? ` (status ${status})` : ""}.`);
  }

  private async send(config: Parameters<typeof axios.request>[0]) {
    try {
      const response = await axios.request({
        timeout: this.getTimeout(),
        ...config,
      });
      return response.data;
    } catch (error: any) {
      if (error?.response) {
        if (error.response.status === 401) this.cachedToken = undefined;
        throw this.toKccError(
          String(config.url ?? ""),
          error.response.data,
          error.response.status
        );
      }
      // Timeout, DNS, connection refused — no upstream message to pass on.
      this.logger.error(
        `KCC request failed without a response: ${error?.message ?? error}`
      );
      throw new KccError(String(error?.message ?? "KCC could not be reached."));
    }
  }

  /**
   * Sends an encrypted `{ data }` body and returns the decrypted `data` of the reply.
   * Failures come back as `{ status: false, error }`, sometimes with no `data` at all.
   */
  private async call(path: string, payload: unknown): Promise<any> {
    // Encrypt first, so missing keys fail before a token is requested.
    const encrypted = this.encrypt(payload);
    const data = await this.send({
      method: "post",
      url: `${this.getBaseUrl()}${path}`,
      headers: {
        "Content-Type": "application/json",
        token: await this.getToken(),
      },
      data: { data: encrypted },
    });

    if (data?.status !== true) throw this.toKccError(path, data);

    const body = data?.data;
    if (typeof body === "string" && /^[0-9a-f]+$/i.test(body)) {
      try {
        return this.decrypt(body);
      } catch (err: any) {
        this.logger.error(`KCC ${path} response could not be decrypted: ${err?.message}`);
        throw new KccError("Unexpected response from KCC.");
      }
    }
    // Tolerate an unencrypted object, as the documented sample responses show.
    if (body && typeof body === "object") return body;
    throw new KccError("Unexpected response from KCC.");
  }

  // ── API ─────────────────────────────────────────────────────────────────

  /** Step 1 — send an OTP to the farmer's mobile. The number is never logged. */
  async requestOtp(mobileNumber: string): Promise<KccOtpSent> {
    const data = await this.call("/auth/requestOtp", {
      mobileNumber,
      otpFor: "krishika",
    });

    const requestId = String(data?.requestID ?? "");
    if (!requestId) throw new KccError(String(data?.message || "OTP could not be sent."));

    return {
      requestId,
      message: String(data?.message ?? "OTP sent successfully"),
      expiresIn: String(data?.expiresIn ?? ""),
    };
  }

  /**
   * Step 2 — the OTP and the requestID from step 1 fetch the application in one call;
   * there is no separate verify endpoint. The OTP is never logged.
   */
  async getApplicationStatus(
    requestId: string,
    otp: string
  ): Promise<KccApplicationStatus> {
    const data = await this.call(
      "/bharatVistaar/krishika/applicationStatus",
      { requestID: requestId, otp: Number(otp) }
    );

    const str = (value: any) =>
      value === null || value === undefined || value === "" ? null : String(value);
    const num = (value: any) =>
      value === null || value === undefined || value === "" ? null : Number(value);
    const list = (value: any) => (Array.isArray(value) ? value : []);
    const activities = data?.activities ?? {};

    return {
      farmerName: String(data?.farmerName ?? ""),
      applicationNo: String(data?.applicationNo ?? ""),
      applicationCurrentStatus: String(data?.applicationCurrentStatus ?? ""),
      requiredLoanAmount: num(data?.requiredLoanAmount),
      sanctionedAmount: num(data?.sanctionedAmount),
      updatedAt: String(data?.updatedAt ?? ""),
      bankName: str(data?.bankName),
      branchName: str(data?.branchName),
      rejectionReason: str(data?.rejectionReason),
      rejectedBy: str(data?.rejectedBy),
      applicationCreatedBy: str(data?.applicationCreatedBy),
      remark: str(data?.remark),
      applicationStatusHistory: list(data?.applicationStatusHistory).map(
        (entry: any) => ({
          createdAt: String(entry?.createdAt ?? ""),
          applicationStatus: String(entry?.applicationStatus ?? ""),
        })
      ),
      cropHusbandryDetails: list(activities.cropHusbandryDetails).map(
        (crop: any) => ({
          cropName: String(crop?.cropName ?? ""),
          season: String(crop?.season ?? ""),
          surveyNumber: String(crop?.surveyNumber ?? ""),
          subDivisionNumber: String(crop?.subDivisionNumber ?? ""),
          landArea: num(crop?.landArea),
          cropStateName: String(crop?.cropStateName ?? ""),
          cropDistrictName: String(crop?.cropDistrictName ?? ""),
          cropVillageName: String(crop?.cropVillageName ?? ""),
        })
      ),
      animalHusbandryDetails: list(activities.animalHusbandryDetails).map(
        (animal: any) => ({
          activityName: String(animal?.activityName ?? ""),
          unitCount: num(animal?.unitCount),
          animalStateName: String(animal?.animalStateName ?? ""),
          animalDistrictName: String(animal?.animalDistrictName ?? ""),
          animalVillageName: String(animal?.animalVillageName ?? ""),
        })
      ),
    };
  }
}
