import { NextResponse } from 'next/server'
import crypto from 'node:crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const KRAKEN_REST = 'https://api.kraken.com'
const ALLOWED_PATHS = new Set([
  '/0/private/Balance',
  '/0/private/AddOrder',
  '/0/private/QueryOrders',
  '/0/private/OpenOrders',
  '/0/private/GetApiKeyInfo',
])

interface ProxyBody {
  path?: string
  params?: Record<string, string | number>
  apiKey?: string
  apiSecret?: string
}

function sign(path: string, nonce: string, postData: string, secret: string): string {
  const decodedSecret = Buffer.from(secret.trim(), 'base64')
  const sha256 = crypto.createHash('sha256').update(nonce + postData).digest()
  return crypto
    .createHmac('sha512', decodedSecret)
    .update(Buffer.concat([Buffer.from(path, 'utf8'), sha256]))
    .digest('base64')
}

export async function POST(req: Request) {
  let body: ProxyBody
  try {
    body = (await req.json()) as ProxyBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const path = body.path
  const params = body.params ?? {}
  const apiKey = body.apiKey?.trim()
  const apiSecret = body.apiSecret?.trim()

  if (!path || !ALLOWED_PATHS.has(path)) {
    return NextResponse.json({ error: `path not allowed: ${path ?? '(none)'}` }, { status: 400 })
  }
  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: 'apiKey and apiSecret are required' }, { status: 400 })
  }

  const nonce = String(Date.now() * 1000 + Math.floor(Math.random() * 1000))
  const form = new URLSearchParams()
  form.set('nonce', nonce)
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'nonce') form.set(key, String(value))
  }
  const payload = form.toString()

  let apiSign: string
  try {
    apiSign = sign(path, nonce, payload, apiSecret)
  } catch {
    return NextResponse.json({ error: 'Could not generate Kraken API signature' }, { status: 400 })
  }

  try {
    const res = await fetch(`${KRAKEN_REST}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': apiSign,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: payload,
      cache: 'no-store',
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error'
    return NextResponse.json({ error: `Kraken unreachable: ${message}` }, { status: 502 })
  }
}
