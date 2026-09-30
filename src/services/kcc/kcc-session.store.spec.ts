import { KccSessionStore } from "./kcc-session.store";

describe("KccSessionStore", () => {
  let store: KccSessionStore;

  const session = { requestId: "req-1", mobileNumber: "9797396386" };

  beforeEach(() => {
    jest.useFakeTimers();
    store = new KccSessionStore();
  });

  afterEach(() => jest.useRealTimers());

  it("returns a pending OTP request that is still valid", () => {
    store.set("txn-1", session);

    expect(store.get("txn-1")).toMatchObject(session);
  });

  it("expires once the 15-minute OTP lifetime has passed", () => {
    store.set("txn-1", session);

    jest.advanceTimersByTime(KccSessionStore.OTP_LIFETIME_MS - 1);
    expect(store.get("txn-1")).toBeDefined();

    jest.advanceTimersByTime(1);
    expect(store.get("txn-1")).toBeUndefined();
  });

  it("keeps fetched applications for another OTP lifetime", () => {
    store.set("txn-1", session);
    jest.advanceTimersByTime(KccSessionStore.OTP_LIFETIME_MS - 1000);

    store.setApplications("txn-1", [{ applicationNo: "1" } as any]);
    jest.advanceTimersByTime(KccSessionStore.OTP_LIFETIME_MS - 1000);

    expect(store.get("txn-1")?.applications).toEqual([{ applicationNo: "1" }]);
  });

  it("ignores applications for an unknown transaction", () => {
    store.setApplications("nope", []);

    expect(store.get("nope")).toBeUndefined();
  });

  it("forgets a session on delete", () => {
    store.set("txn-1", session);
    store.delete("txn-1");

    expect(store.get("txn-1")).toBeUndefined();
  });

  it("prune drops only expired sessions", () => {
    store.set("old", session);
    jest.advanceTimersByTime(KccSessionStore.OTP_LIFETIME_MS);
    store.set("new", session);

    store.prune();

    expect(store.get("old")).toBeUndefined();
    expect(store.get("new")).toBeDefined();
  });
});
