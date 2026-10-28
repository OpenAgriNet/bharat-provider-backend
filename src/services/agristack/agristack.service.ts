import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { constants, createDecipheriv, createPrivateKey, privateDecrypt, randomUUID } from "crypto";
import { readFileSync } from "fs";

interface AgristackTokenResponse {
  access_token: string;
  expires_in?: number;
}

interface AgristackSeekResponse {
  header?: { status?: string; completed_count?: number; is_msg_encrypted?: boolean };
  message?: Record<string, unknown>;
}

@Injectable()
export class AgristackService {
  private readonly logger = new Logger(AgristackService.name);
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly configService: ConfigService,
  ) { }

  private getEnv(key: string, fallback = ""): string {
    return this.configService.get<string>(key) || process.env[key] || fallback;
  }

  private getTokenUrl(): string {
    return this.getEnv("AGRISTACK_TOKEN_URL", "https://ufsi.agristack.gov.in/nm/token");
  }

  private getSeekUrl(): string {
    return this.getEnv(
      "AGRISTACK_SEEK_URL",
      "https://ufsi.agristack.gov.in/gateway/seek",
    );
  }

  private getSenderId(): string {
    return this.getEnv("AGRISTACK_SENDER_ID");
  }

  private getReceiverId(): string {
    return this.getEnv("AGRISTACK_RECEIVER_ID");
  }

  private getSignature(): string {
    return this.getEnv("AGRISTACK_SIGNATURE");
  }

  /** Reads a flat tag value by code from item.tags (same convention as SathiService). */
  private getTagValue(body: any, code: string): string {
    const tags: any[] = body?.message?.intent?.item?.tags ?? [];
    return tags.find((tag: any) => tag?.descriptor?.code === code)?.value ?? "";
  }

  private isTokenValid(): boolean {
    return !!this.cachedToken && Date.now() < this.tokenExpiresAt;
  }

  private async requestNewToken(): Promise<string> {
    const clientId = this.getEnv("AGRISTACK_CLIENT_ID", "registry-frontend");
    const username = this.getEnv("AGRISTACK_USERNAME");
    const password = this.getEnv("AGRISTACK_PASSWORD");

    const params = new URLSearchParams({
      client_id: clientId,
      username,
      password,
      grant_type: "password",
    });

    this.logger.log("[AGRISTACK] Requesting new access token");
    const response = await axios.post<AgristackTokenResponse>(
      this.getTokenUrl(),
      params.toString(),
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      },
    );

    const { access_token, expires_in } = response.data ?? ({} as AgristackTokenResponse);
    if (!access_token) {
      throw new Error("AgriStack token response missing access_token");
    }

    this.cachedToken = access_token;
    // Refresh 30s before actual expiry; default to 4.5 minutes when server doesn't send expires_in.
    const ttlSeconds = expires_in && expires_in > 30 ? expires_in - 30 : 270;
    this.tokenExpiresAt = Date.now() + ttlSeconds * 1000;

    return access_token;
  }

  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.isTokenValid()) {
      return this.cachedToken as string;
    }
    return this.requestNewToken();
  }

  private buildSeekPayload(serviceId: string, queryParam: Record<string, string>) {
    return {
      signature: this.getSignature(),
      header: {
        version: "0.1.0",
        message_id: randomUUID(),
        message_ts: new Date().toISOString(),
        sender_id: this.getSenderId(),
        receiver_id: this.getReceiverId(),
        total_count: 1,
        is_msg_encrypted: false,
      },
      message: {
        transaction_id: randomUUID(),
        seek_request: {
          service_id: serviceId,
          query_param: queryParam,
        },
      },
    };
  }

  private decryptSeekResponse(response: AgristackSeekResponse): Record<string, unknown>[] {
    if (response?.header?.status !== "succeed") {
      throw new Error("AgriStack gateway returned an unsuccessful response");
    }
    if (response.header.completed_count === 0 && response.header.is_msg_encrypted === false) {
      return [];
    }
    const message = response.message;
    if (response.header.is_msg_encrypted !== true ||
      message?.encryption_alg !== "AES-256-GCM+RSA-OAEP-SHA256") {
      throw new Error("AgriStack response encryption is missing or unsupported");
    }

    const decode = (field: string): Buffer => {
      const value = message[field];
      if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new Error(`AgriStack response has invalid ${field}`);
      }
      const decoded = Buffer.from(value, "base64");
      if (decoded.toString("base64") !== value) {
        throw new Error(`AgriStack response has invalid ${field}`);
      }
      return decoded;
    };
    const encryptedData = decode("encrypted_data");
    const encryptedKey = decode("encrypted_key");
    const iv = decode("iv");
    const authTag = decode("auth_tag");
    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error("AgriStack response has invalid encryption parameters");
    }

    let plaintext: Buffer;
    try {
      const privateKey = createPrivateKey(readFileSync(this.getEnv("AGRISTACK_PRIVATE_KEY_PATH", "private_key.pem")));
      if (privateKey.asymmetricKeyType !== "rsa" || privateKey.asymmetricKeyDetails?.modulusLength < 2048) {
        throw new Error("AgriStack requires an RSA private key of at least 2048 bits");
      }
      const aesKey = privateDecrypt({
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      }, encryptedKey);
      if (aesKey.length !== 32) {
        throw new Error("Invalid AES key length");
      }
      const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    } catch {
      throw new Error("AgriStack response decryption failed; verify the private key and registered public key");
    }
    let entries: unknown;
    try {
      entries = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("AgriStack decrypted response is not valid JSON");
    }
    if (!Array.isArray(entries) || !entries.every((entry) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
      entry.farmerData !== null && typeof entry.farmerData === "object" &&
      !Array.isArray(entry.farmerData) && Array.isArray(entry.landData))) {
      throw new Error("AgriStack decrypted response must be an array of farmer records");
    }
    return entries;
  }

  private async seek(
    serviceId: string,
    queryParam: Record<string, string>,
    logLabel: string,
    stateLgdCode: string,
  ): Promise<Record<string, unknown>[]> {
    if (!/^[1-9][0-9]?$/.test(stateLgdCode)) {
      this.logger.warn("[AGRISTACK] Request rejected: missing or invalid stateLgdCode");
      throw new Error("A valid stateLgdCode is required");
    }
    const maxAttempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const token = await this.getToken(attempt > 1);
      const requestPayload = this.buildSeekPayload(serviceId, queryParam);

      try {
        this.logger.log(
          `[AGRISTACK] ${logLabel} attempt=${attempt} queryParam=${JSON.stringify(queryParam)}`,
        );
        const response = await axios.post<AgristackSeekResponse>(
          this.getSeekUrl(),
          requestPayload,
          {
            headers: {
              "Content-Type": "application/json",
              "X-State-LGD-Code": stateLgdCode,
              Authorization: `Bearer ${token}`,
            },
            timeout: 20000,
          },
        );

        return this.decryptSeekResponse(response.data);
      } catch (error: any) {
        lastError = error;
        const status = error?.response?.status;

        if (status === 401 && attempt < maxAttempts) {
          this.logger.warn(`[AGRISTACK] ${logLabel} token rejected, refreshing and retrying`);
          continue;
        }
        this.logger.error(
          `[AGRISTACK] ${logLabel} failed: ${error?.message}`,
          JSON.stringify(error?.response?.data ?? ""),
        );
        throw error;
      }
    }

    throw lastError;
  }

  private buildErrorCatalog(body: any, code: string, message: string) {
    return {
      descriptor: { name: "AgriStack Farmer Data" },
      providers: [
        {
          id: body?.message?.intent?.provider?.id ?? "agristack-agri",
          descriptor: { name: "AgriStack" },
          items: [
            {
              id: "error",
              descriptor: { name: "Error", short_desc: message },
              tags: [
                {
                  descriptor: { code },
                  list: [{ descriptor: { code: "message" }, value: message }],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  private buildCatalog(body: any, categoryCode: string, seekResponse: any[]): any {
    const providerId = body?.message?.intent?.provider?.id ?? "agristack-agri";
    const items = (seekResponse ?? []).map((entry: any, index: number) => {
      const farmerData = entry?.farmerData ?? {};
      return {
        id: farmerData?.frCentralId ?? farmerData?.centralId ?? `agristack-${index}`,
        descriptor: {
          name: farmerData?.farmerNameEng ?? farmerData?.frNameEn ?? "AgriStack Farmer",
          code: categoryCode,
        },
        tags: [
          {
            descriptor: { code: "farmer-data", name: "Farmer Data" },
            list: [
              { descriptor: { code: "raw", name: "Raw Farmer Data" }, value: JSON.stringify(farmerData) },
            ],
          },
          {
            descriptor: { code: "land-data", name: "Land Data" },
            list: [
              {
                descriptor: { code: "raw", name: "Raw Land Data" },
                value: JSON.stringify(entry?.landData ?? []),
              },
            ],
          },
          ...(entry?.cropSurveyData
            ? [
              {
                descriptor: { code: "crop-survey-data", name: "Crop Survey Data" },
                list: [
                  {
                    descriptor: { code: "raw", name: "Raw Crop Survey Data" },
                    value: JSON.stringify(entry.cropSurveyData),
                  },
                ],
              },
            ]
            : []),
          ...(entry?.landOwnershipData
            ? [
              {
                descriptor: { code: "land-ownership-data", name: "Land Ownership Data" },
                list: [
                  {
                    descriptor: { code: "raw", name: "Raw Land Ownership Data" },
                    value: JSON.stringify(entry.landOwnershipData),
                  },
                ],
              },
            ]
            : []),
        ],
      };
    });

    return {
      descriptor: { name: "AgriStack Farmer Data" },
      providers: [
        {
          id: providerId,
          descriptor: { name: "AgriStack" },
          items,
        },
      ],
    };
  }

  private onSearchContext(body: any) {
    return { ...body.context, action: "on_search" };
  }

  /** Same firstItemId resolution the controller used, now owned by the service. */
  private resolveCategory(body: any): "agristack-category-a" | "agristack-category-b" | "agristack-category-c" {
    const firstItemId =
      body?.message?.order?.items?.[0]?.id ??
      body?.message?.intent?.items?.[0]?.id ??
      body?.message?.intent?.item?.id;

    switch (firstItemId) {
      case "agristack-category-b":
        return "agristack-category-b";
      case "agristack-category-c":
        return "agristack-category-c";
      case "agristack-category-a":
      default:
        return "agristack-category-a";
    }
  }

  /** Single entry point: picks Category A/B/C internally from the item id. */
  async search(body: any): Promise<any> {
    switch (this.resolveCategory(body)) {
      case "agristack-category-b":
        return this.searchCategoryB(body);
      case "agristack-category-c":
        return this.searchCategoryC(body);
      case "agristack-category-a":
      default:
        return this.searchCategoryA(body);
    }
  }

  /** Category A: identity + village by farmer central ID. */
  private async fetchCategoryA(farmerId: string, stateLgdCode: string): Promise<Record<string, unknown>[]> {
    const serviceId = this.getEnv(
      "AGRISTACK_SERVICE_ID_CATEGORY_A",
      "5cbfc880-ee43-45b4-993d-972f44fe5684",
    );
    return this.seek(serviceId, { frCentralId: farmerId }, "categoryA", stateLgdCode);
  }

  /** Category B: land + crop survey data by farmerId/season/year. */
  private async fetchCategoryB(farmerId: string, season: string, year: string, stateLgdCode: string): Promise<Record<string, unknown>[]> {
    const serviceId = this.getEnv(
      "AGRISTACK_SERVICE_ID_CATEGORY_B",
      "69ade724-4c1e-4d7e-b2df-176b1cc7ef1b",
    );
    return this.seek(serviceId, { frCentralId: farmerId, season, year }, "categoryB", stateLgdCode);
  }

  /** Category C: full farmer + land ownership + crop survey data. */
  private async fetchCategoryC(farmerId: string, season: string, year: string, stateLgdCode: string): Promise<Record<string, unknown>[]> {
    const serviceId = this.getEnv(
      "AGRISTACK_SERVICE_ID_CATEGORY_C",
      "91cb6b4d-d986-416a-bcb2-4b1201602909",
    );
    return this.seek(serviceId, { frCentralId: farmerId, season, year }, "categoryC", stateLgdCode);
  }

  private async searchCategoryA(body: any): Promise<any> {
    const context = this.onSearchContext(body);
    const farmerId = this.getTagValue(body, "farmerId");

    if (!farmerId) {
      return { context, message: { catalog: this.buildErrorCatalog(body, "invalid_request", "farmerId is required") } };
    }

    try {
      const seekResponse = await this.fetchCategoryA(farmerId, this.getTagValue(body, "stateLgdCode"));
      return { context, message: { catalog: this.buildCatalog(body, "agristack-category-a", seekResponse) } };
    } catch (error: any) {
      return { context, message: { catalog: this.buildErrorCatalog(body, "upstream_error", error?.message ?? "AgriStack request failed") } };
    }
  }

  private async searchCategoryB(body: any): Promise<any> {
    const context = this.onSearchContext(body);
    const farmerId = this.getTagValue(body, "farmerId");
    const season = this.getTagValue(body, "season");
    const year = this.getTagValue(body, "year");

    if (!farmerId || !season || !year) {
      return {
        context,
        message: { catalog: this.buildErrorCatalog(body, "invalid_request", "farmerId, season and year are required") },
      };
    }

    try {
      const seekResponse = await this.fetchCategoryB(farmerId, season, year, this.getTagValue(body, "stateLgdCode"));
      return { context, message: { catalog: this.buildCatalog(body, "agristack-category-b", seekResponse) } };
    } catch (error: any) {
      return { context, message: { catalog: this.buildErrorCatalog(body, "upstream_error", error?.message ?? "AgriStack request failed") } };
    }
  }

  private async searchCategoryC(body: any): Promise<any> {
    const context = this.onSearchContext(body);
    const farmerId = this.getTagValue(body, "farmerId");
    const season = this.getTagValue(body, "season");
    const year = this.getTagValue(body, "year");

    if (!farmerId || !season || !year) {
      return {
        context,
        message: { catalog: this.buildErrorCatalog(body, "invalid_request", "farmerId, season and year are required") },
      };
    }

    try {
      const seekResponse = await this.fetchCategoryC(farmerId, season, year, this.getTagValue(body, "stateLgdCode"));
      return { context, message: { catalog: this.buildCatalog(body, "agristack-category-c", seekResponse) } };
    } catch (error: any) {
      return { context, message: { catalog: this.buildErrorCatalog(body, "upstream_error", error?.message ?? "AgriStack request failed") } };
    }
  }
}
