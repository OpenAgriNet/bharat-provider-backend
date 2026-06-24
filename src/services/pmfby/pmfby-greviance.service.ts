import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class PmfbyGrievanceService {
  constructor(
    private readonly logger: LoggerService,
    private readonly configService?: ConfigService,
  ) {}

  private getBaseUrl(): string {
    return (
      this.configService?.get<string>("PMFBY_BASE_URL") ||
      process.env.PMFBY_BASE_URL
    );
  }

  private getAppAccessUID(): string {
    return (
      this.configService?.get<string>("PMFBY_APP_ACCESS_UID") ||
      process.env.PMFBY_APP_ACCESS_UID
    );
  }

  private getAppAccessPWD(): string {
    return (
      this.configService?.get<string>("PMFBY_APP_ACCESS_PWD") ||
      process.env.PMFBY_APP_ACCESS_PWD
    );
  }

  /**
   * Step 1: Login to FGMS and retrieve JWT token
   */
  private async getFGMSToken(): Promise<string> {
    const baseUrl = this.getBaseUrl();
    const appAccessUID = this.getAppAccessUID();
    const appAccessPWD = this.getAppAccessPWD();

    this.logger.log("Fetching FGMS login token...");

    const response = await axios.request({
      method: "post",
      url: `${baseUrl}/krphapi/FGMS/NICUsersLogin`,
      headers: { "Content-Type": "application/json" },
      data: { appAccessUID, appAccessPWD },
      timeout: 15000,
    });

    const token: string | undefined = response.data?.responseDynamic?.token?.Token;

    if (!token) {
      this.logger.error(
        "FGMS login failed - no token in response",
        response.data,
      );
      throw new Error("FGMS login failed: token not found in response");
    }

    this.logger.log("FGMS token retrieved successfully");
    return token;
  }

  async getGrievanceStatus(
    requestorMobileNo: string,
    grievanceSupportTicketNo: string,
  ): Promise<any> {
    try {
      const token = await this.getFGMSToken();
      this.logger.log("PMFBY grievance token", token);
      this.logger.log("PMFBY grievance requestorMobileNo", requestorMobileNo);
      this.logger.log("PMFBY grievance grievanceSupportTicketNo", grievanceSupportTicketNo);


      const curlCommand = `curl -X POST '${this.getBaseUrl()}/krphapi/FGMS/GetGrievenceTicketsStatus' -H 'Content-Type: application/json' -H 'Authorization: ${token}' -d '${JSON.stringify({
        requestorMobileNo,
        GrievenceSupportTicketNo: grievanceSupportTicketNo,
      })}'`;
      
      this.logger.log("PMFBY grievance curl: " + curlCommand);



      const response = await axios.request({
        method: "post",
        url: `${this.getBaseUrl()}/krphapi/FGMS/GetGrievenceTicketsStatus`,
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        data: {
          requestorMobileNo,
          GrievenceSupportTicketNo: grievanceSupportTicketNo,
        },
        timeout: 60000,
      });

      this.logger.log(
        "FGMS grievance status response: " + JSON.stringify(response.data),
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        `PMFBY grievance status API error: ${error.message}`,
        error.response?.data ?? "",
      );
      throw new Error(
        error.response?.data?.responseMessage ||
          error.message ||
          "Failed to fetch grievance status",
      );
    }
  }

  /**
   * Submit a PMFBY grievance ticket.
   * Expects a standard Beckn `init` body. All grievance fields are read as
   * flat tags on `message.order.fulfillments[0].customer.person.tags`,
   * each tag having a `descriptor.code` and a top-level `value`.
   *
   * Returns a Beckn `on_init` response envelope.
   */
  async createGrievance(body: any): Promise<any> {
    const context = body?.context;
    const order = body?.message?.order;
    const fulfillment = order?.fulfillments?.[0];
    const customer = fulfillment?.customer;
    const person = customer?.person;

    // ── Helper: read a flat tag value by code from person.tags ───────────
    const getTagValue = (code: string): string =>
      person?.tags?.find((tag: any) => tag?.descriptor?.code === code)
        ?.value ?? "";

    // ── Extract all fields from flat person tags ─────────────────────────
    const requestorMobileNo: string = getTagValue("phone_number");
    const customerName: string = person?.name ?? "";
    const complaintDate: string = getTagValue("complaint_date");
    const receiptSourceID: number = Number(getTagValue("receipt_source_id")) || 0;
    const ticketCategoryID: number =
      Number(getTagValue("ticket_category_id")) || 0;
    const ticketSubCategoryID: number =
      Number(getTagValue("ticket_sub_category_id")) || 0;
    const requestYear: string = getTagValue("request_year");
    const requestSeason: number = Number(getTagValue("request_season")) || 0;
    const applicationNo: string = getTagValue("application_no");
    const grievenceDescription: string = getTagValue("grievance_description");

    this.logger.log(
      `[PMFBY GRIEVANCE] Submitting for mobile: ${requestorMobileNo}, applicationNo: ${applicationNo}`,
    );

    let apiResponse: any = {};
    try {
      // Step 1: Authenticate
      const token = await this.getFGMSToken();

      // Step 2: Submit grievance ticket
      const response = await axios.request({
        method: "post",
        url: `${this.getBaseUrl()}/krphapi/FGMS/AddKRPHNCIPGrievenceSupportTicket`,
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
        },
        data: {
          requestorMobileNo,
          complaintDate,
          receiptSourceID,
          ticketCategoryID,
          ticketSubCategoryID,
          requestYear,
          requestSeason,
          applicationNo,
          grievenceDescription,
        },
        timeout: 15000,
      });

      this.logger.log("FGMS grievance response: " + JSON.stringify(response.data));
      apiResponse = response.data;
    } catch (error) {
      this.logger.error(
        `PMFBY Grievance API error: ${error.message}`,
        error.response?.data ?? "",
      );
      apiResponse = { responseCode: "0", responseMessage: error.message };
    }

    // ── Map FGMS response to Beckn on_init envelope ──────────────────────
    const isSuccess = apiResponse?.responseCode === "1";
    const ticketNo: string =
      apiResponse?.responseDynamic?.GrievenceSupportTicketNo ?? "";
    const ticketId: string = String(
      apiResponse?.responseDynamic?.GrievenceSupportTicketID ?? "",
    );
    const responseMessage: string = apiResponse?.responseMessage ?? "";

    return {
      context: {
        ...context,
        action: "on_init",
        timestamp: new Date().toISOString(),
      },
      message: {
        order: {
          provider: { id: "pmfby-grievance" },
          items: [{ id: "pmfby-grievance" }],
          fulfillments: [
            {
              customer: {
                person: { name: customerName },
                contact: { phone: requestorMobileNo },
              },
            },
          ],
          tags: [
            {
              descriptor: {
                code: 'grievance-response',
                name: 'Grievance Response',
              },
              list: [
                {
                  descriptor: { code: "status", name: "Status" },
                  value: isSuccess ? "Submitted" : "Failed",
                },
                {
                  descriptor: { code: "ticket-no", name: "Ticket Number" },
                  value: ticketNo,
                },
                {
                  descriptor: { code: "ticket-id", name: "Ticket ID" },
                  value: ticketId,
                },
                {
                  descriptor: {
                    code: "application-no",
                    name: "Application Number",
                  },
                  value: applicationNo,
                },
                {
                  descriptor: { code: "message", name: "Message" },
                  value: responseMessage,
                },
              ],
            },
          ],
        },
      },
    };
  }
}
