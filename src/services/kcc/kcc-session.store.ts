import { Injectable } from "@nestjs/common";
import { KccApplicationStatus } from "./kcc.service";

export interface KccSession {
  /** requestID returned with the OTP; paired with the OTP on the status call. */
  requestId: string;
  mobileNumber: string;
  /**
   * Set once the OTP has been accepted. The OTP is then spent, so a farmer with several
   * applications picks one from this list rather than being sent a new OTP.
   */
  applications?: KccApplicationStatus[];
  /** Epoch ms after which the session is discarded. */
  expiresAt: number;
}

/**
 * Holds KCC sessions keyed by context.transaction_id: first the pending OTP request (so
 * the status call only needs the OTP — the requestID never leaves the provider), then
 * the applications that OTP fetched.
 *
 * In-memory, like AifSessionStore: lost on restart (the farmer is asked for a fresh
 * OTP) and not shared across instances. Move onto Redis before scaling out.
 */
@Injectable()
export class KccSessionStore {
  private readonly sessions = new Map<string, KccSession>();

  /** KCC OTPs are valid for 15 minutes ("expiresIn": "15 mins"). */
  static readonly OTP_LIFETIME_MS = 15 * 60_000;

  set(transactionId: string, session: Omit<KccSession, "expiresAt">) {
    this.sessions.set(transactionId, {
      ...session,
      expiresAt: Date.now() + KccSessionStore.OTP_LIFETIME_MS,
    });
  }

  /** Stores the fetched applications and keeps them for another OTP lifetime. */
  setApplications(transactionId: string, applications: KccApplicationStatus[]) {
    const session = this.sessions.get(transactionId);
    if (!session) return;
    this.sessions.set(transactionId, {
      ...session,
      applications,
      expiresAt: Date.now() + KccSessionStore.OTP_LIFETIME_MS,
    });
  }

  /** Returns the session only while still valid; expired entries are evicted on read. */
  get(transactionId: string): KccSession | undefined {
    const session = this.sessions.get(transactionId);
    if (!session) return undefined;
    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(transactionId);
      return undefined;
    }
    return session;
  }

  delete(transactionId: string) {
    this.sessions.delete(transactionId);
  }

  /** Drops every expired session. Called opportunistically so the map cannot grow without bound. */
  prune() {
    const now = Date.now();
    for (const [transactionId, session] of this.sessions) {
      if (now >= session.expiresAt) this.sessions.delete(transactionId);
    }
  }
}
