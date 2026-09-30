import { Injectable } from "@nestjs/common";

export interface KccSession {
  /** requestID returned with the OTP; paired with the OTP on the status call. */
  requestId: string;
  mobileNumber: string;
  /** Epoch ms after which the OTP has expired upstream. */
  expiresAt: number;
}

/**
 * Holds pending KCC OTP requests keyed by context.transaction_id, so the status call
 * that follows only needs to carry the OTP — the requestID never leaves the provider.
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
