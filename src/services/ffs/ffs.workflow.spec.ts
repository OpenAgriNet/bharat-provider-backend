import * as crypto from "crypto";
import { FfsSessionStore } from "./ffs-session.store";
import { FfsConfig, FfsHttp, FfsWorkflow } from "./ffs.workflow";
import { FfsService } from "./ffs.service";

const KEY = "K".repeat(32);
const IV = "I".repeat(16);
const config: FfsConfig = { baseUrl: "https://ffs.test", esaKey: KEY, esaIv: IV, appVersion: "1", timeoutMs: 1000 };
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `h.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

const land = {
  farmlandPlotRegistryId: 1,
  farmlandOwnershipId: 2,
  stateLgdCode: 9,
  districtLgdCode: 3,
  subDistrictLgdCode: 4,
  villageLgdCode: 5,
  villageName: "Rampur",
  surveyNumber: "12",
  landAreaHectares: 1.5,
  crops: [],
};
const ok = (data: any, extra: any = {}) => ({ status: 200, body: { code: 200, data, ...extra } });

/** A fake FFS: handlers by path, every call recorded. */
function fakeFfs(overrides: Record<string, (request: any) => { status: number; body: any }> = {}) {
  const calls: any[] = [];
  const handlers: Record<string, (request: any) => { status: number; body: any }> = {
    "/authenticate/user/loginByFarmerId": () => ok(null),
    "/authenticate/user/validateLoginByFarmerId": () =>
      ok({ userToken: TOKEN, userId: 7, userAadhaarHash: "hash", userFullName: "Ram", userMobileNumber: "9999999999" }),
    "/common/getCurrentSeasonAndYear": () => ok({ season: { seasonId: 1 }, year: { yearId: 2026 } }),
    "/bharatVistar/applicantFetch": () => ok({ landData: [land] }),
    "/common/getCropListByState": () =>
      ok([
        { cropCode: "0101900", cropName: "Wheat", extra: 1 },
        { cropCode: "0100100", cropName: "Bajra" },
      ]),
    "/applicant/land/crop/add": (r) => ok({ cropCode: r.json.cropCode, farmlandPlotRegistryId: 1 }),
    "/fertilizerRecommendation/getRecommendationsByGFRV4": () =>
      ok([
        {
          gfrType: "X",
          recommendations: [
            { productGroupId: 11, offeredBags: 3, kgPerBag: 45 },
            { productGroupId: 12, offeredBags: 2, kgPerBag: 50 },
          ],
        },
      ]),
    "/product/getProductsByAvailability": () =>
      ok([
        { productId: 1089, productGroupId: 11, productName: "Neem Coated Urea", bagWeightKg: 45, plantId: 100 },
        { productId: 1005, productGroupId: 12, productName: "DAP", bagWeightKg: 50, plantId: 101 },
      ]),
    "/retailer/getRetailersByProductAvailabilityV4": () =>
      ok(
        [
          { retailerId: 5, retailerName: "Far", availableProducts: [{ productGroupId: 11, products: [{ productId: 1089, noBagsAvailable: 1 }] }] },
          { retailerId: 6, retailerName: "Near", availableProducts: [{ productGroupId: 11, products: [{ productId: 1089, noBagsAvailable: 50 }] }, { productGroupId: 12, products: [{ productId: 1005, noBagsAvailable: 5 }] }] },
          { retailerId: 7, retailerName: "None", availableProducts: [] },
        ],
        { totalPages: 1 }
      ),
    "/bharatVistar/createMultipleBookingV2": () =>
      ok(
        {
          isValid: true,
          totalBookingsSuccessful: 1,
          totalBookingsFailed: 0,
          bookingResults: [{ retailerId: 6, isValid: true, procurementId: 9, procurementApplicationCode: "C1", isWaitlisted: false, expiryDatetime: "soon", totalBagsRequested: 2 }],
        },
        { status: "SUCCESS" }
      ),
    ...overrides,
  };
  const http: FfsHttp = async (request) => {
    const path = Object.keys(handlers).find((p) => request.url.endsWith(p));
    let json: any;
    let decrypted: string | undefined;
    if (request.url.includes("/authenticate/")) {
      const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(KEY), Buffer.from(IV));
      decrypted = Buffer.concat([decipher.update(Buffer.from(request.data, "base64")), decipher.final()]).toString();
      json = JSON.parse(decrypted);
    } else if (request.data) json = JSON.parse(request.data);
    calls.push({ path, headers: request.headers, json, params: request.params });
    const reply = handlers[path](Object.assign({}, request, { json }));
    return { status: reply.status, text: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body) };
  };
  return { http, calls };
}

function session(http: FfsHttp, store = new FfsSessionStore(), id = "s1") {
  let turn = 0;
  const run = async (operation: string, args: any = {}) => {
    const workflow = new FfsWorkflow(id, `q${++turn}`, store, config, http);
    return { answer: await workflow.run(operation, args), workflow };
  };
  return { run, store };
}

async function loggedIn(http: FfsHttp) {
  const s = session(http);
  await s.run("send_otp", { farmer_id: "12345678901", state_lgd_code: "9" });
  const { answer } = await s.run("verify_otp", { otp: "001234" });
  return { ...s, farmer: answer };
}

describe("FFS login", () => {
  it("rejects an unknown state or malformed Farmer ID without calling FFS", async () => {
    const { http, calls } = fakeFfs();
    const { run } = session(http);
    expect((await run("send_otp", { farmer_id: "123", state_lgd_code: "9" })).answer.status).toBe("needs_clarification");
    expect((await run("send_otp", { farmer_id: "12345678901", state_lgd_code: "99" })).answer.status).toBe("needs_clarification");
    expect(calls).toHaveLength(0);
  });

  it("sends an encrypted OTP request once per turn and loads the farmer after verification", async () => {
    const { http, calls } = fakeFfs();
    const { run, store } = session(http);
    const sent = await run("send_otp", { farmer_id: "12345678901", state_lgd_code: "9" });
    expect(sent.answer.status).toBe("otp_sent");
    expect(calls[0].json).toEqual({ userStateLgdCode: "9", userFarmerId: "12345678901" });
    expect(calls[0].headers).toMatchObject({ appType: "APPLICANT", "X-Session-Id": "s1", version: "1" });
    expect(calls[0].headers.Authorization).toBeUndefined();

    expect((await run("send_otp", { farmer_id: "12345678901", state_lgd_code: "9" })).answer.status).toBe("already_started");
    expect((await run("verify_otp", { otp: "12" })).answer.status).toBe("needs_otp");

    const verified = await run("verify_otp", { otp: "001234" });
    expect(calls.find((c) => c.path.includes("validate")).json.otp).toBe("001234");
    expect(verified.answer.status).toBe("ok");
    expect(verified.answer.data.villages[0].plots[0]).toMatchObject({ land_ref: "land-1", survey: "12" });
    expect(verified.answer.data.common_crops).toEqual([{ crop_name: "wheat", crop_code: "0101900" }]);
    expect(JSON.stringify(verified.answer)).not.toContain(TOKEN);
    expect(store.get("s1").crops[0]).toEqual({ cropCode: "0101900", cropName: "Wheat" });
  });

  it("counts an invalid OTP and stops suggesting automatic retries after three", async () => {
    const { http } = fakeFfs({ "/authenticate/user/validateLoginByFarmerId": () => ({ status: 400, body: { message: "bad" } }) });
    const { run } = session(http);
    await run("send_otp", { farmer_id: "12345678901", state_lgd_code: "9" });
    let last: any;
    for (let i = 0; i < 3; i++) last = (await run("verify_otp", { otp: "111111" })).answer;
    expect(last.status).toBe("invalid_otp");
    expect(last.next_action).toContain("Three OTP verifications failed");
  });

  it("answers needs_otp without a session login", async () => {
    const { http } = fakeFfs();
    expect((await session(http).run("entitlement", { village_ref: "village-1", crop_name: "wheat" })).answer.status).toBe("needs_otp");
  });
});

describe("FFS entitlement", () => {
  it("writes the common crop on every plot in the village and returns the allowance", async () => {
    const { http, calls } = fakeFfs();
    const { run } = await loggedIn(http);
    const { answer } = await run("entitlement", { village_ref: "village-1", crop_name: "gehun", crop_code: "0101900" });
    expect(answer.status).toBe("ok");
    expect(answer.data.products).toEqual([
      { group: 11, name: "urea", bags: 3, kg_per_bag: 45 },
      { group: 12, name: "DAP", bags: 2, kg_per_bag: 50 },
    ]);
    expect(calls.filter((c) => c.path === "/applicant/land/crop/add")).toHaveLength(1);
    const again = await run("entitlement", { village_ref: "village-1", crop_name: "gehun", crop_code: "0101900" });
    expect(again.answer).toEqual(answer);
    expect(calls.filter((c) => c.path === "/applicant/land/crop/add")).toHaveLength(1);
  });

  it("asks the API to resolve free-text crops, writes nothing until matched, then uses the match", async () => {
    const { http, calls } = fakeFfs();
    const { run } = await loggedIn(http);
    const args = { village_ref: "village-1", crop_name: "bajri" };
    const ask = (await run("entitlement", args)).answer;
    expect(ask.status).toBe("needs_resolution");
    expect(ask.data).toMatchObject({ kind: "crops", names: ["bajri"], state_code: "9" });
    expect(ask.data.catalogue).toHaveLength(2);
    expect(calls.some((c) => c.path === "/applicant/land/crop/add")).toBe(false);

    const ambiguous = await run("entitlement", { ...args, resolution: [{ name: "bajri", status: "ambiguous", candidates: ["0100100"] }] });
    expect(ambiguous.answer.status).toBe("needs_clarification");
    expect(ambiguous.answer.data.crops[0].candidates).toEqual([{ crop_code: "0100100", crop_name: "Bajra" }]);

    const matched = await run("entitlement", { ...args, resolution: [{ name: "bajri", status: "matched", crop_code: "0100100" }] });
    expect(matched.answer.status).toBe("ok");
    expect(calls.find((c) => c.path === "/applicant/land/crop/add").json.cropCode).toBe("0100100");
  });

  it("never accepts a resolution code outside the state catalogue", async () => {
    const { http, calls } = fakeFfs();
    const { run } = await loggedIn(http);
    const { answer } = await run("entitlement", {
      village_ref: "village-1",
      crop_name: "x",
      resolution: [{ name: "x", status: "matched", crop_code: "9999999" }],
    });
    expect(answer.status).toBe("unavailable");
    expect(calls.some((c) => c.path === "/applicant/land/crop/add")).toBe(false);
  });

  it("keeps the village scope single and reports an unusable crop update as partial", async () => {
    const { http } = fakeFfs({ "/applicant/land/crop/add": () => ({ status: 500, body: { message: "no" } }) });
    const { run } = await loggedIn(http);
    const { answer } = await run("entitlement", { village_ref: "village-1", crop_name: "wheat", crop_code: "0101900" });
    expect(answer.status).toBe("partial_crop_update");
    expect(answer.data.affected_plot.land_ref).toBe("land-1");
  });
});

describe("FFS shops and booking", () => {
  const withEntitlement = async (overrides = {}) => {
    const fake = fakeFfs(overrides);
    const s = await loggedIn(fake.http);
    await s.run("entitlement", { village_ref: "village-1", crop_name: "wheat", crop_code: "0101900" });
    return { ...fake, ...s };
  };

  it("rejects an order above the GFR allowance and requires an order before searching", async () => {
    const { run } = await withEntitlement();
    expect((await run("find_shops", {})).answer.status).toBe("needs_order");
    const over = (await run("find_shops", { order: [{ product: "urea", product_id: 1089, bags: 4 }] })).answer;
    expect(over.status).toBe("needs_order");
    expect(over.data).toMatchObject({ allowed_bags: 3, requested_bags: 4 });
  });

  it("ranks full-supply shops first, hides stock volumes and skips shops without the product", async () => {
    const { run } = await withEntitlement();
    const { answer } = await run("find_shops", { order: [{ product: "urea", product_id: 1089, bags: 2 }] });
    expect(answer.status).toBe("ok");
    expect(answer.data.shops.map((s: any) => [s.number, s.name, s.supply])).toEqual([
      [1, "Near", "full"],
      [2, "Far", "partial"],
    ]);
    expect(JSON.stringify(answer)).not.toMatch(/"(stock|noBagsAvailable)"/);
  });

  it("asks the API to match a named fertilizer, then reuses the previous order's shops when unchanged", async () => {
    const { run, calls } = await withEntitlement();
    const ask = (await run("find_shops", { order: [{ product: "dap", bags: 1 }] })).answer;
    expect(ask.status).toBe("needs_resolution");
    expect(ask.data.kind).toBe("products");
    const matched = (await run("find_shops", { order: [{ product: "dap", bags: 1 }], resolution: [{ name: "dap", status: "matched", product_id: 1005 }] })).answer;
    expect(matched.status).toBe("ok");
    const probe = calls.filter((c) => c.path.includes("getRetailers")).pop();
    expect(probe.json.selectedProducts.map((p: any) => p.productId).sort()).toEqual([1005, 1089]);
    expect(probe.json.selectedProducts.every((p: any) => p.noBagsRequested === 1)).toBe(true);
  });

  it("books only after confirmation and returns the reference", async () => {
    const { run, calls } = await withEntitlement();
    await run("find_shops", { order: [{ product: "urea", product_id: 1089, bags: 2 }] });
    const preview = (await run("create_booking", { shop_ref: "retailer-6" })).answer;
    expect(preview.status).toBe("needs_confirmation");
    expect(calls.some((c) => c.path.includes("createMultipleBookingV2"))).toBe(false);
    expect((await run("create_booking", { shop_ref: "retailer-99", confirmed: true })).answer.status).toBe("needs_shops");

    const booked = (await run("create_booking", { shop_ref: "retailer-6", confirmed: true })).answer;
    expect(booked.status).toBe("ok");
    expect(booked.data.booking.bookings[0]).toMatchObject({ procurement_id: 9, booking_code: "C1", is_waitlisted: false });
    const payload = calls.find((c) => c.path.includes("createMultipleBookingV2")).json;
    expect(payload.bookingRequest[0]).toMatchObject({ retailerId: 6 });
    expect(payload.bookingRequest[0].productLines[0]).toMatchObject({ productId: 1089, plantId: 100, noBagsRequested: 2, totalQuantityKgRequested: 90 });
    expect(payload.requestedDatetime).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it("treats a FAILED envelope with null data as a rejection, and anything else as uncertain", async () => {
    const rejected = await withEntitlement({
      "/bharatVistar/createMultipleBookingV2": () => ({ status: 500, body: { code: 500, status: "FAILED", message: "existing booking", data: null } }),
    });
    await rejected.run("find_shops", { order: [{ product: "urea", product_id: 1089, bags: 1 }] });
    const failed = (await rejected.run("create_booking", { shop_ref: "retailer-6", confirmed: true })).answer;
    expect(failed.status).toBe("booking_failed");
    expect(failed.data.provider_error.message).toBe("existing booking");

    const garbled = await withEntitlement({ "/bharatVistar/createMultipleBookingV2": () => ({ status: 502, body: "<html>" }) });
    await garbled.run("find_shops", { order: [{ product: "urea", product_id: 1089, bags: 1 }] });
    expect((await garbled.run("create_booking", { shop_ref: "retailer-6", confirmed: true })).answer.status).toBe("booking_uncertain");
  });

  it("reports login expiry when FFS rejects the token and exposes workflow context", async () => {
    const { run } = await withEntitlement({ "/retailer/getRetailersByProductAvailabilityV4": () => ({ status: 401, body: {} }) });
    const context = (await run("context")).answer;
    expect(context).toMatchObject({ stage: "entitlement_ready", authenticated: true });
    expect(context.entitlement.products).toHaveLength(2);
    const expired = (await run("find_shops", { order: [{ product: "urea", product_id: 1089, bags: 1 }] })).answer;
    expect(expired.status).toBe("needs_otp");
    expect((await run("context")).answer).toMatchObject({ stage: "login_expired", authenticated: false });
  });
});

describe("FfsService Beckn handler", () => {
  const tag = (code: string, value: string) => ({ descriptor: { code }, value });
  const text = (value: any) => (typeof value === "string" ? value : JSON.stringify(value));
  const request = (operation: string, args: any, sessionId = "svc-1") => ({
    context: { transaction_id: "t", tags: { session_id: sessionId, question_id: "q1" } },
    message: {
      order: {
        provider: { id: "ffs-agri" },
        items: [{ id: "ffs-booking" }],
        fulfillments: [
          { customer: { person: { tags: [tag("request_type", operation), ...Object.entries(args).map(([k, v]) => tag(k, text(v)))] } } },
        ],
      },
    },
  });
  const outcome = (response: any) => response.message.order.items[0].tags[0];
  const make = () => {
    const service = new FfsService({ get: (name: string) => ({ FFS_BASE_URL: config.baseUrl, FFS_ESA_KEY: KEY, FFS_ESA_IV: IV }[name]) } as any, new FfsSessionStore());
    service.http = fakeFfs().http;
    return service;
  };

  it("returns the workflow result and diagnostics as one ffs_result tag", async () => {
    const service = make();
    const tagged = outcome(await service.handle(request("send_otp", { farmer_id: "12345678901", state_lgd_code: "9" })));
    expect(tagged.descriptor.code).toBe("ffs_result");
    const values = Object.fromEntries(tagged.list.map((e: any) => [e.descriptor.code, JSON.parse(e.value)]));
    expect(values.result).toMatchObject({ status: "otp_sent", source: "FFS" });
    expect(values.diagnostics.api_calls).toBe(1);
    const context = Object.fromEntries(outcome(await service.handle(request("context", {}))).list.map((e: any) => [e.descriptor.code, JSON.parse(e.value)]));
    expect(context.result.stage).toBe("otp_pending");
  });

  it("keeps sessions apart and refuses malformed requests", async () => {
    const service = make();
    await service.handle(request("send_otp", { farmer_id: "12345678901", state_lgd_code: "9" }));
    const other = outcome(await service.handle(request("context", {}, "svc-2")));
    expect(JSON.parse(other.list[0].value)).toEqual({});
    for (const bad of [request("drop_tables", {}), request("context", {}, ""), { ...request("context", {}), message: { order: {} } }]) {
      expect(outcome(await service.handle(bad)).descriptor.code).toBe("invalid_request");
    }
  });
});
