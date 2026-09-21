// Per-workload request rate limiting.
//
// A token bucket per workload id. Tokens refill continuously at the
// configured requests-per-minute rate up to the burst size, and each accepted
// request takes one. The limiter is per gateway process: with several
// replicas the effective rate is the configured rate times the replica count,
// which the operations guide says plainly. It is an accountability control for
// the workload keys the gateway itself issues, not a substitute for an ingress
// limiter in front of untrusted callers.

export interface RateLimit {
  requestsPerMinute: number;
  burst: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  // Returns the number of milliseconds until a token will be available, or
  // zero when the request may proceed and a token has been taken.
  take(workloadId: string, limit: RateLimit): number {
    const at = this.now();
    const perMs = limit.requestsPerMinute / 60_000;
    const bucket = this.#buckets.get(workloadId) ?? { tokens: limit.burst, updatedAt: at };
    const refilled = Math.min(limit.burst, bucket.tokens + (at - bucket.updatedAt) * perMs);
    if (refilled >= 1) {
      this.#buckets.set(workloadId, { tokens: refilled - 1, updatedAt: at });
      return 0;
    }
    this.#buckets.set(workloadId, { tokens: refilled, updatedAt: at });
    return Math.ceil((1 - refilled) / perMs);
  }
}
