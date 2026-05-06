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
      return this.buildEmptyResponse(context);
    }

    const url = `${baseUrl.replace(/\/$/, "")}/api/BeneficiaryService/GetApplicationStatusByAI`;
    this.logger.log(`[SMAM] Calling URL: ${url} with SearchValue=${searchValue}`);

    const timeoutMs = this.getApiTimeoutMs();
    this.logger.log(`[SMAM] Request timeout set to ${timeoutMs}ms`);

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
      this.logger.log(`[SMAM] smamPayload.data raw: ${smamPayload?.data}`);

      let parsedData: any[] = [];
      try {
        parsedData = smamPayload?.data ? JSON.parse(smamPayload.data) : [];
      } catch (parseError) {
        this.logger.error(`[SMAM] JSON.parse failed: ${parseError.message}`);
        return this.buildErrorResponse(body, "parse_error", `Failed to parse SMAM data: ${parseError.message}`);
      }

      this.logger.log(`[SMAM] parsedData isArray: ${Array.isArray(parsedData)}, length: ${parsedData.length}`);

      const applications: any[] = Array.isArray(parsedData) ? parsedData : [];

      if (applications.length === 0) {
        this.logger.warn("[SMAM] No applications found in parsed data.");
        return this.buildEmptyResponse(context);
      }

      this.logger.log(`[SMAM] applications[0] keys: ${JSON.stringify(Object.keys(applications[0] ?? {}))}`);
      this.logger.log(`[SMAM] applications[0].Implements length: ${applications[0]?.Implements?.length ?? 0}`);

      const items = applications.flatMap((app: any) =>
        (app.Implements ?? []).map((impl: any) => {
          const latestStatus = impl.StatusHistory?.[0] ?? {};

          return {
            id: String(app.ApplicationID),
            descriptor: {
              name: app.ApplicationRefNo,
              long_desc: impl.ImplementName,
            },
            tags: [
              {
                descriptor: {
                  code: "smam-application-status",
                  name: "SMAM Application Status",
                },
                list: [
                  {
                    descriptor: { code: "application_id", name: "Application ID" },
                    value: String(app.ApplicationID),
                  },
                  {
                    descriptor: { code: "application_ref_no", name: "Application Ref No" },
                    value: app.ApplicationRefNo ?? "",
                  },
                  {
                    descriptor: { code: "implement_name", name: "Implement Name" },
                    value: impl.ImplementName ?? "",
                  },
                  {
                    descriptor: { code: "implement_subsidy_id", name: "Implement Subsidy ID" },
                    value: String(impl.ImplementSubsidyID),
                  },
                  {
                    descriptor: { code: "current_status_code", name: "Current Status Code" },
                    value: String(latestStatus.StatusCode ?? ""),
                  },
                  {
                    descriptor: { code: "current_status_text", name: "Current Status" },
                    value: latestStatus.StatusText ?? "",
                  },
                  {
                    descriptor: { code: "current_status_date", name: "Status Date" },
                    value: latestStatus.StatusDate ?? "",
                  },
                  {
                    descriptor: { code: "status_history", name: "Status History" },
                    value: JSON.stringify(impl.StatusHistory ?? []),
                  },
                  {
                    descriptor: { code: "search_type", name: "Search Type" },
                    value: normalizedSearchType,
                  },
                  {
                    descriptor: { code: "search_value", name: "Search Value" },
                    value: searchValue,
                  },
                ],
              },
            ],
          };
        }),
      );

      this.logger.log(`[SMAM] Final items count: ${items.length}`);

      // Pass through SMAM API shape (data as parsed JSON array) alongside Beckn catalog.
      const smamApiMirror = {
        success: !!smamPayload?.success,
        message: smamPayload?.message ?? "",
        data: applications,
      };
      this.logger.log(
        `[SMAM] Returning on_search with SMAM API mirror: success=${smamApiMirror.success}, dataLength=${applications.length}`,
      );

      return {
        context: {
          ...context,
          action: "on_search",
          timestamp: new Date().toISOString(),
        },
        message: {
          catalog: {
            descriptor: { name: "SMAM Application Status" },
            tags: [
              {
                descriptor: {
                  code: "smam-api-response",
                  name: "SMAM API Response (passthrough)",
                },
                list: [
                  {
                    descriptor: { code: "success", name: "Success" },
                    value: String(smamApiMirror.success),
                  },
                  {
                    descriptor: { code: "message", name: "Message" },
                    value: smamApiMirror.message,
                  },
                  {
                    descriptor: { code: "data", name: "Data" },
                    value: JSON.stringify(smamApiMirror.data),
                  },
                ],
              },
            ],
            providers: [
              {
                id: "smam",
                descriptor: { name: "SMAM" },
                items,
              },
            ],
          },
        },
      };
    } catch (error) {
      this.logger.error(
        `[SMAM] API call failed: ${error.message}`,
        error?.response?.data ?? "",
      );
      return this.buildErrorResponse(body, "api_error", error.message);
    }
  }

  private buildEmptyResponse(context: any) {
    return {
      context: {
        ...context,
        action: "on_search",
        timestamp: new Date().toISOString(),
      },
      message: {
        catalog: {
          descriptor: { name: "SMAM Application Status" },
          providers: [],
        },
      },
    };
  }

  private buildErrorResponse(body: any, code: string, message: string) {
    return {
      context: {
        ...body?.context,
        action: "on_search",
        timestamp: new Date().toISOString(),
      },
      message: {
        catalog: {
          descriptor: { name: "SMAM Application Status" },
          providers: [
            {
              id: "smam",
              descriptor: { name: "SMAM" },
              items: [
                {
                  id: "error",
                  descriptor: { name: "Error", short_desc: message },
                  tags: [
                    {
                      descriptor: { code },
                      list: [
                        { descriptor: { code: "message" }, value: message },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
  }
}