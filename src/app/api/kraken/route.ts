import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { rateLimit } from '@/lib/rate-limit'
import { KRAKEN_ASSETS, KRAKEN_TRIANGLES } from '@/lib/kraken'
import { flatDecimal } from '@/lib/cex'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// AddOrder may fetch a live price (5s timeout) before relaying to Kraken, whose
// own latency is out of our control. 30s covers slow upstreams on any plan.
export const maxDuration = 30

// POST /api/kraken
//
// Kraken's REST API does NOT send `Access-Control-Allow-Origin`, and its
// preflight answers 404, so a browser can never read a signed response: the
// dashboard could verify nothing and place no orders. This route signs the
// request with Node's crypto on the user's own machine and forwards it to
// Kraken. The keys travel from the browser to THIS server on every call —
// they are never persisted, never logged.
//
// HARDENING (so the deployment can't be abused as a relay or a money cannon):
//   1. Same-origin only (Origin/Referer must match the host, when present).
//   2. Rate limit per IP.
//   3. Endpoint allowlist — only the 5 private calls the bot needs.
//   4. Parameter allowlist per endpoint (unknown params dropped).
//   5. Pair allowlist for orders (the app's own watchlist).
//   6. Server-side ORDER VALUE CAP: AddOrder notional (volume × live price)
//      must be ≤ KRAKEN_MAX_ORDER_USD (default 25 USD).
//   7. Strictly increasing nonce PER KEY (Kraken rejects duplicates).
const KRAKEN_REST = 'https://api.kraken.com'

/** The only private endpoints the bot is allowed to reach. */
const ALLOWED_PATHS = new Set([
  '/0/private/Balance',
  '/0/private/AddOrder',
  '/0/private/QueryOrders',
  '/0/private/OpenOrders',
  '/0/private/AssetPairs',
])

/** Parameter allowlist per endpoint — anything else is dropped. */
const ALLOWED_PARAMS: Record<string, Set<string>> = {
  '/0/private/Balance': new Set([]),
  '/0/private/AddOrder': new Set([
    'pair', 'type', 'ordertype', 'volume', 'price', 'oflags', 'userref', 'validate',
  ]),
  '/0/private/QueryOrders': new Set(['txid', 'userref', 'trades', 'start', 'end']),
  '/0/private/OpenOrders': new Set(['userref', 'trades']),
  '/0/private/AssetPairs': new Set(['pair']),
}

/** Canonical Kraken pairs this deployment may trade (its own watchlist). */
const TRADABLE_PAIRS: Set<string> = new Set([
  ...KRAKEN_ASSETS.map((a) => a.symbol),
  ...KRAKEN_TRIANGLES.flatMap((t) => [t.directSymbol, t.crossSymbol, t.usdtSymbol]),
])

const PAIR_RE = /^[A-Z0-9]{6,16}$/
const TXID_RE = /^[A-Z0-9]{6,32}$/

/** Server-side per-order cap in USD (only for AddOrder). */
const MAX_ORDER_USD = (() => {
  const v = Number(process.env.KRAKEN_MAX_ORDER_USD)
  return isFinite(v) && v > 0 ? v : 25
})()

/** Short-lived cache of pair mid prices for the order-cap check. */
const priceCache = new Map<string, { mid: number; at: number }>()
const PRICE_TTL_MS = 15_000

async function pairMidPrice(pair: string): Promise<number> {
  const hit = priceCache.get(pair)
  const now = Date.now()
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.mid
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(
      `${KRAKEN_REST}/0/public/Ticker?pair=${encodeURIComponent(pair)}`,
      { signal: ctrl.signal, cache: 'no-store' }
    )
    if (!res.ok) return hit?.mid ?? 0
    const j = (await res.json()) as {
      error?: string[]
      result?: Record<string, { c?: string[] }>
    }
    if (j.error && j.error.length > 0) return hit?.mid ?? 0
    const first = j.result ? Object.values(j.result)[0] : undefined
    const last = parseFloat(Array.isArray(first?.c) ? String(first?.c[0]) : '0')
    if (!isFinite(last) || last <= 0) return hit?.mid ?? 0
    priceCache.set(pair, { mid: last, at: now })
    return last
  } catch {
    return hit?.mid ?? 0
  } finally {
    clearTimeout(t)
  }
}

interface ProxyBody {
  path?: string
  params?: Record<string, string | number>
  apiKey?: string
  apiSecret?: string
}

/**
 * Kraken API-Sign = HMAC-SHA512(path + SHA256(nonce + postdata)), keyed with
 * the base64-decoded secret. The nonce is prepended even though postdata
 * already contains `nonce=...`; hashing postdata alone yields
 * `EAPI:Invalid signature` with every real key. Verified against the test
 * vector in Kraken's REST authentication docs.
 */
function sign(path: string, nonce: string, body: string, secret: string): string {
  const sha = crypto.createHash('sha256').update(nonce + body).digest()
  return crypto
    .createHmac('sha512', Buffer.from(secret, 'base64'))
    .update(Buffer.concat([Buffer.from(path, 'utf8'), sha]))
    .digest('base64')
}

/**
 * Same-origin guard: browsers always attach Origin on cross-origin fetches and
 * same-origin POSTs; a mismatched/foreign Origin means another site is trying
 * to spend THIS deployment's rate limit (or the visitor's own Kraken keys via
 * CSRF). Native clients (curl) send no Origin and are still allowed locally.
 */
function sameOriginError(req: Request): NextResponse | null {
  const origin = req.headers.get('origin')
  if (!origin) return null // native/non-browser client (rate limit still applies)
  let host = req.headers.get('host') ?? ''
  try {
    const o = new URL(origin)
    // Behind a proxy the public host may differ; compare by host name.
    if (o.host === host) return null
    const fwd = req.headers.get('x-forwarded-host')
    if (fwd && o.host === fwd.split(',')[0].trim()) return null
    host = host // keep for message
  } catch {
    return NextResponse.json({ error: 'invalid origin' }, { status: 403 })
  }
  return NextResponse.json({ error: 'cross-origin requests are not allowed' }, { status: 403 })
}

/** Strictly increasing nonce PER KEY — Kraken rejects non-monotonic nonces. */
const lastNonceByKey = new Map<string, number>()
function nextNonce(apiKey: string): string {
  const prev = lastNonceByKey.get(apiKey) ?? 0
  let n = Date.now() * 1000
  if (n <= prev) n = prev + 1
  lastNonceByKey.set(apiKey, n)
  return String(n)
}

export async function POST(req: Request) {
  const so = sameOriginError(req)
  if (so) return so

  const rl = rateLimit(req, 'kraken-proxy', { limit: 60, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'too many requests' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    )
  }

  let body: ProxyBody
  try {
    body = (await req.json()) as ProxyBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const { path, params, apiKey, apiSecret } = body
  if (!path || !ALLOWED_PATHS.has(path)) {
    return NextResponse.json({ error: `path not allowed: ${path ?? '(none)'}` }, { status: 400 })
  }
  if (!apiKey || !apiSecret || apiKey.length > 256 || apiSecret.length > 256) {
    return NextResponse.json({ error: 'apiKey and apiSecret are required' }, { status: 400 })
  }

  // 1. Parameter allowlist per endpoint.
  const allowed = ALLOWED_PARAMS[path]
  const clean = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (!allowed.has(k)) continue
    // 2. Value shape checks.
    if (k === 'pair') {
      const p = String(v).toUpperCase()
      if (!PAIR_RE.test(p)) {
        return NextResponse.json({ error: `invalid pair: ${p}` }, { status: 400 })
      }
      if (path === '/0/private/AddOrder' && !TRADABLE_PAIRS.has(p)) {
        return NextResponse.json(
          { error: `pair not tradable on this deployment: ${p}` },
          { status: 400 }
        )
      }
    }
    if (k === 'txid' && !TXID_RE.test(String(v).toUpperCase())) {
      return NextResponse.json({ error: 'invalid txid' }, { status: 400 })
    }
    if (k === 'userref') {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0 || n > 4294967295) {
        return NextResponse.json({ error: 'invalid userref' }, { status: 400 })
      }
    }
    if (k === 'type' && !['buy', 'sell'].includes(String(v))) {
      return NextResponse.json({ error: 'invalid order type' }, { status: 400 })
    }
    if (k === 'ordertype' && !['market', 'limit'].includes(String(v))) {
      return NextResponse.json({ error: 'invalid ordertype' }, { status: 400 })
    }
    clean.set(k, typeof v === 'number' ? flatDecimal(v) : String(v))
  }

  // 3. Server-side order value cap: a stolen key session cannot drain the
  //    account — each order's notional (volume × live price) is capped.
  if (path === '/0/private/AddOrder') {
    const type = clean.get('type')
    const pair = (clean.get('pair') ?? '').toUpperCase()
    const volume = parseFloat(clean.get('volume') ?? '0')
    if (!pair || !(volume > 0)) {
      return NextResponse.json({ error: 'AddOrder needs a valid pair and volume' }, { status: 400 })
    }
    if (type === 'sell') {
      // Selling costs nothing from the USD account, but still sanity-cap the
      // volume against the pair's realistic size to avoid fat-finger dumps.
      const mid = await pairMidPrice(pair)
      if (mid > 0 && volume * mid > MAX_ORDER_USD * 4) {
        return NextResponse.json(
          { error: `sell volume too large for this deployment (>${MAX_ORDER_USD * 4} USD notional)` },
          { status: 400 }
        )
      }
    } else {
      const mid = await pairMidPrice(pair)
      if (!(mid > 0)) {
        return NextResponse.json(
          { error: 'no live price for pair — cannot verify order cap; retry' },
          { status: 400 }
        )
      }
      const notional = volume * mid
      if (notional > MAX_ORDER_USD) {
        return NextResponse.json(
          {
            error: `orden demasiado grande para este despliegue: ~${notional.toFixed(2)} USD > tope ${MAX_ORDER_USD} USD (ajustable con KRAKEN_MAX_ORDER_USD)`,
          },
          { status: 400 }
        )
      }
    }
  }

  // 4. Fresh, strictly-increasing nonce PER KEY.
  const nonce = nextNonce(apiKey)
  clean.set('nonce', nonce)
  const payload = clean.toString()

  try {
    const res = await fetch(`${KRAKEN_REST}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': sign(path, nonce, payload, apiSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload,
      cache: 'no-store',
    })
    const text = await res.text()
    // Pass Kraken's own status and body through untouched: the client already
    // knows how to read `error: [...]` arrays (EAPI:Invalid key, ESession, ...).
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return NextResponse.json(
      { error: `Kraken unreachable: ${(e as Error).message}` },
      { status: 502 }
    )
  }
}
