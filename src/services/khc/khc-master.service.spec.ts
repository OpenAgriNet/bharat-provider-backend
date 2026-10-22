import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import axios from "axios";
import { Pool } from "pg";
import { KhcMasterService } from "./khc-master.service";
import { KhcService } from "./khc.service";
import { KhcMasterSyncService } from "./khc-master-sync.service";
import { matchRows } from "./khc-lookup";

jest.mock("axios");
const http = axios as jest.Mocked<typeof axios>;

// Runs against a real Postgres that already has database/migrations/002_khc_master_data.sql
// applied. Set KHC_TEST_DB_HOST / _NAME / _USER / _PASSWORD (and optionally _PORT) to enable.
const host = process.env.KHC_TEST_DB_HOST;
const suite = host ? describe : describe.skip;

const villages = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    villageid: 1000 + index,
    villagename: index === 0 ? "Abu Pur" : index === 1 ? "100%_Done" : `Village ${index}`,
  }));
const api = (data: unknown[]) =>
  http.request.mockResolvedValueOnce({ data: { status: "200 OK", data } });

suite("KhcMasterService + DB-first getReference (real Postgres)", () => {
  let master: KhcMasterService;
  let service: KhcService;
  let admin: Pool;

  beforeAll(async () => {
    process.env.KHC_DB_HOST = host;
    process.env.KHC_DB_PORT = process.env.KHC_TEST_DB_PORT || "5432";
    process.env.KHC_DB_NAME = process.env.KHC_TEST_DB_NAME;
    process.env.KHC_DB_USER = process.env.KHC_TEST_DB_USER;
    process.env.KHC_DB_PASSWORD = process.env.KHC_TEST_DB_PASSWORD;
    admin = new Pool({
      host,
      port: parseInt(process.env.KHC_TEST_DB_PORT || "5432", 10),
      database: process.env.KHC_TEST_DB_NAME,
      user: process.env.KHC_TEST_DB_USER,
      password: process.env.KHC_TEST_DB_PASSWORD,
    });
    master = new KhcMasterService();
    await master.onModuleInit();
    expect(master.isReady()).toBe(true);
  });

  afterAll(async () => {
    await master.onModuleDestroy();
    await admin.end();
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    await admin.query(
      "TRUNCATE khc_state, khc_district, khc_sub_district, khc_village, khc_scheme, khc_category, khc_sub_category, khc_sync_state, khc_sync_job"
    );
    service = new KhcService(
      new ConfigService({ KHC_BASE_URL: "https://khc.test/api", KHC_API_KEY: "k" }),
      master
    );
  });

  it("second lookup is served from the DB without calling KHC", async () => {
    api(villages(3));
    const first = await service.getReference("villages", 1067);
    expect(http.request).toHaveBeenCalledTimes(1);
    const second = await service.getReference("villages", 1067);
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.options).toEqual(villages(3));
  });

  it("pages in API order and keeps the true total", async () => {
    api(villages(60));
    await service.getReference("villages", 1067);
    const page2 = await service.getReference("villages", 1067, "", 2);
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(page2.total).toBe(60);
    expect((page2.options as unknown[]).length).toBe(10);
    expect((page2.options as { villageid: number }[])[0].villageid).toBe(1050);
    const beyond = await service.getReference("villages", 1067, "", 3);
    expect(beyond).toEqual({ options: [], total: 60, page: 3 });
  });

  it("filters by name ignoring case and spaces, and treats % and _ literally", async () => {
    api(villages(5));
    await service.getReference("villages", 1067);
    const byName = await service.getReference("villages", 1067, "ABUPUR");
    expect(byName.total).toBe(1);
    const literal = await service.getReference("villages", 1067, "%");
    expect(literal.total).toBe(1);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("asks the API once when a name is not in the cache", async () => {
    api(villages(3));
    await service.getReference("villages", 1067);
    api([...villages(3), { villageid: 5000, villagename: "Brand New" }]);
    const result = await service.getReference("villages", 1067, "brandnew");
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(1);
    const again = await service.getReference("villages", 1067, "brandnew");
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(again.total).toBe(1);
  });

  it("serves stale cache when the API fails, and fails when nothing is cached", async () => {
    api(villages(3));
    await service.getReference("villages", 1067);
    await admin.query("UPDATE khc_sync_state SET last_synced_at = NOW() - INTERVAL '200 days'");
    http.request.mockRejectedValueOnce(new Error("down"));
    const stale = await service.getReference("villages", 1067);
    expect(stale.total).toBe(3);
    http.request.mockRejectedValueOnce(new Error("down"));
    await expect(service.getReference("villages", 9999)).rejects.toThrow();
  });

  it("refetches when the cached list is older than the freshness window", async () => {
    api(villages(2));
    await service.getReference("villages", 1067);
    await admin.query("UPDATE khc_sync_state SET last_synced_at = NOW() - INTERVAL '200 days'");
    api(villages(4));
    const result = await service.getReference("villages", 1067);
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(4);
  });

  it("marks removed rows inactive, but keeps rows after a sharp shrink", async () => {
    await master.store("villages", 1, "villageid", "villagename", villages(10));
    await master.store("villages", 1, "villageid", "villagename", villages(9));
    let active = await admin.query("SELECT COUNT(*)::int AS n FROM khc_village WHERE is_active");
    expect(active.rows[0].n).toBe(9);
    await master.store("villages", 1, "villageid", "villagename", villages(2));
    active = await admin.query("SELECT COUNT(*)::int AS n FROM khc_village WHERE is_active");
    expect(active.rows[0].n).toBe(9);
  });

  it("fills the state/district chain on sub-districts and villages", async () => {
    await master.store("districts", 10, "districtid", "districtname", [
      { districtid: 221, districtname: "Meerut" },
    ]);
    await master.store("sub-districts", 221, "subdistrictid", "subdistrictname", [
      { subdistrictid: 1067, subdistrictname: "Meerut Block" },
    ]);
    await master.store("villages", 1067, "villageid", "villagename", villages(2));
    const { rows } = await admin.query(
      "SELECT state_id::int, district_id::int FROM khc_village WHERE parent_id = 1067 LIMIT 1"
    );
    expect(rows[0]).toEqual({ state_id: 10, district_id: 221 });
    const sub = await admin.query("SELECT state_id::int FROM khc_sub_district");
    expect(sub.rows[0].state_id).toBe(10);
  });

  it("staleParents lists parents whose child list is missing or old", async () => {
    await master.store("states", 0, "stateid", "statename", [
      { stateid: 9, statename: "Uttar Pradesh" },
      { stateid: 10, statename: "Bihar" },
    ]);
    await master.store("schemes", 9, "scheme", "schemename", [{ scheme: 38, schemename: "AIF" }]);
    expect(await master.staleParents("states", "schemes", 10)).toEqual([10]);
    await admin.query("UPDATE khc_sync_state SET last_synced_at = NOW() - INTERVAL '30 days' WHERE kind = 'schemes'");
    expect((await master.staleParents("states", "schemes", 10)).sort((a, b) => a - b)).toEqual([9, 10]);
  });

  it("weekly sync fills both trees, skips fresh lists and survives a failed list", async () => {
    process.env.KHC_SYNC_DELAY_MS = "0";
    const fake = jest.spyOn(service, "fetchReferenceRows").mockImplementation(async (kind, parent) => {
      const p = Number(parent ?? 0);
      if (kind === "schemes" && p === 10) throw new Error("boom");
      const rows: Record<string, unknown[]> = {
        states: [{ stateid: 9, statename: "Uttar Pradesh" }, { stateid: 10, statename: "Bihar" }],
        schemes: [{ scheme: 38, schemename: "AIF", division: 31 }],
        categories: [{ problemcategory: 39, categoryname: "Loan" }],
        "sub-categories": [{ problemsubcategory: 1725, subcategoryname: "Bank refused loan" }],
        districts: [{ districtid: 221, districtname: "Meerut" }],
        "sub-districts": [{ subdistrictid: 1067, subdistrictname: "Meerut Block" }],
        villages: [{ villageid: 5, villagename: "Abupur" }],
      };
      return rows[kind] as Record<string, unknown>[];
    });
    const sync = new KhcMasterSyncService(service, master);
    await sync.syncGrievanceTree();
    await sync.syncLocationTree();
    const count = async (table: string) =>
      (await admin.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE is_active`)).rows[0].n;
    expect(await count("khc_state")).toBe(2);
    expect(await count("khc_scheme")).toBe(1);
    expect(await count("khc_category")).toBe(1);
    expect(await count("khc_sub_category")).toBe(1);
    expect(await count("khc_district")).toBe(2);
    expect(await count("khc_village")).toBeGreaterThan(0);
    const calls = fake.mock.calls.length;
    await sync.syncGrievanceTree();
    await sync.syncLocationTree();
    // Only the one list that failed (schemes of state 10) is retried.
    expect(fake.mock.calls.length).toBe(calls + 1);
  });

  it("a list the sync refreshes is still served to reads in between", async () => {
    await master.store("states", 0, "stateid", "statename", [{ stateid: 9, statename: "Uttar Pradesh" }]);
    await master.store("schemes", 9, "scheme", "schemename", [{ scheme: 38, schemename: "AIF" }]);
    await admin.query("UPDATE khc_sync_state SET last_synced_at = NOW() - INTERVAL '30 days' WHERE kind = 'schemes'");
    // 30 days old: past the 25-day refresh age (the monthly sync picks it up) but inside the 35-day read window.
    expect(await master.staleParents("states", "schemes", 10)).toEqual([9]);
    expect(await master.isFresh("schemes", 9)).toBe(true);
    await admin.query("UPDATE khc_sync_state SET last_synced_at = NOW() - INTERVAL '20 days' WHERE kind = 'schemes'");
    expect(await master.staleParents("states", "schemes", 10)).toEqual([]);
  });

  it("an empty list is recorded as synced and not fetched again; the job run is remembered", async () => {
    await master.store("villages", 77, "villageid", "villagename", []);
    expect(await master.isFresh("villages", 77)).toBe(true);
    await master.store("states", 0, "stateid", "statename", [{ stateid: 9, statename: "Uttar Pradesh" }]);
    await master.store("sub-districts", 9, "subdistrictid", "subdistrictname", [{ subdistrictid: 77, subdistrictname: "Empty Block" }]);
    expect(await master.staleParents("sub-districts", "villages", 10)).toEqual([]);
    expect(await master.lastJobRun("location")).toBeNull();
    await master.recordJobRun("location", "ok", { fetched: 3 });
    expect((await master.lastJobRun("location"))?.status).toBe("ok");
    await master.recordJobRun("location", "aborted", {});
    expect(await master.lastJobRun("location")).toBeNull(); // an aborted run does not count
  });

  it("places and grievance lists have different windows (places ~100 days, schemes 35)", async () => {
    await master.store("districts", 9, "districtid", "districtname", [{ districtid: 221, districtname: "Meerut" }]);
    await master.store("schemes", 9, "scheme", "schemename", [{ scheme: 38, schemename: "AIF" }]);
    await admin.query("UPDATE khc_sync_state SET last_synced_at = NOW() - INTERVAL '60 days'");
    expect(await master.isFresh("districts", 9)).toBe(true);
    expect(await master.isFresh("schemes", 9)).toBe(false);
    await admin.query("UPDATE khc_sync_state SET last_synced_at = NOW() - INTERVAL '90 days' WHERE kind = 'districts'");
    expect(await master.isFresh("districts", 9)).toBe(true); // inside the read window ...
    expect(await master.isFresh("districts", 9, 85 * 24 * 60 * 60 * 1000)).toBe(false); // ... but due for the sync
  });

  it("only one sync can hold the lock", async () => {
    const release = await master.lockSync();
    expect(release).not.toBeNull();
    expect(await master.lockSync()).toBeNull();
    await release!();
    const again = await master.lockSync();
    expect(again).not.toBeNull();
    await again!();
  });
});

const body = (values: Record<string, string>, action: string) => ({
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
              tags: Object.entries(values).map(([code, value]) => ({ descriptor: { code }, value })),
            },
          },
        },
      ],
    },
  },
});

const fakeKhc = (service: KhcService, calls: string[] = []) =>
  jest.spyOn(service, "fetchReferenceRows").mockImplementation(async (kind, parent) => {
    calls.push(`${kind}:${parent ?? ""}`);
    const p = Number(parent ?? 0);
    const rows: Record<string, unknown[]> = {
      states: [{ stateid: 9, statename: "Uttar Pradesh" }, { stateid: 10, statename: "Bihar" }, { stateid: 11, statename: "Uttarakhand" }],
      districts: p === 9 ? [{ districtid: 221, districtname: "Meerut" }, { districtid: 222, districtname: "Ghaziabad" }] : [{ districtid: 300, districtname: "Patna" }],
      "sub-districts": p === 221 ? [{ subdistrictid: 1067, subdistrictname: "Meerut Block" }, { subdistrictid: 1068, subdistrictname: "Daurala" }] : [{ subdistrictid: 2000, subdistrictname: "Other" }],
      villages: p === 1067 ? [{ villageid: 5, villagename: "Abupur" }, { villageid: 6, villagename: "Abupur Kalan" }] : p === 1068 ? [{ villageid: 7, villagename: "Abupur" }] : [{ villageid: 8, villagename: "Elsewhere" }],
      schemes: [{ scheme: 38, schemename: "Agriculture Infrastructure Fund (AIF)", division: 31 }, { scheme: 40, schemename: "PM-KISAN", division: 32 }],
      categories: [{ problemcategory: 39, categoryname: "Bank Loan Sanction Issues" }, { problemcategory: 41, categoryname: "Fund Disbursement Issues" }],
      "sub-categories": [{ problemsubcategory: 1725 + p, subcategoryname: "Bank refused loan" }],
    };
    return rows[kind] as Record<string, unknown>[];
  });

suite("village-first location lookup and grievance tree (real Postgres)", () => {
  let master: KhcMasterService;
  let service: KhcService;
  let admin: Pool;

  beforeAll(async () => {
    process.env.KHC_DB_HOST = host;
    process.env.KHC_DB_NAME = process.env.KHC_TEST_DB_NAME;
    process.env.KHC_DB_USER = process.env.KHC_TEST_DB_USER;
    process.env.KHC_DB_PASSWORD = process.env.KHC_TEST_DB_PASSWORD;
    admin = new Pool({ host, database: process.env.KHC_TEST_DB_NAME, user: process.env.KHC_TEST_DB_USER, password: process.env.KHC_TEST_DB_PASSWORD });
    master = new KhcMasterService();
    await master.onModuleInit();
  });
  afterAll(async () => { await master.onModuleDestroy(); await admin.end(); });
  beforeEach(async () => {
    jest.resetAllMocks();
    await admin.query("TRUNCATE khc_state, khc_district, khc_sub_district, khc_village, khc_scheme, khc_category, khc_sub_category, khc_sync_state, khc_sync_job");
    service = new KhcService(new ConfigService({ KHC_BASE_URL: "https://khc.test/api", KHC_API_KEY: "k" }), master);
  });

  it("creates its own tables at startup (no setup script)", async () => {
    const { rows } = await admin.query("SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'khc\\_%'");
    expect(rows[0].n).toBe(9);
  });

  it("matches loosely: case, punctuation, typos; ambiguous names return candidates", () => {
    const states = [{ statename: "Uttar Pradesh" }, { statename: "Uttarakhand" }, { statename: "Bihar" }];
    const pick = (q: string) => matchRows(states, "states", q).map((r) => r.statename);
    expect(pick("uttarpradesh")).toEqual(["Uttar Pradesh"]);
    expect(pick("UTTAR PRADESH")).toEqual(["Uttar Pradesh"]);
    expect(pick("uttarpredesh")).toEqual(["Uttar Pradesh"]);
    expect(pick("uttar")).toEqual(["Uttar Pradesh", "Uttarakhand"]);
    expect(pick("zzzzzz")).toEqual([]);
  });

  it("district given: one call finds the village with its whole chain", async () => {
    fakeKhc(service);
    const result = (await service.lookup.findLocation({ name: "abupur", stateName: "uttarpredesh", districtName: "Meerut" })) as any;
    // Exact name wins: "Abupur Kalan" is left out when "Abupur" matches exactly.
    expect(result.total).toBe(2);
    expect(result.matches.every((m: any) => m.name === "Abupur")).toBe(true);
    const first = result.matches.find((m: any) => m.subDistrict.id === 1067 && m.id === 5);
    expect(first).toMatchObject({ level: "village", name: "Abupur", state: { id: 9, name: "Uttar Pradesh" }, district: { id: 221, name: "Meerut" }, subDistrict: { id: 1067, name: "Meerut Block" } });
  });

  it("a place that is a district resolves as a district", async () => {
    fakeKhc(service);
    const result = (await service.lookup.findLocation({ name: "Meerut", stateName: "Uttar Pradesh" })) as any;
    expect(result.matches[0]).toMatchObject({ level: "district", id: 221, state: { id: 9 } });
  });

  it("later lookups use the cache, not the KHC API", async () => {
    const calls: string[] = [];
    fakeKhc(service, calls);
    await service.lookup.findLocation({ name: "abupur", stateName: "Uttar Pradesh", districtName: "Meerut" });
    const used = calls.length;
    const again = (await service.lookup.findLocation({ name: "abupur" })) as any;
    expect(calls.length).toBe(used);
    expect(again.total).toBeGreaterThan(0);
    expect(again.matches[0].state.name).toBe("Uttar Pradesh");
  });

  it("no match says what to ask next", async () => {
    fakeKhc(service);
    const noState = (await service.lookup.findLocation({ name: "nowhere" })) as any;
    expect(noState.needs).toBe("state");
    const noDistrict = (await service.lookup.findLocation({ name: "nowhere", stateName: "Bihar" })) as any;
    expect(noDistrict.needs).toBe("district");
    const withDistrict = (await service.lookup.findLocation({ name: "nowhere", stateName: "Bihar", districtName: "Patna" })) as any;
    expect(withDistrict.needs).toBe("geocode");
  });

  it("an ambiguous or unknown state returns state options", async () => {
    fakeKhc(service);
    const ambiguous = (await service.lookup.findLocation({ name: "x", stateName: "uttar" })) as any;
    expect(ambiguous.needs).toBe("state");
    expect(ambiguous.matches.map((m: any) => m.name)).toEqual(["Uttar Pradesh", "Uttarakhand"]);
  });

  it("grievance tree: schemes first, then one call for categories and sub-categories", async () => {
    fakeKhc(service);
    const schemes = (await service.lookup.grievanceTree({ stateName: "Uttar Pradesh" })) as any;
    expect(schemes.needs).toBe("scheme");
    expect(schemes.schemes.map((s: any) => s.id)).toEqual([38, 40]);
    const tree = (await service.lookup.grievanceTree({ stateName: "uttarpradesh", scheme: "A.I.F." })) as any;
    expect(tree.scheme).toEqual({ id: 38, name: "Agriculture Infrastructure Fund (AIF)", division: 31 });
    expect(tree.categories.map((c: any) => c.id)).toEqual([39, 41]);
    expect(tree.categories[0].subCategories[0]).toEqual({ id: 1725 + 39, name: "Bank refused loan" });
  });

  it("handle() answers both request types", async () => {
    fakeKhc(service);
    const ask = (values: Record<string, string>) => service.handle(body(values, "init") as any, "on_init");
    const location: any = await ask({ request_type: "find_location", name: "meerut", state_name: "Uttar Pradesh" });
    const tag = location.message.order.items[0].tags[0];
    expect(tag.descriptor.code).toBe("khc_location");
    const tree: any = await ask({ request_type: "grievance_tree", state_name: "Uttar Pradesh", scheme_name: "aif" });
    expect(tree.message.order.items[0].tags[0].descriptor.code).toBe("khc_grievance_tree");
    const bad: any = await ask({ request_type: "find_location", name: "x", state_id: "abc" });
    expect(bad.message.order.items[0].tags[0].descriptor.code).toBe("invalid_request");
  });
});

describe("KhcService without a master cache", () => {
  it("still calls the API directly", async () => {
    jest.resetAllMocks();
    const service = new KhcService(
      new ConfigService({ KHC_BASE_URL: "https://khc.test/api", KHC_API_KEY: "k" })
    );
    api(villages(2));
    const result = await service.getReference("villages", 1067);
    expect(result.total).toBe(2);
    expect(http.request).toHaveBeenCalledTimes(1);
  });
});

suite("several villages with the same name (real Postgres)", () => {
  let master: KhcMasterService;
  let service: KhcService;
  let admin: Pool;

  beforeAll(async () => {
    process.env.KHC_DB_HOST = host;
    process.env.KHC_DB_NAME = process.env.KHC_TEST_DB_NAME;
    process.env.KHC_DB_USER = process.env.KHC_TEST_DB_USER;
    process.env.KHC_DB_PASSWORD = process.env.KHC_TEST_DB_PASSWORD;
    admin = new Pool({ host, database: process.env.KHC_TEST_DB_NAME, user: process.env.KHC_TEST_DB_USER, password: process.env.KHC_TEST_DB_PASSWORD });
    master = new KhcMasterService();
    await master.onModuleInit();
  });
  afterAll(async () => { await master.onModuleDestroy(); await admin.end(); });
  beforeEach(async () => {
    jest.resetAllMocks();
    await admin.query("TRUNCATE khc_state, khc_district, khc_sub_district, khc_village, khc_scheme, khc_category, khc_sub_category, khc_sync_state, khc_sync_job");
    service = new KhcService(new ConfigService({ KHC_BASE_URL: "https://khc.test/api", KHC_API_KEY: "k" }), master);
    await master.store("states", 0, "stateid", "statename", [{ stateid: 9, statename: "Uttar Pradesh" }]);
    await master.store("districts", 9, "districtid", "districtname", [
      { districtid: 221, districtname: "Meerut" }, { districtid: 222, districtname: "Ghaziabad" },
    ]);
    await master.store("sub-districts", 221, "subdistrictid", "subdistrictname", [
      { subdistrictid: 1067, subdistrictname: "Meerut Block" }, { subdistrictid: 1068, subdistrictname: "Daurala" },
    ]);
    await master.store("sub-districts", 222, "subdistrictid", "subdistrictname", [
      { subdistrictid: 2001, subdistrictname: "Loni" },
    ]);
    await master.store("villages", 1067, "villageid", "villagename", [{ villageid: 5, villagename: "Abupur" }, { villageid: 6, villagename: "Abupur Kalan" }]);
    await master.store("villages", 1068, "villageid", "villagename", [{ villageid: 7, villagename: "Abupur" }]);
    await master.store("villages", 2001, "villageid", "villagename", [{ villageid: 8, villagename: "Abupur" }]);
  });

  it("state + village: lists only exact matches, each with its block and district", async () => {
    const result = (await service.lookup.findLocation({ name: "abupur", stateName: "uttarpradesh" })) as any;
    expect(result.total).toBe(3);
    expect(result.matches.every((m: any) => m.name === "Abupur")).toBe(true);
    const where = result.matches.map((m: any) => `${m.subDistrict.name}|${m.district.name}`).sort();
    expect(where).toEqual(["Daurala|Meerut", "Loni|Ghaziabad", "Meerut Block|Meerut"]);
  });

  it("a village plus the picked sub-district narrows to exactly one place", async () => {
    const result = (await service.lookup.findLocation({ name: "abupur", stateName: "uttarpradesh", subDistrictName: "Loni" })) as any;
    expect(result.total).toBe(1);
    expect(result.matches[0]).toMatchObject({
      level: "village", id: 8, subDistrict: { id: 2001, name: "Loni" }, district: { id: 222, name: "Ghaziabad" }, state: { id: 9 },
    });
    // The sub-district's own name must not turn into a match for the place.
    const wrong = (await service.lookup.findLocation({ name: "loni", stateName: "uttarpradesh", subDistrictName: "Daurala" })) as any;
    expect(wrong.matches).toEqual([]);
  });

  it("a partial name still matches when there is no exact one", async () => {
    const result = (await service.lookup.findLocation({ name: "kalan", stateName: "Uttar Pradesh" })) as any;
    expect(result.matches.map((m: any) => m.name)).toEqual(["Abupur Kalan"]);
  });

  it("total shows when the list was cut", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ villageid: 100 + i, villagename: "Rampur" }));
    await master.store("villages", 1067, "villageid", "villagename", many);
    const result = (await service.lookup.findLocation({ name: "rampur", stateName: "Uttar Pradesh" })) as any;
    expect(result.matches.length).toBe(10);
    expect(result.total).toBeGreaterThan(10);
  });
});
