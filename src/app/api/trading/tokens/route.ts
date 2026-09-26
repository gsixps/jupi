import { NextResponse } from 'next/server'
import { fetchTokenList } from '@/lib/tokens'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/trading/tokens
// Returns the resolved Jupiter verified token list curated for trading.
// Falls back to BASE_TOKENS (USDC + SOL) on Jupiter API failure.
export async function GET() {
  try {
    const tokens = await fetchTokenList()
    return NextResponse.json({ tokens })
  } catch (e) {
    console.error('[api/trading/tokens] GET error', e)
    return NextResponse.json({ error: 'failed', tokens: [] }, { status: 500 })
  }
}
