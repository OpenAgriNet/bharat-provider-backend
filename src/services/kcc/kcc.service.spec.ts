import axios from "axios";
import { KccError, KccService } from "./kcc.service";
import { LoggerService } from "../logger/logger.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

/** Test-only keys; the real ones live in KCC_SECRET_KEY / KCC_IV. */
const ENV: Record<string, string> = {
  KCC_BASE_URL: "https://kcc.test/kccintegration/",
  KCC_SECRET_KEY: "0123456789abcdef0123456789abcdef",
  KCC_IV: "fedcba9876543210",
  KCC_ENTITY_TYPE: "entity",
  KCC_USER_ID: "user",
  KCC_PASSWORD: "pass",
};

const TOKEN_RESPONSE = {
  data: { status: true, data: { token: "gen-token", sessionTTL: 3600 }, error: "" },
};

/** Decrypted shape of the documented applicationStatus sample response. */
const APPLICATION_STATUS = {
  farmerName: "deepak kesare",
  applicationNo: "26000000271",
  applicationCurrentStatus: "APPROVED",
  requiredLoanAmount: 200000,
  sanctionedAmount: 10000,
  updatedAt: "2026-08-17 15:46:22",
  bankName: "Shri Rajkot District Co-operative Bank Ltd.",
  branchName: "MOTI KHILORI",
  rejectionReason: null,
  rejectedBy: null,
  applicationCreatedBy: "Farmer",
  remark: "Congratulations.Your loan has been approved on 17 August 2026.",
  applicationStatusHistory: [
    { createdAt: "2026-08-05 14:51:55", applicationStatus: "SUBMITED" },
    { createdAt: "2026-08-17 15:46:22", applicationStatus: "APPROVED" },
  ],
  activities: {
    cropHusbandryDetails: [
      {
        cropName: "Date Palm/ Khajoor",
        season: "Rabi",
        surveyNumber: "75",
        subDivisionNumber: "45",
        landArea: 2.3,
        cropStateName: "GUJARAT",
        cropDistrictName: "Rajkot",
        cropVillageName: "Bhadajaliya",
      },
    ],
    animalHusbandryDetails: [
      {
        activityName: "Sheep Farming",
        unitCount: 4,
        animalStateName: "GUJARAT",
        animalDistrictName: "Rajkot",
        animalVillageName: "Bhadajaliya",
      },
    ],
  },
};

const httpError = (status: number, data: any) => {
  const err: any = new Error(`HTTP ${status}`);
  err.response = { status, data };
  return err;
};

describe("KccService", () => {
  let service: KccService;
  let env: Record<string, string>;

  const build = () =>
    new KccService(
      { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as unknown as LoggerService,
      { get: (key: string) => env[key] } as any
    );

  const encrypted = (payload: unknown) => ({
    data: { status: true, data: service.encrypt(payload), error: "" },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    env = { ...ENV };
    service = build();
  });

  it("round-trips a payload through AES-256-CBC hex", () => {
    const payload = { mobileNumber: "9797396386", otpFor: "krishika" };
    const hex = service.encrypt(payload);

    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(service.decrypt(hex)).toEqual(payload);
  });

  describe("requestOtp", () => {
    it("sends the encrypted mobile with the token header and returns the requestID", async () => {
      mockedAxios.request.mockResolvedValueOnce(TOKEN_RESPONSE as any).mockResolvedValue(
        encrypted({
          requestID: "req-1",
          message: "OTP sent successfully",
          expiresIn: "15 mins",
        }) as any
      );

      await expect(service.requestOtp("9797396386")).resolves.toEqual({
        requestId: "req-1",
        message: "OTP sent successfully",
        expiresIn: "15 mins",
      });

      const config = mockedAxios.request.mock.calls[1][0] as any;
      expect(config.url).toBe("https://kcc.test/kccintegration/auth/requestOtp");
      expect(config.headers.token).toBe("gen-token");
      expect(service.decrypt(config.data.data)).toEqual({
        mobileNumber: "9797396386",
        otpFor: "krishika",
      });
    });

    it("passes the portal's error text through on status false", async () => {
      mockedAxios.request.mockResolvedValueOnce(TOKEN_RESPONSE as any).mockResolvedValue({
        data: { status: false, data: null, error: "Mobile number not registered" },
      } as any);

      await expect(service.requestOtp("9797396386")).rejects.toThrow(
        new KccError("Mobile number not registered")
      );
    });

    it("passes the portal's error text through on an HTTP error", async () => {
      mockedAxios.request.mockResolvedValueOnce(TOKEN_RESPONSE as any).mockRejectedValue(
        httpError(400, { status: false, error: "Invalid request" })
      );

      await expect(service.requestOtp("9797396386")).rejects.toThrow(
        "Invalid request"
      );
    });

    it("refuses to run without valid encryption keys", async () => {
      env.KCC_SECRET_KEY = "short";

      await expect(service.requestOtp("9797396386")).rejects.toThrow(
        /KCC encryption is not configured/
      );
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });
  });

  describe("getApplications", () => {
    it("sends requestID and a numeric OTP, and maps the decrypted application", async () => {
      mockedAxios.request.mockResolvedValueOnce(TOKEN_RESPONSE as any).mockResolvedValue(encrypted(APPLICATION_STATUS) as any);

      const applications = await service.getApplications("req-1", "741656");

      expect(applications).toHaveLength(1);
      const [status] = applications;
      const config = mockedAxios.request.mock.calls[1][0] as any;
      expect(config.url).toBe(
        "https://kcc.test/kccintegration/bharatVistaar/krishika/applicationStatus"
      );
      expect(service.decrypt(config.data.data)).toEqual({
        requestID: "req-1",
        otp: 741656,
      });

      expect(status).toMatchObject({
        applicationNo: "26000000271",
        applicationCurrentStatus: "APPROVED",
        sanctionedAmount: 10000,
        rejectionReason: null,
      });
      expect(status.applicationStatusHistory).toHaveLength(2);
      expect(status.cropHusbandryDetails[0].cropName).toBe("Date Palm/ Khajoor");
      expect(status.animalHusbandryDetails[0].unitCount).toBe(4);
    });

    it("treats a null history and missing activities as empty lists", async () => {
      mockedAxios.request.mockResolvedValueOnce(TOKEN_RESPONSE as any).mockResolvedValue(
        encrypted({
          ...APPLICATION_STATUS,
          applicationStatusHistory: null,
          activities: undefined,
        }) as any
      );

      const [status] = await service.getApplications("req-1", "741656");

      expect(status.applicationStatusHistory).toEqual([]);
      expect(status.cropHusbandryDetails).toEqual([]);
      expect(status.animalHusbandryDetails).toEqual([]);
    });

    it("returns every application when the portal sends an array", async () => {
      mockedAxios.request.mockResolvedValueOnce(TOKEN_RESPONSE as any).mockResolvedValue(
        encrypted([
          APPLICATION_STATUS,
          { ...APPLICATION_STATUS, applicationNo: "26000170989", applicationCurrentStatus: "DRAFT" },
        ]) as any
      );

      const applications = await service.getApplications("req-1", "741656");

      expect(applications.map((a) => a.applicationNo)).toEqual([
        "26000000271",
        "26000170989",
      ]);
    });

    it("unwraps an object carrying an applications array", async () => {
      mockedAxios.request.mockResolvedValueOnce(TOKEN_RESPONSE as any).mockResolvedValue(
        encrypted({ applications: [APPLICATION_STATUS] }) as any
      );

      const applications = await service.getApplications("req-1", "741656");

      expect(applications.map((a) => a.applicationNo)).toEqual(["26000000271"]);
    });
  });

  describe("token", () => {
    const tokenResponse = TOKEN_RESPONSE;
    const otpResponse = () =>
      encrypted({ requestID: "req-1", message: "OTP sent successfully" });

    it("generates a token from credentials once and reuses it", async () => {
      mockedAxios.request
        .mockResolvedValueOnce(tokenResponse as any)
        .mockResolvedValueOnce(otpResponse() as any)
        .mockResolvedValueOnce(otpResponse() as any);

      await service.requestOtp("9797396386");
      await service.requestOtp("9797396386");

      const calls = mockedAxios.request.mock.calls.map((c) => c[0] as any);
      expect(calls).toHaveLength(3);
      expect(calls[0].url).toBe("https://kcc.test/kccintegration/auth/token");
      expect(calls[0].data).toBe("entityType=entity&userID=user&password=pass");
      expect(calls[1].headers.token).toBe("gen-token");
      expect(calls[2].headers.token).toBe("gen-token");
    });

    it("regenerates the token after a 401", async () => {
      mockedAxios.request
        .mockResolvedValueOnce(tokenResponse as any)
        .mockRejectedValueOnce(httpError(401, { status: false, error: "Invalid token" }))
        .mockResolvedValueOnce(tokenResponse as any)
        .mockResolvedValueOnce(otpResponse() as any);

      await expect(service.requestOtp("9797396386")).rejects.toThrow("Invalid token");
      await service.requestOtp("9797396386");

      const urls = mockedAxios.request.mock.calls.map((c) => (c[0] as any).url);
      expect(urls.filter((u: string) => u.endsWith("/auth/token"))).toHaveLength(2);
    });

    it("fails clearly when credentials are not configured", async () => {
      delete env.KCC_USER_ID;

      await expect(service.requestOtp("9797396386")).rejects.toThrow(
        /KCC credentials are not configured/
      );
    });
  });
});
