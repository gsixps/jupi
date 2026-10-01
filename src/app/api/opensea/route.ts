import { NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

// GET /api/opensea?slugs=a,b,c
//
// Read-only proxy to the OpenSea v2 API for the Seabot demo. OpenSea requires
// an API key (free, requested from OpenSea); it is read from the server env
// OPENSEA_API_KEY so it never reaches the browser. Per collection it returns
// the live floor, recent sales and the creator fees a seller pays.
//
// Hardening: same-origin only, rate limit per IP, slug allowlist by shape,
// at most 20 slugs per call, 60 s cache per slug (OpenSea rate limits keys).

const OPENSEA = 'https://api.opensea.io/api/v2'
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,80}$/
const TTL_MS = 60_000

export interface OpenSeaCollectionData {
  ok: boolean
  error?: string
  floorEth: number
  floorSymbol: string
  oneDaySales: number
  oneDayVolume: number
  sevenDaySales: number
  sevenDayVolume: number
  chain: string
  /** Creator fees a seller must pay (required ones), in percent. */
  creatorFeePct: number
}

const cache = new Map<string, { at: number; data: OpenSeaCollectionData }>()

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

async function getJson(url: string, key: string): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: ctrl.signal,
      cache: 'no-store',
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } finally {
    clearTimeout(t)
  }
}

async function loadCollection(slug: string, key: string): Promise<OpenSeaCollectionData> {
  const empty: OpenSeaCollectionData = {
    ok: false,
    floorEth: 0,
    floorSymbol: 'ETH',
    oneDaySales: 0,
    oneDayVolume: 0,
    sevenDaySales: 0,
    sevenDayVolume: 0,
    chain: 'ethereum',
    creatorFeePct: 0,
  }
  const [stats, meta] = await Promise.all([
    getJson(`${OPENSEA}/collections/${slug}/stats`, key),
    getJson(`${OPENSEA}/collections/${slug}`, key),
  ])
  if (stats.status !== 200 || !stats.body) {
    return { ...empty, error: `OpenSea ${stats.status}` }
  }
  const s = stats.body as {
    total?: { floor_price?: number; floor_price_symbol?: string }
    intervals?: { interval: string; volume?: number; sales?: number }[]
  }
  const iv = (name: string) => s.intervals?.find((x) => x.interval === name)
  const m = (meta.body ?? {}) as {
    fees?: { fee?: number; required?: boolean }[]
    contracts?: { chain?: string }[]
  }
  const creatorFeePct = (m.fees ?? [])
    .filter((f) => f.required !== false)
    .reduce((a, f) => a + (Number(f.fee) || 0), 0)
  return {
    ok: Number(s.total?.floor_price) > 0,
    floorEth: Number(s.total?.floor_price) || 0,
    floorSymbol: s.total?.floor_price_symbol || 'ETH',
    oneDaySales: Number(iv('one_day')?.sales) || 0,
    oneDayVolume: Number(iv('one_day')?.volume) || 0,
    sevenDaySales: Number(iv('seven_day')?.sales) || 0,
    sevenDayVolume: Number(iv('seven_day')?.volume) || 0,
    chain: m.contracts?.[0]?.chain || 'ethereum',
    creatorFeePct,
  }
}

export async function GET(req: Request) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: 'cross-origin requests are not allowed' }, { status: 403 })
  }
  const rl = rateLimit(req, 'opensea-proxy', { limit: 30, windowMs: 60_000 })
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'too many requests' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    )
  }
  const key = process.env.OPENSEA_API_KEY
  if (!key) {
    return NextResponse.json(
      { error: 'OPENSEA_API_KEY no configurada en el servidor (Vercel → Settings → Environment Variables)' },
      { status: 503 }
    )
  }
  const slugs = (new URL(req.url).searchParams.get('slugs') ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => SLUG_RE.test(x))
    .slice(0, 20)
  if (slugs.length === 0) {
    return NextResponse.json({ error: 'slugs required' }, { status: 400 })
  }
  const now = Date.now()
  const out: Record<string, OpenSeaCollectionData> = {}
  // Small batches: OpenSea rate-limits each key.
  for (let i = 0; i < slugs.length; i += 4) {
    await Promise.all(
      slugs.slice(i, i + 4).map(async (slug) => {
        const hit = cache.get(slug)
        if (hit && now - hit.at < TTL_MS) {
          out[slug] = hit.data
          return
        }
        try {
          const data = await loadCollection(slug, key)
          cache.set(slug, { at: now, data })
          out[slug] = data
        } catch (e) {
          out[slug] = {
            ok: false,
            error: (e as Error).message,
            floorEth: 0,
            floorSymbol: 'ETH',
            oneDaySales: 0,
            oneDayVolume: 0,
            sevenDaySales: 0,
            sevenDayVolume: 0,
            chain: 'ethereum',
            creatorFeePct: 0,
          }
        }
      })
    )
  }
  return NextResponse.json({ collections: out }, { headers: { 'Cache-Control': 'no-store' } })
}
