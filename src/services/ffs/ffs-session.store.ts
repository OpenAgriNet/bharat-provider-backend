import { Injectable } from "@nestjs/common";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * FFS workflow state per chat session_id, plus the shared state crop catalogue and a
 * per-session queue so one farmer's calls never interleave.
 *
 * In-memory, like KccSessionStore: lost on restart (the farmer logs in again) and not
 * shared across instances. Move onto Redis before running several provider replicas.
 */
@Injectable()
export class FfsSessionStore {
  static readonly SESSION_TTL_MS = 20 * 60_000;
  static readonly CROP_CATALOG_TTL_MS = 24 * 60 * 60_000;

  private readonly sessions = new Map<string, { state: any; expiresAt: number }>();
  private readonly cropCatalogs = new Map<string, { crops: any[]; expiresAt: number }>();
  private readonly queues = new Map<string, Promise<unknown>>();

  /** A private copy: unsaved changes are discarded when a call fails. */
  get(sessionId: string): any {
    const entry = this.sessions.get(sessionId);
    if (!entry || Date.now() >= entry.expiresAt) {
      this.sessions.delete(sessionId);
      return {};
    }
    return clone(entry.state);
  }

  set(sessionId: string, state: any) {
    this.prune();
    this.sessions.set(sessionId, {
      state: clone(state),
      expiresAt: Date.now() + FfsSessionStore.SESSION_TTL_MS,
    });
  }

  getCrops(key: string): any[] | undefined {
    const entry = this.cropCatalogs.get(key);
    if (!entry || Date.now() >= entry.expiresAt) {
      this.cropCatalogs.delete(key);
      return undefined;
    }
    return clone(entry.crops);
  }

  setCrops(key: string, crops: any[]) {
    this.cropCatalogs.set(key, {
      crops: clone(crops),
      expiresAt: Date.now() + FfsSessionStore.CROP_CATALOG_TTL_MS,
    });
  }

  /** Runs `task` after every earlier task for the same session has settled. */
  serialise<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(sessionId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    this.queues.set(sessionId, tail);
    tail.then(() => {
      if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
    });
    return run;
  }

  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now >= entry.expiresAt) this.sessions.delete(id);
    }
  }
}
