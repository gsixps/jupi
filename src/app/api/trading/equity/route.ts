import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { EquityPoint } from '@/lib/trading-types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/trading/equity?limit=200
// Returns the most recent equity history points.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '200'), 1), 1000)
    const rows = await db.equityPoint.findMany({
      orderBy: { timestamp: 'asc' },
      take: limit,
    })
    const points: EquityPoint[] = rows.map((r) => ({
      timestamp: r.timestamp.getTime(),
      equity: r.equity,
      balance: r.balance,
      openPnl: r.openPnl,
    }))
    return NextResponse.json({ equity: points })
  } catch (e) {
    console.error('[api/trading/equity] GET error', e)
    return NextResponse.json({ error: 'failed', equity: [] }, { status: 500 })
  }
}
