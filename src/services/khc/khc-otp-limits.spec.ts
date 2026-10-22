import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import axios from "axios";
import { KhcService } from "./khc.service";
import { KhcLookup } from "./khc-lookup";

jest.mock("axios");
const http = axios as jest.Mocked<typeof axios>;

const ok = (data: unknown = null) => ({ data: { status: "200 OK", data } });
const badOtp = () => Object.assign(new Error("bad"), { isAxiosError: true, response: { status: 400 } });

describe("KHC OTP limits", () => {
  let service: KhcService;
  let now: number;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    http.isAxiosError.mockImplementation(jest.requireActual("axios").isAxiosError);
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    service = new KhcService(
      new ConfigService({ KHC_BASE_URL: "https://khc.test/api", KHC_API_KEY: "k" })
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it("makes the farmer wait before a second OTP, then allows it", async () => {
    http.request.mockResolvedValue(ok());
    await service.sendOtp("tx", "9876543210");
    await expect(service.sendOtp("tx", "9876543210")).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("30 seconds"),
    });
    expect(http.request).toHaveBeenCalledTimes(1);
    now += 31_000;
    await service.sendOtp("tx", "9876543210");
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it("allows 3 OTPs an hour per number and a fresh hour after that", async () => {
    http.request.mockResolvedValue(ok());
    for (let i = 0; i < 3; i++) {
      await service.sendOtp("tx", "9876543210");
      now += 31_000;
    }
    await expect(service.sendOtp("tx", "9876543210")).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("after an hour"),
    });
    await service.sendOtp("tx2", "9000000000"); // another number is unaffected
    now += 60 * 60 * 1000;
    await service.sendOtp("tx", "9876543210");
  });

  it("does not count a failed send against the farmer", async () => {
    http.request.mockRejectedValueOnce(new Error("down"));
    await expect(service.sendOtp("tx", "9876543210")).rejects.toBeDefined();
    http.request.mockResolvedValueOnce(ok());
    await service.sendOtp("tx", "9876543210");
  });

  it("counts wrong OTPs, says how many tries are left, and locks after 5", async () => {
    http.request.mockResolvedValueOnce(ok());
    await service.sendOtp("tx", "9876543210");
    for (const left of ["4 tries", "3 tries", "2 tries", "1 try"]) {
      http.request.mockRejectedValueOnce(badOtp());
      await expect(service.verifyOtp("tx", "9876543210", "111111")).rejects.toMatchObject({
        code: "invalid_otp",
        message: expect.stringContaining(left),
      });
    }
    http.request.mockRejectedValueOnce(badOtp());
    await expect(service.verifyOtp("tx", "9876543210", "111111")).rejects.toMatchObject({
      code: "rate_limited",
    });
    const calls = http.request.mock.calls.length;
    await expect(service.verifyOtp("tx", "9876543210", "222222")).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("new OTP"),
    });
    expect(http.request.mock.calls.length).toBe(calls); // locked: KHC is not even asked
  });

  it("a new OTP resets the wrong-try count", async () => {
    http.request.mockResolvedValueOnce(ok());
    await service.sendOtp("tx", "9876543210");
    http.request.mockRejectedValueOnce(badOtp());
    await expect(service.verifyOtp("tx", "9876543210", "111111")).rejects.toBeDefined();
    now += 31_000;
    http.request.mockResolvedValueOnce(ok());
    await service.sendOtp("tx", "9876543210");
    http.request.mockResolvedValueOnce(ok({ mobile: "9876543210", isRegistered: true, token: "t" }));
    await expect(service.verifyOtp("tx", "9876543210", "123456")).resolves.toBe(true);
  });

  it("a network error is not a wrong OTP", async () => {
    http.request.mockResolvedValueOnce(ok());
    await service.sendOtp("tx", "9876543210");
    for (let i = 0; i < 6; i++) {
      http.request.mockRejectedValueOnce(new Error("down"));
      await expect(service.verifyOtp("tx", "9876543210", "111111")).rejects.toMatchObject({
        code: "upstream_error",
      });
    }
  });

  it("limits can be changed with env settings", async () => {
    service = new KhcService(
      new ConfigService({
        KHC_BASE_URL: "https://khc.test/api", KHC_API_KEY: "k",
        KHC_OTP_RESEND_SECONDS: "5", KHC_OTP_MAX_SENDS_PER_HOUR: "1",
      })
    );
    http.request.mockResolvedValue(ok());
    await service.sendOtp("tx", "9876543210");
    now += 6_000;
    await expect(service.sendOtp("tx", "9876543210")).rejects.toMatchObject({
      message: expect.stringContaining("after an hour"),
    });
  });
});

describe("grievance tree when the scheme is not offered", () => {
  const lookup = (rows: Record<string, unknown[]>) =>
    new KhcLookup({ listAll: async (kind) => rows[kind] as Record<string, unknown>[] });
  const rows = {
    states: [{ stateid: 9, statename: "Uttar Pradesh" }],
    schemes: [{ scheme: 38, schemename: "AIF", division: 31 }, { scheme: 40, schemename: "PM-KISAN", division: 32 }],
  };

  it("says none matched, so the bot can explain and list what is available", async () => {
    const result = (await lookup(rows).grievanceTree({ stateName: "Uttar Pradesh", scheme: "Rythu Bandhu" })) as any;
    expect(result).toMatchObject({ needs: "scheme", match: "none" });
    expect(result.schemes.map((s: any) => s.name)).toEqual(["AIF", "PM-KISAN"]);
  });

  it("distinguishes no scheme named from an unclear one", async () => {
    expect(((await lookup(rows).grievanceTree({ stateName: "Uttar Pradesh" })) as any).match).toBe("unnamed");
    expect(((await lookup(rows).grievanceTree({ stateName: "Uttar Pradesh", scheme: "i" })) as any).match).toBe("several");
  });
});
