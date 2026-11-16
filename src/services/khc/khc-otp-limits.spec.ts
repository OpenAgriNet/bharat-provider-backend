import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import axios from "axios";
import { KhcService } from "./khc.service";
import { KhcLookup, suggestCategory, suggestSubCategory } from "./khc-lookup";

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

describe("suggestCategory", () => {
  const tree = [
    { id: 39, name: "Bank Loan Sanction Issues", subCategories: [
      { id: 1725, name: "Bank refused loan under AIF" },
      { id: 1726, name: "Loan sanction delay" },
      { id: 1727, name: "Excess collateral demanded" },
    ] },
    { id: 41, name: "Fund Disbursement Issues", subCategories: [
      { id: 1801, name: "Subsidy not received" },
      { id: 1802, name: "Payment delay" },
    ] },
  ];

  it("picks the sub-category whose words the complaint uses", () => {
    expect(suggestCategory("The bank refused my loan", tree)).toEqual({
      category: { id: 39, name: "Bank Loan Sanction Issues" },
      subCategory: { id: 1725, name: "Bank refused loan under AIF" },
    });
    expect(suggestCategory("subsidy not received for 6 months", tree)?.subCategory.id).toBe(1801);
  });

  it("a farmer who names the category gets that category even if no sub-category stands out", () => {
    expect(suggestCategory("bank loan sanction issue", tree)).toEqual({
      category: { id: 39, name: "Bank Loan Sanction Issues" },
      subCategory: null,
    });
    // "issue" and "issues" are the same word
    expect(suggestCategory("fund disbursement issues", tree)?.category.id).toBe(41);
  });

  it.each(["bank loan sanction issue", "Bank Loan Sanction Issues"])(
    "matches %s against the full reported category list without guessing a sub-category",
    (concern) => {
      const categories = [
        ...tree,
        ...[
          "Credit Guarantee Coverage Issues",
          "Infrastructure Implementation Issues",
          "Interest Subvention Issues",
          "Monitoring & Reporting Issues",
          "Nodal Agency / Department Issues",
          "Portal / Technical Issues",
          "Project Appraisal & Approval Issues",
          "Registration & Application Issues",
        ].map((name, index) => ({ id: 100 + index, name, subCategories: [] })),
      ];
      expect(categories).toHaveLength(10);
      expect(suggestCategory(concern, categories)).toEqual({
        category: { id: 39, name: "Bank Loan Sanction Issues" },
        subCategory: null,
      });
    }
  );

  it("the category name alone does not override a clearly matching sub-category", () => {
    const hit = suggestCategory("bank refused my loan", tree)!;
    expect(hit.category.id).toBe(39);
    expect(hit.subCategory?.id).toBe(1725);
  });

  it("returns no lexical hint when keyword evidence is unclear", () => {
    expect(suggestCategory("my crop was damaged by rain", tree)).toBeNull();
    expect(suggestCategory("", tree)).toBeNull();
    expect(suggestCategory("delay", tree)).toBeNull(); // fits two sub-categories equally
  });

  it.each(["bank refused my loan", "loan refused", "loan denied"])("grievanceTree returns the full catalogue for '%s'", async (concern) => {
    const lookup = new KhcLookup({
      listAll: async (kind, parent) => {
        if (kind === "states") return [{ stateid: 9, statename: "Uttar Pradesh" }];
        if (kind === "schemes") return [{ scheme: 38, schemename: "AIF", division: 31 }];
        if (kind === "categories") {
          return tree.map((c) => ({ problemcategory: c.id, categoryname: c.name }));
        }
        return tree
          .find((c) => c.id === parent)!
          .subCategories.map((x) => ({ problemsubcategory: x.id, subcategoryname: x.name }));
      },
    });
    const withConcern = await lookup.grievanceTree({ stateName: "Uttar Pradesh", scheme: "AIF", concern });
    expect(withConcern.categories).toEqual(tree);
    if (concern === "bank refused my loan") {
      expect(withConcern.suggested).toEqual({
        category: { id: 39, name: "Bank Loan Sanction Issues" },
        subCategory: { id: 1725, name: "Bank refused loan under AIF" },
      });
    }
    const without = (await lookup.grievanceTree({ stateName: "Uttar Pradesh", scheme: "AIF" })) as any;
    expect(without.suggested).toBeUndefined();
    const vague = (await lookup.grievanceTree({ stateName: "Uttar Pradesh", scheme: "AIF", concern: "rain damaged crop" })) as any;
    expect(vague.suggested).toBeUndefined();
    expect(vague.categories).toHaveLength(2);
  });
});

describe("location: a district that did not match is listed, not ignored", () => {
  const lookup = new KhcLookup({
    listAll: async (kind) =>
      ({
        states: [{ stateid: 9, statename: "Uttar Pradesh" }],
        districts: [
          { districtid: 221, districtname: "Ghaziabad" },
          { districtid: 222, districtname: "Ghazipur" },
          { districtid: 223, districtname: "Meerut" },
        ],
        "sub-districts": [],
      } as Record<string, Record<string, unknown>[]>)[kind] ?? [],
  });

  it("several districts match: only those are offered", async () => {
    const result = (await lookup.findLocation({ name: "abupur", stateName: "Uttar Pradesh", districtName: "ghazi" })) as any;
    expect(result.needs).toBe("district");
    expect(result.matches.map((m: any) => m.name)).toEqual(["Ghaziabad", "Ghazipur"]);
  });

  it("nothing matches: the state's districts are offered", async () => {
    const result = (await lookup.findLocation({ name: "abupur", stateName: "Uttar Pradesh", districtName: "zzzzzz" })) as any;
    expect(result.needs).toBe("district");
    expect(result.matches).toHaveLength(3);
    expect(result.state).toMatchObject({ id: 9 });
  });

  it("one district matches (spelling and spacing ignored): carries on, nothing is listed", async () => {
    const result = (await lookup.findLocation({ name: "abupur", stateName: "uttarpradesh", districtName: "MEERUT" })) as any;
    expect(result.district).toEqual({ id: 223, name: "Meerut" });
    expect(result.needs).toBe("geocode"); // district understood; this village is not in the fake data
  });
});

describe("matching survives typos and keeps negations", () => {
  const pm = [
    { id: 50, name: "Delay in receiving benefit", subCategories: [
      { id: 501, name: "Installment not received" },
      { id: 502, name: "Benefits received in wrong account" },
      { id: 503, name: "Payment delayed after approval" },
    ] },
    { id: 51, name: "Technical Issue with PM-KISAN Portal", subCategories: [{ id: 511, name: "Portal not opening" }] },
  ];

  it("'installment not recieved' (typo) matches 'Installment not received' straight away", () => {
    expect(suggestCategory("installment not recieved", pm)).toEqual({
      category: { id: 50, name: "Delay in receiving benefit" },
      subCategory: { id: 501, name: "Installment not received" },
    });
  });

  it("'not' is kept, so 'not received' is not confused with 'received in wrong account'", () => {
    expect(suggestSubCategory("installment not received", pm[0]).subCategory?.id).toBe(501);
    expect(suggestSubCategory("money received in wrong account", pm[0]).subCategory?.id).toBe(502);
  });

  it("a vague complaint inside a chosen category gives no sub-category, so the farmer is asked", () => {
    expect(suggestSubCategory("problem with my money", pm[0]).subCategory).toBeNull();
    expect(suggestSubCategory("", pm[0]).subCategory).toBeNull();
    expect(suggestSubCategory("payment", pm[0]).category).toEqual({ id: 50, name: "Delay in receiving benefit" });
  });

  it("grievanceTree narrows to the picked category and picks the sub-category inside it", async () => {
    const lookup = new KhcLookup({
      listAll: async (kind, parent) => {
        if (kind === "states") return [{ stateid: 9, statename: "Uttar Pradesh" }];
        if (kind === "schemes") return [{ scheme: 40, schemename: "PM-KISAN", division: 32 }];
        if (kind === "categories") return pm.map((c) => ({ problemcategory: c.id, categoryname: c.name }));
        return pm.find((c) => c.id === parent)!.subCategories.map((x) => ({ problemsubcategory: x.id, subcategoryname: x.name }));
      },
    });
    const picked = (await lookup.grievanceTree({
      stateName: "Uttar Pradesh", scheme: "pm kisan", concern: "installment not received", category: "delay in receiving benefit",
    })) as any;
    expect(picked.categories).toHaveLength(1);
    expect(picked.suggested.subCategory).toEqual({ id: 501, name: "Installment not received" });
    const vague = (await lookup.grievanceTree({
      stateName: "Uttar Pradesh", scheme: "pm kisan", concern: "problem with money", category: "Delay in receiving benefit",
    })) as any;
    expect(vague.suggested.subCategory).toBeNull();
    expect(vague.categories[0].subCategories).toHaveLength(3);
    const unknown = (await lookup.grievanceTree({
      stateName: "Uttar Pradesh", scheme: "pm kisan", concern: "x", category: "no such category",
    })) as any;
    expect(unknown.categories).toHaveLength(2); // not narrowed
  });
});
