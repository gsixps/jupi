import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { Trade } from '@/lib/trading-types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/trading/trades?limit=100
// Returns recent closed trades (most recent first).
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '100'), 1), 500)
    const rows = await db.trade.findMany({
      orderBy: { openedAt: 'desc' },
      take: limit,
    })
    const trades: Trade[] = rows.map((r) => {
      let route: string[] = []
      let cycle: string[] | undefined
      try {
        const parsed = JSON.parse(r.route ?? '[]')
        if (Array.isArray(parsed)) route = parsed.filter((x) => typeof x === 'string')
      } catch {
        route = []
      }
      if (r.cycle) {
        try {
          const parsed = JSON.parse(r.cycle)
          if (Array.isArray(parsed)) cycle = parsed.filter((x) => typeof x === 'string')
        } catch {
          cycle = undefined
        }
      }
      return {
        id: r.id,
        strategy: r.strategy as Trade['strategy'],
        side: r.side as Trade['side'],
        inputMint: r.inputMint,
        outputMint: r.outputMint,
        inputSymbol: r.inputSymbol,
        outputSymbol: r.outputSymbol,
        inputAmount: r.inputAmount,
        outputAmount: r.outputAmount,
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice ?? undefined,
        pnl: r.pnl,
        pnlPct: r.pnlPct,
        win: r.win,
        route,
        cycle,
        reason: r.reason ?? '',
        openedAt: r.openedAt.getTime(),
        closedAt: r.closedAt ? r.closedAt.getTime() : undefined,
      }
    })
    return NextResponse.json({ trades })
  } catch (e) {
    console.error('[api/trading/trades] GET error', e)
    return NextResponse.json({ error: 'failed', trades: [] }, { status: 500 })
  }
}
