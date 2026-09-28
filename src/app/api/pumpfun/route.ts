import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/pumpfun?sort=market_cap&order=DESC&limit=100
//
// frontend-api-v3.pump.fun answers 403 to any request that carries an `Origin`
// header, which every browser fetch does, so discovery from the page could never
// load. This route fetches the same public list server-side, where no Origin is
// sent, and returns the payload untouched. Only the two discovery sorts the bot
// uses are allowed.
const PUMPFUN_API = 'https://frontend-api-v3.pump.fun/coins'
const ALLOWED_SORTS = new Set(['market_cap', 'created_timestamp'])

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sort = searchParams.get('sort') ?? 'market_cap'
  if (!ALLOWED_SORTS.has(sort)) {
    return NextResponse.json({ error: `sort not allowed: ${sort}` }, { status: 400 })
  }
  const order = searchParams.get('order') === 'ASC' ? 'ASC' : 'DESC'
  const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 100) || 100, 1), 100)

  const url = `${PUMPFUN_API}?limit=${limit}&offset=0&sort=${sort}&order=${order}&includeNsfw=false`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) {
      return NextResponse.json({ error: `pump.fun api ${res.status}` }, { status: 502 })
    }
    const body = await res.text()
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message
    return NextResponse.json({ error: `pump.fun unreachable: ${msg}` }, { status: 502 })
  } finally {
    clearTimeout(timer)
  }
}
