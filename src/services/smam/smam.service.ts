import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class SmamService {
  private readonly logger = new Logger(SmamService.name);

  constructor(private readonly configService: ConfigService) {}

  private getBaseUrl(): string {
    return (
      this.configService.get<string>("SMAM_BASE_URL") ||
      process.env.SMAM_BASE_URL ||
      ""
    );
  }

  private getToken(): string {
    return (
      this.configService.get<string>("SMAM_TOKEN") ||
      process.env.SMAM_TOKEN ||
      ""
    );
  }

  /** SMAM API often responds in ~15s; default 45s to avoid client/proxy timeouts cutting us off first. */
  private getApiTimeoutMs(): number {
    const raw =
      this.configService.get<string>("SMAM_API_TIMEOUT_MS") ||
      process.env.SMAM_API_TIMEOUT_MS;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 45000;
  }

  private getSearchValue(body: any): string {
    const searchTag = body?.message?.intent?.item?.tags?.find(
      (tag: any) => tag?.descriptor?.code === "search_params",
    );
    return (
      searchTag?.list?.find(
        (entry: any) => entry?.descriptor?.code === "search_value",
      )?.value ?? ""
    );
  }

  private getSearchType(body: any): string {
    const searchTag = body?.message?.intent?.item?.tags?.find(
      (tag: any) => tag?.descriptor?.code === "search_params",
    );
    return (
      searchTag?.list
        ?.find((entry: any) => entry?.descriptor?.code === "search_type")
        ?.value?.toLowerCase() ?? ""
    );
  }

  async searchSMAMBenfitData(body: any): Promise<any> {
    const context = body?.context ?? {};
    const searchType = this.getSearchType(body);
    const searchValue = this.getSearchValue(body);
    const baseUrl = this.getBaseUrl();
    const smamToken = this.getToken();

    const allowedSearchTypes = new Set([
      "application_no",
      "phone_no",
      "aadhaar_no",
    ]);
    const normalizedSearchType = allowedSearchTypes.has(searchType)
      ? searchType
      : "application_no";

    this.logger.log(
      `[SMAM] Received search request — provider=${body?.message?.intent?.provider?.id ?? ""}, searchType=${normalizedSearchType}, searchValue=${searchValue}`,
    );

    if (searchType && !allowedSearchTypes.has(searchType)) {
      this.logger.warn(
        `[SMAM] Unsupported search_type="${searchType}". Falling back to application_no`,
      );
    }

    if (!searchValue) {
      this.logger.warn("[SMAM] Missing search_value in request payload.");
      return this.buildEmptyResponse(context, normalizedSearchType, searchValue);
    }

    const url = `${baseUrl.replace(/\/$/, "")}/api/BeneficiaryService/GetApplicationStatusByAI`;
    this.logger.log(`[SMAM] Calling URL: ${url} with SearchValue=${searchValue}`);

    const timeoutMs = this.getApiTimeoutMs();
    this.logger.log(`[SMAM] Request timeout set to ${timeoutMs}ms`);

    let apiStatus = "Failed";
    let apiMessage = "";
    let applications: any[] = [];

    try {
      const response = await axios.post(
        url,
        { SearchValue: searchValue },
        {
          headers: {
            Token: smamToken,
            "Content-Type": "application/json",
          },
          timeout: timeoutMs,
        },
      );

      const smamPayload = response?.data ?? {};

      this.logger.log(`[SMAM] smamPayload.success: ${smamPayload?.success}`);
      this.logger.log(`[SMAM] smamPayload.message: ${smamPayload?.message}`);
      this.logger.log(`[SMAM] smamPayload.data type: ${typeof smamPayload?.data}`);

      apiMessage = smamPayload?.message ?? "";

      // Parse `data` — the SMAM API returns it as a JSON string inside the response body.
      // axios may auto-parse it as an array if the Content-Type is application/json,
      // so handle both cases defensively.
      let parsedData: any[] = [];
      try {
        if (!smamPayload?.data) {
          this.logger.log("[SMAM] data field is empty/null — treating as empty array.");
          parsedData = [];
        } else if (Array.isArray(smamPayload.data)) {
          this.logger.log("[SMAM] data field is already a parsed array.");
          parsedData = smamPayload.data;
        } else if (typeof smamPayload.data === "object") {
          this.logger.log("[SMAM] data field is a parsed object — wrapping in array.");
          parsedData = [smamPayload.data];
        } else {
          this.logger.log("[SMAM] data field is a string — calling JSON.parse.");
          parsedData = JSON.parse(smamPayload.data);
        }
      } catch (parseError) {
        this.logger.error(`[SMAM] JSON.parse failed: ${parseError.message}`);
        return this.buildErrorResponse(context, normalizedSearchType, searchValue, "parse_error", `Failed to parse SMAM data: ${parseError.message}`);
      }

      this.logger.log(`[SMAM] parsedData isArray: ${Array.isArray(parsedData)}, length: ${parsedData.length}`);

      applications = Array.isArray(parsedData) ? parsedData : [];
      apiStatus = smamPayload?.success ? "Success" : "Failed";

      if (applications.length === 0) {
        this.logger.warn("[SMAM] No applications found in parsed data.");
        return this.buildEmptyResponse(context, normalizedSearchType, searchValue, apiMessage);
      }

      this.logger.log(`[SMAM] applications[0] keys: ${JSON.stringify(Object.keys(applications[0] ?? {}))}`);
      this.logger.log(`[SMAM] applications[0].Implements length: ${applications[0]?.Implements?.length ?? 0}`);

    } catch (error) {
      this.logger.error(
        `[SMAM] API call failed: ${error.message}`,
        error?.response?.data ?? "",
      );
      apiMessage = error.message;
      return this.buildErrorResponse(context, normalizedSearchType, searchValue, "api_error", error.message);
    }

    // ── Build Beckn on_search catalog (Sathi-style) ──────────────────────────
    // Each application → one provider; each implement → one item under that provider.
    const providers = applications.map((app: any) => {
      const implements_: any[] = app.Implements ?? [];

      const items = implements_.map((impl: any) => {
        const statusHistory: any[] = impl.StatusHistory ?? [];
        const latestStatus = statusHistory[0] ?? {};

        return {
          id: String(impl.ImplementSubsidyID),
          descriptor: {
            name: impl.ImplementName ?? "",
            code: String(impl.ImplementSubsidyID),
          },
          tags: [
            {
              descriptor: {
                code: "implement-status",
                name: "Implement Status",
              },
              list: [
                {
                  descriptor: { code: "current-status-code", name: "Current Status Code" },
                  value: String(latestStatus.StatusCode ?? ""),
                },
                {
                  descriptor: { code: "current-status-text", name: "Current Status" },
                  value: latestStatus.StatusText ?? "",
                },
                {
                  descriptor: { code: "current-status-date", name: "Status Date" },
                  value: latestStatus.StatusDate ?? "",
                },
              ],
            },
            {
              descriptor: {
                code: "status-history",
                name: "Status History",
              },
              list: statusHistory.map((hist: any, idx: number) => ({
                descriptor: {
                  code: `history-${idx + 1}`,
                  name: `Step ${idx + 1}`,
                },
                value: JSON.stringify({
                  status_code: hist.StatusCode,
                  status_text: hist.StatusText,
                  status_date: hist.StatusDate,
                }),
              })),
            },
          ],
        };
      });

      return {
        id: String(app.ApplicationID),
        descriptor: {
          name: app.ApplicationRefNo ?? String(app.ApplicationID),
          code: String(app.ApplicationID),
        },
        items,
      };
    });

    const totalItems = providers.reduce((sum: number, p: any) => sum + (p.items?.length ?? 0), 0);
    this.logger.log(`[SMAM] Built ${providers.length} provider(s) with ${totalItems} item(s) total.`);

    return {
      context: {
        ...context,
        action: "on_search",
        timestamp: new Date().toISOString(),
      },
      message: {
        catalog: {
          descriptor: {
            name: "SMAM Application Status",
            code: "smam",
          },
          tags: [
            {
              descriptor: {
                code: "search-context",
                name: "Search Context",
              },
              list: [
                {
                  descriptor: { code: "status", name: "Status" },
                  value: apiStatus,
                },
                {
                  descriptor: { code: "message", name: "Message" },
                  value: apiMessage,
                },
                {
                  descriptor: { code: "search-type", name: "Search Type" },
                  value: normalizedSearchType,
                },
                {
                  descriptor: { code: "search-value", name: "Search Value" },
                  value: searchValue,
                },
              ],
            },
          ],
          providers,
        },
      },
    };
  }

  private buildEmptyResponse(context: any, searchType = "", searchValue = "", message = "") {
    return {
      context: {
        ...context,
        action: "on_search",
        timestamp: new Date().toISOString(),
      },
      message: {
        catalog: {
          descriptor: { name: "SMAM Application Status", code: "smam" },
          tags: [
            {
              descriptor: { code: "search-context", name: "Search Context" },
              list: [
                { descriptor: { code: "status", name: "Status" }, value: "Failed" },
                { descriptor: { code: "message", name: "Message" }, value: message || "No applications found" },
                { descriptor: { code: "search-type", name: "Search Type" }, value: searchType },
                { descriptor: { code: "search-value", name: "Search Value" }, value: searchValue },
              ],
            },
          ],
          providers: [],
        },
      },
    };
  }

  private buildErrorResponse(context: any, searchType = "", searchValue = "", code: string, message: string) {
    return {
      context: {
        ...context,
        action: "on_search",
        timestamp: new Date().toISOString(),
      },
      message: {
        catalog: {
          descriptor: { name: "SMAM Application Status", code: "smam" },
          tags: [
            {
              descriptor: { code: "search-context", name: "Search Context" },
              list: [
                { descriptor: { code: "status", name: "Status" }, value: "Failed" },
                { descriptor: { code: "message", name: "Message" }, value: message },
                { descriptor: { code: "error-code", name: "Error Code" }, value: code },
                { descriptor: { code: "search-type", name: "Search Type" }, value: searchType },
                { descriptor: { code: "search-value", name: "Search Value" }, value: searchValue },
              ],
            },
          ],
          providers: [],
        },
      },
    };
  }
}
