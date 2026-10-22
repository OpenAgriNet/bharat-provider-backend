import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { KhcService } from "./khc.service";
import { Logger } from "@nestjs/common";

jest.mock("axios");
const http = axios as jest.Mocked<typeof axios>;

const existing = {
  externalReferenceNo: "test-reference",
  farmerMobileNumber: "9876543210",
  farmerLanguage: "hi",
  stateId: 10,
  villageId: 219159,
  scheme: 38,
  division: 31,
  problemCategory: 39,
  problemSubCategory: 1725,
  farmerText: "Bank refused loan",
  farmerType: "existing",
};
const success = {
  status: "200 OK",
  message: "Grievance status fetched successfully",
  data: {
    grievanceNo: "BR/240926/2",
    currentStatus: "OPEN",
    currentLevel: "STATE",
  },
};

function body(values: Record<string, unknown>, action = "status") {
  return {
    context: { transaction_id: "tx", action },
    message: {
      order: {
        id: "tx",
        provider: { id: "khc-agri" },
        items: [{ id: "khc-grievance" }],
        fulfillments: [
          {
            customer: {
              person: {
                tags: Object.entries(values).map(([code, value]) => ({
                  descriptor: { code },
                  value: String(value),
                })),
              },
            },
          },
        ],
      },
    },
  };
}

describe("KhcService", () => {
  let service: KhcService;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    logError = jest
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    service = new KhcService(
      new ConfigService({
        KHC_BASE_URL: "https://khc.test/khc/api/api",
        KHC_API_KEY: "test-key",
      })
    );
    http.isAxiosError.mockImplementation(
      jest.requireActual("axios").isAxiosError
    );
    http.request.mockResolvedValue({ status: 200, data: success });
  });

  afterEach(() => jest.restoreAllMocks());

  async function verified(
    isRegistered = true,
    transactionId = "tx",
    mobile = "9876543210"
  ) {
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: null },
    });
    await service.sendOtp(transactionId, mobile);
    http.request.mockResolvedValueOnce({
      data: {
        status: "200 OK",
        data: { mobile, isRegistered, token: "test-token" },
      },
    });
    await service.verifyOtp(transactionId, mobile, "123456");
    http.request.mockClear();
  }

  it("sends the grievance number as a query parameter with ApiKey auth and no cookie", async () => {
    await expect(service.getStatus("BR/240926/2")).resolves.toEqual(
      success.data
    );
    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "https://khc.test/khc/api/api/v1/state/grievances/status",
        params: { grievanceNo: "BR/240926/2" },
        headers: {
          "Content-Type": "application/json",
          Authorization: "ApiKey test-key",
        },
        timeout: 20000,
      })
    );
  });

  it.each(["existing", "new"])(
    "creates a grievance for a %s farmer with numeric IDs",
    async (farmerType) => {
      await verified(farmerType === "existing");
      const input = {
        ...existing,
        farmerType,
        ...(farmerType === "new"
          ? { farmerName: "Test Farmer", gender: "M" }
          : {}),
      };
      await service.createGrievance(input, "tx");
      expect(http.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          data: expect.objectContaining({
            stateId: 10,
            farmerText: input.farmerText,
          }),
        })
      );
      const sent = http.request.mock.calls[0][0].data;
      expect(sent).not.toHaveProperty("farmerType");
      if (farmerType === "new")
        expect(sent).toHaveProperty("farmerName", "Test Farmer");
      else expect(sent).not.toHaveProperty("farmerName");
    }
  );

  it.each([
    { farmerMobileNumber: "abc" },
    { stateId: 0 },
    { scheme: "38junk" },
    { villageId: 1.2 },
    { problemCategory: true },
    { farmerText: "" },
    { farmerLanguage: "" },
    { externalReferenceNo: "" },
    { farmerType: "new" },
    { farmerType: "new", farmerName: "Test", gender: "invalid" },
  ])("rejects invalid creation input %j without HTTP", async (overrides) => {
    await verified(false);
    await expect(
      service.createGrievance({ ...existing, ...overrides }, "tx")
    ).rejects.toThrow();
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each(["", "abc\r\nInjected: yes", "a".repeat(101)])(
    "rejects invalid grievance number %j",
    async (number) => {
      await expect(service.getStatus(number)).rejects.toThrow();
      expect(http.request).not.toHaveBeenCalled();
    }
  );

  it("fails explicitly when configuration is missing", async () => {
    service = new KhcService(
      new ConfigService({ KHC_BASE_URL: "", KHC_API_KEY: "" })
    );
    await expect(service.getStatus("BR/240926/2")).rejects.toThrow(
      "not configured"
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { data: {} },
    { status: "400 BAD_REQUEST", message: "Invalid village" },
  ])("rejects malformed or failed API payloads %j", async (data) => {
    http.request.mockResolvedValue({ status: 200, data });
    await expect(service.getStatus("BR/240926/2")).rejects.toThrow();
  });

  it("reports not found and transport failures without exposing credentials", async () => {
    http.request.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404 },
    });
    await expect(service.getStatus("BR/240926/2")).rejects.toThrow("not found");
    http.request.mockRejectedValueOnce(new Error("secret URL or credentials"));
    await expect(service.getStatus("BR/240926/2")).rejects.toThrow(
      "could not be reached"
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain("secret");
  });

  it("does not retry a creation failure", async () => {
    await verified();
    http.request.mockRejectedValue(new Error("timeout"));
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "not confirmed"
    );
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("maps status into a Beckn order without echoing farmer inputs", async () => {
    const result = await service.handle(
      body({ grievanceNo: "BR/240926/2" }),
      "on_status"
    );
    expect(result.context.action).toBe("on_status");
    expect(result.message.order.tags[0].descriptor.code).toBe(
      "grievance_status"
    );
    expect(result.message.order.tags[0].list).toContainEqual({
      descriptor: { code: "currentStatus", name: "currentStatus" },
      value: "OPEN",
    });
    expect(result.message.order).not.toHaveProperty("fulfillments");
  });

  it("requires confirmation before registration", async () => {
    const result = await service.handle(
      body({ ...existing, request_type: "create_grievance" }, "init"),
      "on_init"
    );
    expect(result.message.order.items[0].tags[0].descriptor.code).toBe(
      "invalid_request"
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it("creates a grievance through on_init with confirmed inputs", async () => {
    await verified();
    const result = await service.handle(
      body(
        {
          ...existing,
          confirmed: "true",
          request_type: "create_grievance",
        },
        "init"
      ),
      "on_init"
    );
    expect(result.message.order.items[0].tags[0].descriptor.code).toBe(
      "grievance_created"
    );
    expect(http.request.mock.calls[0][0].data).toHaveProperty("stateId", 10);
  });

  it("rejects duplicate input tags and maps errors to failed Beckn responses", async () => {
    const input = body({ grievanceNo: "BR/240926/2" });
    input.message.order.fulfillments[0].customer.person.tags.push({
      descriptor: { code: "grievanceNo" },
      value: "OTHER",
    });
    const result = await service.handle(input, "on_status");
    expect(result.message.order.state).toBe("FAILED");
    expect(http.request).not.toHaveBeenCalled();
  });

  it("requires server-side OTP verification even with confirmed=true", async () => {
    const result = await service.handle(
      body({
        ...existing,
        confirmed: "true",
        request_type: "create_grievance",
      }),
      "on_init"
    );
    expect(result.message.order.items[0].tags[0].descriptor.code).toBe(
      "otp_required"
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it("sends then verifies OTP without exposing tokens, OTP or mobile in Beckn responses", async () => {
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: null },
    });
    const sent = await service.handle(
      body({
        request_type: "get_otp",
        farmerMobileNumber: "9876543210",
      }),
      "on_init"
    );
    expect(sent.message.order.items[0].tags[0].descriptor.code).toBe(
      "otp_sent"
    );
    http.request.mockResolvedValueOnce({
      data: {
        status: "200 OK",
        data: {
          mobile: "9876543210",
          isRegistered: false,
          token: "secret-login-token",
        },
      },
    });
    const result = await service.handle(
      body({
        request_type: "verify_otp",
        farmerMobileNumber: "9876543210",
        otp: "123456",
      }),
      "on_init"
    );
    expect(result.message.order.items[0].tags[0].descriptor.code).toBe(
      "otp_verified"
    );
    expect(result.message.order.items[0].tags[0].list[0].value).toBe("false");
    for (const secret of ["123456", "secret-login-token", "9876543210"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(http.request.mock.calls[1][0].data).toEqual({
      mobile: "9876543210",
      otp: "123456",
    });
  });

  it("rejects verification without OTP sending", async () => {
    await expect(
      service.verifyOtp("tx", "9876543210", "123456")
    ).rejects.toThrow("Send and verify");
    expect(http.request).not.toHaveBeenCalled();
  });

  it("binds proof to mobile and transaction and expires after five minutes", async () => {
    jest.useFakeTimers();
    try {
      await verified();
      await expect(
        service.createGrievance(
          { ...existing, farmerMobileNumber: "9876543211" },
          "tx"
        )
      ).rejects.toThrow("Send and verify");
      await expect(service.createGrievance(existing, "other")).rejects.toThrow(
        "Send and verify"
      );
      jest.advanceTimersByTime(300001);
      await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
        "Send and verify"
      );
      expect(http.request).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("invalidates verification when an OTP is resent", async () => {
    await verified();
    // Past the resend timer, so the second OTP is allowed.
    jest.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: null },
    });
    await service.sendOtp("tx", "9876543210");
    http.request.mockClear();
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "Send and verify"
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it("does not accept a forged existing-farmer flag for a new farmer", async () => {
    await verified(false);
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "farmerName"
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each(["bad", "12345", "1234567"])(
    "rejects malformed OTP %s",
    async (otp) => {
      http.request.mockResolvedValueOnce({
        data: { status: "200 OK", data: null },
      });
      await service.sendOtp("tx", "9876543210");
      http.request.mockClear();
      await expect(service.verifyOtp("tx", "9876543210", otp)).rejects.toThrow(
        "6-digit"
      );
      expect(http.request).not.toHaveBeenCalled();
    }
  );

  it("rejects a malformed verification response", async () => {
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: null },
    });
    await service.sendOtp("tx", "9876543210");
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: {} },
    });
    await expect(
      service.verifyOtp("tx", "9876543210", "123456")
    ).rejects.toThrow("invalid OTP verification");
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "Send and verify"
    );
  });

  it("returns reference options with paging and scheme division IDs", async () => {
    http.request.mockResolvedValueOnce({
      data: {
        status: "200 OK",
        data: [
          {
            scheme: 38,
            schemename: "Agriculture Infrastructure Fund (AIF)",
            division: 31,
            divisionname: "Others",
          },
        ],
      },
    });
    const result = await service.getReference("schemes", "10", "AIF");
    expect(result).toHaveProperty("total", 1);
    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        url: "https://khc.test/khc/api/api/v1/state/reference/schemes",
        params: { stateId: 10 },
      })
    );
    expect(result.options).toEqual([
      expect.objectContaining({ scheme: 38, division: 31 }),
    ]);
  });

  it.each(["uttarpradesh", " UTTAR  PRADESH ", "uttar\tpradesh"])(
    "matches state spacing and case variations: %s",
    async (name) => {
      const state = { stateid: 9, statename: "Uttar Pradesh" };
      http.request.mockResolvedValueOnce({
        data: {
          status: "200 OK",
          data: [state, { stateid: 10, statename: "Bihar" }],
        },
      });
      await expect(service.getReference("states", undefined, name)).resolves.toEqual({
        options: [state], total: 1, page: 1,
      });
    }
  );

  it("preserves ambiguous name matches and original reference rows", async () => {
    const rows = [
      { villageid: 1, villagename: "Abu Pur" },
      { villageid: 2, villagename: "Abupur Kalan" },
      { villageid: 3, villagename: "Other Village" },
    ];
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: rows },
    });
    await expect(service.getReference("villages", 1067, "abupur")).resolves.toEqual({
      options: rows.slice(0, 2), total: 2, page: 1,
    });
  });

  it.each(["invalid", "__proto__"])(
    "rejects unrecognized reference %s",
    async (kind) => {
      await expect(service.getReference(kind)).rejects.toThrow("Unknown");
      expect(http.request).not.toHaveBeenCalled();
    }
  );

  it("validates reference parents and response rows", async () => {
    await expect(service.getReference("schemes", 0)).rejects.toThrow("stateId");
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: [{}] },
    });
    await expect(service.getReference("states")).rejects.toThrow(
      "invalid reference"
    );
  });

  it("routes reference lookups through on_init without OTP", async () => {
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: [{ stateid: 10, statename: "Bihar" }] },
    });
    const result = await service.handle(
      body({ request_type: "get_reference", reference_type: "states" }),
      "on_init"
    );
    expect(result.message.order.items[0].tags[0].descriptor.code).toBe(
      "khc_reference"
    );
  });

  it.each([
    "not-a-url",
    "http://khc.test",
    "https://user:password@khc.test",
    "https://khc.test?key=bad",
  ])("rejects unsafe base URL %s before HTTP", async (url) => {
    service = new KhcService(
      new ConfigService({ KHC_BASE_URL: url, KHC_API_KEY: "test-key" })
    );
    await expect(service.getStatus("BR/240926/2")).rejects.toThrow(
      "valid HTTPS URL"
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it("distinguishes rejected details from unconfirmed submissions", async () => {
    await verified();
    http.request.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 400 },
    });
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "rejected the grievance details"
    );
    http.request.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404 },
    });
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "no assigned officer"
    );
  });

  it("reports rejected OTP without marking the mobile verified", async () => {
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: null },
    });
    await service.sendOtp("tx", "9876543210");
    http.request.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401 },
    });
    await expect(
      service.verifyOtp("tx", "9876543210", "123456")
    ).rejects.toThrow("The OTP is not correct. You have 4 tries left.");
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "Send and verify"
    );
  });

  it("rejects success envelopes with missing grievance details", async () => {
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: {} },
    });
    await expect(service.getStatus("BR/240926/2")).rejects.toThrow(
      "incomplete grievance"
    );
    await verified();
    http.request.mockResolvedValueOnce({
      data: { status: "200 OK", data: {} },
    });
    await expect(service.createGrievance(existing, "tx")).rejects.toThrow(
      "not confirmed"
    );
  });

  it("rejects unsupported language and invalid new-farmer gender", async () => {
    await verified(false);
    await expect(
      service.createGrievance({ ...existing, farmerLanguage: "zz" }, "tx")
    ).rejects.toThrow("language");
    await expect(
      service.createGrievance(
        {
          ...existing,
          farmerName: "Test",
          gender: "X",
        },
        "tx"
      )
    ).rejects.toThrow("gender code");
  });

  it("requires transaction IDs and recognized request types", async () => {
    await expect(service.sendOtp("", "9876543210")).rejects.toThrow(
      "transaction ID"
    );
    const input = body({
      request_type: "get_otp",
      farmerMobileNumber: "9876543210",
    });
    input.context.transaction_id = "";
    const missing = await service.handle(input, "on_init");
    expect(missing.message.order.items[0].tags[0].descriptor.code).toBe(
      "invalid_request"
    );
    const unknown = await service.handle(
      body({ request_type: "unknown" }),
      "on_init"
    );
    expect(unknown.message.order.items[0].tags[0].descriptor.code).toBe(
      "invalid_request"
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it("pages reference rows without losing IDs or returning more than fifty", async () => {
    http.request.mockResolvedValueOnce({
      data: {
        status: "200 OK",
        data: Array.from({ length: 51 }, (_, index) => ({
          stateid: index + 1,
          statename: `State ${index + 1}`,
        })),
      },
    });
    const result = await service.getReference("states", undefined, "", "2");
    expect(result).toEqual({
      options: [{ stateid: 51, statename: "State 51" }],
      total: 51,
      page: 2,
    });
  });
});
