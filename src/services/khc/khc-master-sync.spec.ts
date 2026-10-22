import { Logger } from "@nestjs/common";
import { KhcMasterSyncService } from "./khc-master-sync.service";

// Fake cache and KHC client: nothing here needs a database.
function setup(lastRun: { at: Date; status: string } | null) {
  const recorded: { name: string; status: string }[] = [];
  const master: any = {
    isReady: () => true,
    lockSync: jest.fn(async () => async () => undefined),
    lastJobRun: jest.fn(async () => lastRun),
    recordJobRun: jest.fn(async (name: string, status: string) => { recorded.push({ name, status }); }),
    isFresh: jest.fn(async () => false),
    store: jest.fn(async () => undefined),
    staleParents: jest.fn(async () => []),
  };
  const khc: any = { fetchReferenceRows: jest.fn(async () => [{ stateid: 9, statename: "UP" }]) };
  return { service: new KhcMasterSyncService(khc, master), master, khc, recorded };
}
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("KhcMasterSyncService restarts", () => {
  beforeEach(() => {
    process.env.KHC_SYNC_DELAY_MS = "0";
    delete process.env.KHC_SYNC_ENABLED;
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("a restart right after a sync does not call KHC", async () => {
    const { service, khc, master } = setup({ at: daysAgo(1), status: "ok" });
    await service.startupSync();
    expect(khc.fetchReferenceRows).not.toHaveBeenCalled();
    expect(master.recordJobRun).not.toHaveBeenCalled();
  });

  it("a restart long after the last sync runs it again and records the run", async () => {
    const { service, khc, recorded } = setup({ at: daysAgo(40), status: "ok" });
    await service.startupSync();
    expect(khc.fetchReferenceRows).toHaveBeenCalled();
    expect(recorded).toEqual([
      { name: "grievance", status: "ok" },
      { name: "location", status: "ok" },
    ]);
  });

  it("the first ever start (no record) runs", async () => {
    const { service, khc } = setup(null);
    await service.startupSync();
    expect(khc.fetchReferenceRows).toHaveBeenCalled();
  });

  it("force ignores the last run", async () => {
    const { service, khc } = setup({ at: daysAgo(1), status: "ok" });
    await service.startupSync(true);
    expect(khc.fetchReferenceRows).toHaveBeenCalled();
  });

  it("the scheduled cron always runs, even if it ran recently", async () => {
    const { service, khc } = setup({ at: daysAgo(1), status: "ok" });
    await service.grievanceCron();
    expect(khc.fetchReferenceRows).toHaveBeenCalled();
  });

  it("a run with failed lists is recorded as partial, and an aborted run as aborted", async () => {
    const partial = setup(null);
    partial.khc.fetchReferenceRows.mockRejectedValue(new Error("down"));
    await partial.service.syncGrievanceTree();
    expect(partial.recorded[0].status).toBe("partial");

    const aborted = setup(null);
    aborted.master.staleParents.mockRejectedValue(new Error("db"));
    await aborted.service.syncGrievanceTree();
    expect(aborted.recorded[0].status).toBe("aborted");
  });

  it("a skipped run still releases the lock", async () => {
    const release = jest.fn(async () => undefined);
    const { service, master } = setup({ at: daysAgo(1), status: "ok" });
    master.lockSync.mockResolvedValue(release);
    await service.startupSync();
    expect(release).toHaveBeenCalledTimes(2);
  });
});
