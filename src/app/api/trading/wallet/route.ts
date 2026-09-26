import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/trading/wallet
// Returns the server-side backup of the trading sub-wallet (id="default") or
// null. The secret key is base58. If the DB is unavailable (e.g. no hosted DB
// on a fresh Vercel deploy with only the sqlite env), the UI falls back to
// localStorage only.
export async function GET() {
  try {
    const row = await db.tradingWallet.findUnique({ where: { id: 'default' } })
    if (!row) return NextResponse.json({ wallet: null })
    return NextResponse.json({ wallet: { publicKey: row.publicKey, secretKey: row.secretKey } })
  } catch (e) {
    console.error('[api/trading/wallet] GET error (DB unavailable?)', e)
    return NextResponse.json({ wallet: null })
  }
}

// POST /api/trading/wallet
// Upserts the backup of the trading sub-wallet (id="default").
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { publicKey?: string; secretKey?: string }
    if (!body.publicKey || !body.secretKey) {
      return NextResponse.json({ error: 'publicKey and secretKey required' }, { status: 400 })
    }
    const row = await db.tradingWallet.upsert({
      where: { id: 'default' },
      create: { id: 'default', publicKey: body.publicKey, secretKey: body.secretKey },
      update: { publicKey: body.publicKey, secretKey: body.secretKey },
    })
    return NextResponse.json({ wallet: { publicKey: row.publicKey } })
  } catch (e) {
    console.error('[api/trading/wallet] POST error', e)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}

// DELETE /api/trading/wallet
// Removes the server-side backup (called on Reset).
export async function DELETE() {
  try {
    await db.tradingWallet.deleteMany({ where: { id: 'default' } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[api/trading/wallet] DELETE error', e)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}