import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

// POST /api/oanda — relay to the OANDA v20 REST API for the gold bot.
//
// OANDA does not allow browser CORS, so the browser sends its own token (kept
// in its localStorage, never stored here) and this route forwards the call.
//
// Hardening (so the deployment can't be used as a generic relay):
//   1. Same-origin only + rate limit per IP.
//   2. Path allowlist: account summary/instrument/pricing/open trades, XAU_USD
//      candles, MARKET orders and trade close / stop updates only.
//   3. Instrument allowlist: XAU_USD only.
//   4. Size cap: |units| ≤ OANDA_MAX_UNITS (default 5 troy ounces).
//   5. Practice by default; "live" must be requested explicitly.

const HOSTS = {
  practice: 'https://api-fxpractice.oanda.com',
  live: 'https://api-fxtrade.oanda.com',
} as const

const ACC = '[A-Za-z0-9_-]{3,40}'
const ROUTES: { method: string; re: RegExp }[] = [
  { method: 'GET', re: new RegExp(`^/v3/accounts/${ACC}/summary$`) },
  { method: 'GET', re: new RegExp(`^/v3/accounts/${ACC}/instruments$`) },
  { method: 'GET', re: new RegExp(`^/v3/accounts/${ACC}/pricing$`) },
  { method: 'GET', re: new RegExp(`^/v3/accounts/${ACC}/openTrades$`) },
  { method: 'GET', re: /^\/v3\/instruments\/XAU_USD\/candles$/ },
  { method: 'POST', re: new RegExp(`^/v3/accounts/${ACC}/orders$`) },
  { method: 'PUT', re: new RegExp(`^/v3/accounts/${ACC}/trades/\\d{1,20}/close$`) },
  { method: 'PUT', re: new RegExp(`^/v3/accounts/${ACC}/trades/\\d{1,20}/orders$`) },
]
const QUERY_KEYS = new Set(['instruments', 'granularity', 'count', 'price', 'from', 'to'])

const MAX_UNITS = (() => {
  const v = Number(process.env.OANDA_MAX_UNITS)
  return isFinite(v) && v > 0 ? v : 5
})()

interface Body {
  env?: 'practice' | 'live'
  token?: string
  method?: string
  path?: string
  query?: Record<string, string>
  body?: unknown
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  try {
    const o = new URL(origin)
    const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() || req.headers.get('host')
    return o.host === host
  } catch {
    return false
  }
}

function bad(msg: string, status = 400) {
  return NextResponse.json({ errorMessage: msg }, { status })
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return bad('cross-origin requests are not allowed', 403)
  const rl = rateLimit(req, 'oanda-proxy', { limit: 120, windowMs: 60_000 })
  if (!rl.ok) return bad('too many requests', 429)

  let b: Body
  try {
    b = (await req.json()) as Body
  } catch {
    return bad('invalid JSON body')
  }
  const env = b.env === 'live' ? 'live' : 'practice'
  const method = String(b.method ?? 'GET').toUpperCase()
  const path = String(b.path ?? '')
  const token = String(b.token ?? '').trim()
  if (!token || token.length > 200 || !/^[A-Za-z0-9-]+$/.test(token)) return bad('token de OANDA inválido')
  if (!ROUTES.some((r) => r.method === method && r.re.test(path))) return bad(`ruta no permitida: ${method} ${path}`)

  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(b.query ?? {})) {
    if (!QUERY_KEYS.has(k)) continue
    if (k === 'instruments' && v !== 'XAU_USD') return bad('solo XAU_USD')
    qs.set(k, String(v))
  }

  // Orders: XAU_USD MARKET only, size-capped.
  if (method === 'POST') {
    const o = (b.body as { order?: { type?: string; instrument?: string; units?: string } })?.order
    if (!o || o.type !== 'MARKET' || o.instrument !== 'XAU_USD') return bad('solo órdenes MARKET de XAU_USD')
    const units = Math.abs(Number(o.units))
    if (!(units > 0) || units > MAX_UNITS) {
      return bad(`tamaño fuera de límites: ${o.units} (máximo ${MAX_UNITS} oz, ajustable con OANDA_MAX_UNITS)`)
    }
  }

  const url = `${HOSTS[env]}${path}${qs.size ? `?${qs.toString()}` : ''}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20_000)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'UNIX',
      },
      body: method === 'GET' ? undefined : JSON.stringify(b.body ?? {}),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    return bad(`OANDA unreachable: ${(e as Error).message}`, 502)
  } finally {
    clearTimeout(t)
  }
}
