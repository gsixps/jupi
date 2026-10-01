// In-memory sliding-window rate limiter for API routes.
//
// Protects the deployment from abuse: the wallet-backup endpoints (token
// brute-force), the Solana/RPC proxies (expensive upstream calls) and the
// Kraken signing relay. On serverless (Vercel) each instance keeps its own
// window — it is not a global limit, but it stops hammering from a single
// IP and is enough as a first line of defense without extra infrastructure.
//
// Usage:
//   const rl = rateLimit(req, 'wallet-get', { limit: 10, windowMs: 60_000 })
//   if (!rl.ok) return NextResponse.json({ error: 'too many requests' }, { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } })

interface Bucket {
  hits: number[]
  /** last time this bucket was touched (for GC) */
  touched: number
}

const buckets = new Map<string, Bucket>()

// Periodic GC so idle buckets don't leak memory in long-running processes.
const GC_INTERVAL_MS = 5 * 60_000
let lastGc = Date.now()

function gc(now: number, windowMs: number) {
  if (now - lastGc < GC_INTERVAL_MS) return
  lastGc = now
  for (const [key, bucket] of buckets) {
    if (now - bucket.touched > Math.max(windowMs, GC_INTERVAL_MS)) buckets.delete(key)
  }
}

export interface RateLimitOptions {
  /** Max requests allowed per window. */
  limit: number
  /** Window length in ms. */
  windowMs?: number
}

export interface RateLimitResult {
  ok: boolean
  /** Seconds until the client may retry (only meaningful when !ok). */
  retryAfter: number
  remaining: number
}

/** Best-effort client IP for rate-limit keys. */
export function clientIp(req: Request): string {
  const h = req.headers
  return (
    h.get('x-real-ip') ??
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

export function rateLimit(
  req: Request,
  scope: string,
  { limit, windowMs = 60_000 }: RateLimitOptions
): RateLimitResult {
  const now = Date.now()
  gc(now, windowMs)

  const key = `${scope}:${clientIp(req)}`
  const bucket = buckets.get(key) ?? { hits: [], touched: now }
  bucket.touched = now

  // Drop hits outside the current window
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs)

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0] ?? now
    buckets.set(key, bucket)
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      remaining: 0,
    }
  }

  bucket.hits.push(now)
  buckets.set(key, bucket)
  return { ok: true, retryAfter: 0, remaining: limit - bucket.hits.length }
}
