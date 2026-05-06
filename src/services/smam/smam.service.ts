import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class SmamService {
  private readonly logger = new Logger(SmamService.name);

  constructor(private readonly configService: ConfigService) { }

  private getBaseUrl(): string {
    return (
      this.configService.get<string>("SMAM_BASE_URL") ||
      process.env.SMAM_BASE_URL ||
      "https://agrimachinery.nic.in"
    );
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
    const allowedSearchTypes = new Set([
      "application_no",
      "phone_no",
      "aadhaar_no",
    ]);
    const normalizedSearchType = allowedSearchTypes.has(searchType)
      ? searchType
      : "application_no";

    this.logger.log(
      `[SMAM] Received search request for provider=${body?.message?.intent?.provider?.id ?? ""}, searchType=${normalizedSearchType}, searchValue=${searchValue}`,
    );

    if (searchType && !allowedSearchTypes.has(searchType)) {
      this.logger.warn(
        `[SMAM] Unsupported search_type=${searchType}. Falling back to application_no`,
      );
    }

    if (!searchValue) {
      this.logger.warn("[SMAM] Missing search_value in request payload.");
      return {
        context: {
          ...context,
          action: "on_search",
          timestamp: new Date().toISOString(),
        },
        message: {
          catalog: {
            descriptor: { name: "SMAM Application Status", code: "smam" },
            providers: [],
          },
        },
      };
    }

    const url = `${baseUrl.replace(/\/$/, "")}/api/BeneficiaryService/GetApplicationStatusByAI`;
    const token = "E6A12F822C27D4570C38969C434AF0EE";

    try {
      const response = await axios.post(
        url,
        { SearchValue: searchValue },
        {
          headers: {
            Token: token,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );

      const smamPayload = response?.data ?? {};
      const parsedData = smamPayload?.data ? JSON.parse(smamPayload.data) : [];

      const applications: any[] = Array.isArray(parsedData) ? parsedData : [];

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
        })
      );

      const onSearchResponse = {
        context: {
          ...context,
          action: "on_search",
          timestamp: new Date().toISOString(),
        },
        message: {
          catalog: {
            descriptor: { name: "SMAM Application Status", code: "smam" },
            providers: [
              {
                id: "smam",
                descriptor: { name: "SMAM", code: "smam" },
                items,  // ← individual items per implement, not one blob
              },
            ],
          },
        },
      };

      return onSearchResponse;
    } catch (error) {
      this.logger.error(
        `[SMAM] API call failed: ${error.message}`,
        error?.response?.data ?? "",
      );

      return {
        context: {
          ...context,
          action: "on_search",
          timestamp: new Date().toISOString(),
        },
        message: {
          catalog: {
            descriptor: { name: "SMAM Application Status", code: "smam" },
            providers: [],
            tags: [
              {
                descriptor: { code: "smam-error", name: "SMAM Error" },
                list: [
                  {
                    descriptor: { code: "message", name: "Message" },
                    value: error?.message ?? "SMAM API call failed",
                  },
                ],
              },
            ],
          },
        },
      };
    }
  }
}
