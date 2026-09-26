import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEFAULT_CONFIG, type BotConfig } from '@/lib/trading-types'
import { fetchTokenList } from '@/lib/tokens'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/trading/config
// Returns the persisted BotConfig (id="default"). If missing, returns DEFAULT_CONFIG
// with tokens resolved from Jupiter's verified list.
export async function GET() {
  try {
    const row = await db.botConfig.findUnique({ where: { id: 'default' } })
    const tokens = await fetchTokenList()
    if (!row) {
      return NextResponse.json({
        ...DEFAULT_CONFIG,
        tokens: tokens.map((t) => t.mint),
      })
    }
    let tokenMints: string[] = []
    try {
      const parsed = JSON.parse(row.tokens ?? '[]')
      if (Array.isArray(parsed)) tokenMints = parsed.filter((x) => typeof x === 'string')
    } catch {
      tokenMints = []
    }
    return NextResponse.json({
      running: row.running,
      capital: row.capital,
      maxPositions: row.maxPositions,
      tradeSizePct: row.tradeSizePct,
      buyThreshold: row.buyThreshold,
      sellThreshold: row.sellThreshold,
      stopLossPct: row.stopLossPct,
      arbMinProfitBps: row.arbMinProfitBps,
      slippageBps: row.slippageBps,
      scanIntervalMs: row.scanIntervalMs,
      tokens: tokenMints,
    })
  } catch (e) {
    console.error('[api/trading/config] GET error', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}

// POST /api/trading/config
// Upserts the config row (id="default"). Body is Partial<BotConfig>.
// NOTE: the trading engine is the source of truth for the live in-memory config
// (it persists to the same DB on UPDATE_CONFIG). This REST endpoint is provided
// for redundancy and external tooling; the dashboard emits UPDATE_CONFIG via
// socket for the live path.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<BotConfig>
    const tokens = Array.isArray(body.tokens) ? body.tokens : []
    const data = {
      running: typeof body.running === 'boolean' ? body.running : undefined,
      capital: typeof body.capital === 'number' ? body.capital : undefined,
      maxPositions: typeof body.maxPositions === 'number' ? body.maxPositions : undefined,
      tradeSizePct: typeof body.tradeSizePct === 'number' ? body.tradeSizePct : undefined,
      buyThreshold: typeof body.buyThreshold === 'number' ? body.buyThreshold : undefined,
      sellThreshold: typeof body.sellThreshold === 'number' ? body.sellThreshold : undefined,
      stopLossPct: typeof body.stopLossPct === 'number' ? body.stopLossPct : undefined,
      arbMinProfitBps: typeof body.arbMinProfitBps === 'number' ? body.arbMinProfitBps : undefined,
      slippageBps: typeof body.slippageBps === 'number' ? body.slippageBps : undefined,
      scanIntervalMs: typeof body.scanIntervalMs === 'number' ? body.scanIntervalMs : undefined,
      tokens: tokens.length > 0 ? JSON.stringify(tokens) : undefined,
    }
    // Strip undefined fields so Prisma doesn't reset them
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) clean[k] = v
    }
    const row = await db.botConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...clean },
      update: clean,
    })
    return NextResponse.json({
      running: row.running,
      capital: row.capital,
      maxPositions: row.maxPositions,
      tradeSizePct: row.tradeSizePct,
      buyThreshold: row.buyThreshold,
      sellThreshold: row.sellThreshold,
      stopLossPct: row.stopLossPct,
      arbMinProfitBps: row.arbMinProfitBps,
      slippageBps: row.slippageBps,
      scanIntervalMs: row.scanIntervalMs,
      tokens,
    })
  } catch (e) {
    console.error('[api/trading/config] POST error', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
