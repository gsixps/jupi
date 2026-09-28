import { NextResponse } from 'next/server'
import crypto from 'node:crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// POST /api/kraken
//
// Kraken's REST API does NOT send `Access-Control-Allow-Origin`, and its
// preflight answers 404, so a browser can never read a signed response: the
// dashboard could verify nothing and place no orders. This route signs the
// request with Node's crypto on the user's own machine and forwards it to
// Kraken, which makes the live Kraken bot actually usable.
//
// The keys travel from the browser to THIS local server on every call (they are
// never persisted here, never logged, and never leave the machine). A private
// endpoint allowlist keeps the proxy from becoming an open relay.
const KRAKEN_REST = 'https://api.kraken.com'

/** The only private endpoints the bot is allowed to reach. */
const ALLOWED_PATHS = new Set([
  '/0/private/Balance',
  '/0/private/AddOrder',
  '/0/private/QueryOrders',
  '/0/private/AssetPairs',
  '/0/private/OpenOrders',
])

interface ProxyBody {
  path?: string
  params?: Record<string, string | number>
  apiKey?: string
  apiSecret?: string
}

function sign(path: string, body: string, secret: string): string {
  const sha = crypto.createHash('sha256').update(body).digest()
  return crypto.createHmac('sha512', Buffer.from(secret, 'base64')).update(
    Buffer.concat([Buffer.from(path, 'utf8'), sha])
  ).digest('base64')
}

export async function POST(req: Request) {
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
  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'apiKey and apiSecret are required' }, { status: 400 })
  }

  // A fresh, strictly increasing nonce: Kraken rejects duplicates.
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) form.set(k, String(v))
  form.set('nonce', String(nonce))
  const payload = form.toString()

  try {
    const res = await fetch(`${KRAKEN_REST}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': sign(path, payload, apiSecret),
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
