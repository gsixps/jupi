// CEX (Binance · Kraken) real-trading client — client-side HMAC-signed REST.
// API keys live in localStorage (user-provided), never sent to our servers.
// Binance: HMAC-SHA256 over query string. Kraken: SHA256(nonce+body) then
// HMAC-SHA512 over path + digest. Both exchanges allow browser CORS for
// signed requests, so orders can be placed straight from the dashboard.

export interface ExchangeCredentials {
  apiKey: string
  apiSecret: string
}

export type ExchangeKind = 'binance' | 'kraken' | 'bybit'

// ---- localStorage key per exchange ----
const CREDS_KEY: Record<ExchangeKind, string> = {
  binance: "jup_binance_creds_v1",
  kraken: "jup_kraken_creds_v1",
  bybit: "jup_bybit_creds_v1",
}

export function loadCreds(kind: ExchangeKind): ExchangeCredentials | null {
  try {
    const raw = localStorage.getItem(CREDS_KEY[kind])
    if (!raw) return null
    const c = JSON.parse(raw) as ExchangeCredentials
    if (c.apiKey && c.apiSecret) return c
    return null
  } catch {
    return null
  }
}

export function saveCreds(kind: ExchangeKind, c: ExchangeCredentials): void {
  localStorage.setItem(CREDS_KEY[kind], JSON.stringify(c))
}

export function clearCreds(kind: ExchangeKind): void {
  localStorage.removeItem(CREDS_KEY[kind])
}

// ---- WebCrypto HMAC helpers (works in the browser) ----
async function bytesToHex(bytes: ArrayBuffer): Promise<string> {
  const arr = new Uint8Array(bytes)
  let s = ""
  for (const b of arr) s += b.toString(16).padStart(2, "0")
  return s
}

async function hmacHex(secret: string, data: string, algo: "SHA-256" | "SHA-512"): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: algo },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data))
  return bytesToHex(sig)
}

function encodeQuery(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join("&")
}

export interface ExchangeBalance {
  symbol: string // asset, e.g. "USDT" / "XXBT"
  free: number
  locked: number
}

export interface ExchangeOrderResult {
  orderId: string
  symbol: string
  side: "BUY" | "SELL"
  type: "MARKET" | "LIMIT"
  executedQty: number
  executedQuote: number // quote currency amount filled
  price: number // average fill price (0 for unknown)
}

// ================= BINANCE =================
const BINANCE_REST = "https://api.binance.com/api/v3"

async function binanceSignedGet(path: string, params: Record<string, string | number>, cred: ExchangeCredentials): Promise<unknown> {
  const ts = Date.now()
  const qs = encodeQuery({ ...params, timestamp: ts })
  const signature = await hmacHex(cred.apiSecret, qs, "SHA-256")
  const res = await fetch(`${BINANCE_REST}${path}?${qs}&signature=${signature}`, {
    headers: { "X-MBX-APIKEY": cred.apiKey },
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Binance ${res.status}: ${t.slice(0, 240)}`)
  }
  return res.json()
}

async function binanceSignedPost(path: string, params: Record<string, string | number>, cred: ExchangeCredentials): Promise<unknown> {
  const ts = Date.now()
  const qs = encodeQuery({ ...params, timestamp: ts })
  const signature = await hmacHex(cred.apiSecret, qs, "SHA-256")
  const res = await fetch(`${BINANCE_REST}${path}?${qs}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": cred.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Binance ${res.status}: ${t.slice(0, 240)}`)
  }
  return res.json()
}

export async function binanceGetBalances(cred: ExchangeCredentials): Promise<ExchangeBalance[]> {
  const acc = (await binanceSignedGet("/account", {}, cred)) as {
    balances: { asset: string; free: string; locked: string }[]
  }
  return acc.balances.map((b) => ({
    symbol: b.asset,
    free: parseFloat(b.free),
    locked: isFinite(parseFloat(b.locked)) ? parseFloat(b.locked) : 0,
  }))
}

export interface BinanceMarketOrderOpts {
  cred: ExchangeCredentials
  symbol: string // e.g. "SOLUSDT"
  side: "BUY" | "SELL"
  /** quote notional for BUY (USDT amount), base quantity for SELL. */
  buyQuoteUsd?: number
  sellBaseQty?: number
}

export async function binanceMarketOrder(opts: BinanceMarketOrderOpts): Promise<ExchangeOrderResult> {
  const params: Record<string, string | number> = {
    symbol: opts.symbol,
    side: opts.side,
    type: "MARKET",
  }
  if (opts.side === "BUY") {
    if (!opts.buyQuoteUsd) throw new Error("buyQuoteUsd required for BUY")
    params.quoteOrderQty = Math.round(opts.buyQuoteUsd * 100) / 100
  } else {
    if (!opts.sellBaseQty) throw new Error("sellBaseQty required for SELL")
    params.quantity = Number(opts.sellBaseQty.toFixed(8))
  }
  const r = (await binanceSignedPost("/order", params, opts.cred)) as {
    orderId: string
    symbol: string
    side: string
    type: string
    executedQty: string
    cummulativeQuoteQty: string
    price: string
  }
  const executedQty = parseFloat(r.executedQty)
  const executedQuote = parseFloat(r.cummulativeQuoteQty)
  return {
    orderId: String(r.orderId),
    symbol: r.symbol,
    side: opts.side,
    type: "MARKET",
    executedQty,
    executedQuote,
    price: executedQty > 0 ? executedQuote / executedQty : NaN,
  }
}

/** Smallest tradable increment per symbol (lot size) — used to round SELL qty. */
export async function binanceLotSize(symbol: string): Promise<number> {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`)
    if (!res.ok) return 0.00000001
    const j = (await res.json()) as {
      symbols: { filters: { filterType: string; stepSize?: string }[] }[]
    }
    const f = j.symbols[0]?.filters.find((x) => x.filterType === "LOT_SIZE")
    if (f?.stepSize) {
      const s = parseFloat(f.stepSize)
      return isFinite(s) && s > 0 ? s : 0.00000001
    }
    return 0.00000001
  } catch {
    return 0.00000001
  }
}

// ================= KRAKEN =================
const KRAKEN_REST = "https://api.kraken.com"

async function krakenSignedPost(path: string, params: Record<string, string | number>, cred: ExchangeCredentials): Promise<unknown> {
  const nonce = Date.now() * 1000
  const body = encodeQuery({ ...params, nonce })
  const sha = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))
  const shaHex = await bytesToHex(sha)
  const sigInput = `${path}${shaHex}`
  const signature = await hmacHex(cred.apiSecret, sigInput, "SHA-512")
  const res = await fetch(`${KRAKEN_REST}${path}`, {
    method: "POST",
    headers: {
      "API-Key": cred.apiKey,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Kraken ${res.status}: ${t.slice(0, 240)}`)
  }
  const j = (await res.json()) as { error: string[]; result?: unknown }
  if (Array.isArray(j.error) && j.error.length > 0) {
    throw new Error(`Kraken error: ${j.error.join(", ")}`)
  }
  return j.result
}

export async function krakenGetBalances(cred: ExchangeCredentials): Promise<ExchangeBalance[]> {
  const result = (await krakenSignedPost("/0/private/Balance", {}, cred)) as Record<string, string>
  return Object.entries(result).map(([asset, free]) => ({
    symbol: asset,
    free: parseFloat(free),
    locked: 0,
  }))
}

export interface KrakenOrderOpts {
  cred: ExchangeCredentials
  pair: string // canonical pair, e.g. "XXBTZUSD"
  side: "buy" | "sell"
  volume: number // base asset volume
  ordertype?: "market" | "limit"
  price?: number // required when ordertype === 'limit'
}

export async function krakenMarketOrder(opts: KrakenOrderOpts): Promise<ExchangeOrderResult> {
  const result = (await krakenSignedPost(
    "/0/private/AddOrder",
    {
      pair: opts.pair,
      type: opts.side,
      ordertype: opts.ordertype ?? "market",
      ...(opts.ordertype === "limit" && opts.price ? { price: String(opts.price) } : {}),
      volume: Number(opts.volume.toFixed(8)),
      oflags: "fciq",
    },
    opts.cred
  )) as { txid: string[] }
  return {
    orderId: (result.txid ?? ["?"])[0] ?? "?",
    symbol: opts.pair,
    side: opts.side === "buy" ? "BUY" : "SELL",
    type: (opts.ordertype ?? "market").toUpperCase() as "MARKET",
    executedQty: opts.volume,
    executedQuote: 0,
    price: 0,
  }
}

/** Convert a human token code to the Kraken canonical base asset (e.g. BTC → XXBT, DOGE → XDG). */
export function krakenBaseAsset(token: string): string {
  if (token === "BTC") return "XXBT"
  if (token === "DOGE") return "XDG"
  if (token === "LTC") return "XLTC"
  if (["ETH", "XRP", "ADA", "DOT", "LINK", "SOL", "EUR", "USD"].includes(token)) return token
  return token
}

// ================= shared helpers (real mode) =================

// ---- Bybit V5 (xStocks spot + TradFi linear perps) ----
const BYBIT_REST = "https://api.bybit.com"
const BYBIT_RECV_WINDOW = "5000"

/**
 * V5 signing: HMAC-SHA256 over `timestamp + apiKey + recvWindow + payload`,
 * hex encoded. For GET the payload is the query string, for POST the raw JSON
 * body. The signature and the key travel in headers, never in the query.
 */
async function bybitSigned(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | number | boolean>,
  cred: ExchangeCredentials
): Promise<unknown> {
  const ts = String(Date.now())
  const query = encodeQuery(params as Record<string, string | number>)
  const body = method === 'POST' ? JSON.stringify(params) : ''
  const payload = method === 'POST' ? body : query
  const signature = await hmacHex(cred.apiSecret, ts + cred.apiKey + BYBIT_RECV_WINDOW + payload, 'SHA-256')
  const url = `${BYBIT_REST}${path}${method === 'GET' && query ? `?${query}` : ''}`
  const res = await fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY': cred.apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': BYBIT_RECV_WINDOW,
      'Content-Type': 'application/json',
    },
    ...(method === 'POST' ? { body } : {}),
  })
  const j = (await res.json()) as { retCode: number; retMsg: string; result?: unknown }
  if (!res.ok || j.retCode !== 0) {
    throw new Error(`Bybit ${j.retCode ?? res.status}: ${j.retMsg ?? res.statusText}`)
  }
  return j.result
}

/** Spot + linear USDT balances of the unified account. */
export async function bybitGetBalances(cred: ExchangeCredentials): Promise<ExchangeBalance[]> {
  const result = (await bybitSigned('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }, cred)) as {
    list: { coin: { coin: string; walletBalance: string; locked: string }[] }[]
  }
  const out: ExchangeBalance[] = []
  for (const acc of result.list ?? []) {
    for (const c of acc.coin ?? []) {
      const free = parseFloat(c.walletBalance) - parseFloat(c.locked || '0')
      if (isFinite(free) && free > 0) out.push({ symbol: c.coin, free, locked: parseFloat(c.locked || '0') })
    }
  }
  return out
}

export interface BybitOrderOpts {
  cred: ExchangeCredentials
  category: 'spot' | 'linear'
  symbol: string
  side: 'Buy' | 'Sell'
  qty: number
  /** Spot market buys are priced in USDT when marketUnit is quoteCoin. */
  marketUnit?: 'baseCoin' | 'quoteCoin'
  reduceOnly?: boolean
}

/** Place a Bybit v5 market order (spot or linear). */
export async function bybitMarketOrder(opts: BybitOrderOpts): Promise<ExchangeOrderResult> {
  const params: Record<string, string | number | boolean> = {
    category: opts.category,
    symbol: opts.symbol,
    side: opts.side,
    orderType: 'Market',
    qty: String(opts.qty),
    timeInForce: 'IOC',
    ...(opts.category === 'spot' ? { marketUnit: opts.marketUnit ?? 'baseCoin' } : {}),
    ...(opts.reduceOnly ? { reduceOnly: true } : {}),
  }
  const result = (await bybitSigned('POST', '/v5/order/create', params, opts.cred)) as {
    orderId: string
    orderLinkId: string
  }
  return {
    orderId: result.orderId ?? '?',
    symbol: opts.symbol,
    side: opts.side === 'Buy' ? 'BUY' : 'SELL',
    type: 'MARKET',
    executedQty: opts.qty,
    executedQuote: 0,
    price: 0,
  }
}

export async function bybitVerifyKeys(cred: ExchangeCredentials): Promise<{ ok: boolean; label: string }> {
  try {
    const bals = await bybitGetBalances(cred)
    const usdt = bals.find((b) => b.symbol === 'USDT')
    return { ok: true, label: `Claves válidas · USDT libre ${usdt ? usdt.free.toFixed(2) : '0.00'}` }
  } catch (e) {
    return { ok: false, label: `Claves inválidas: ${(e as Error).message.slice(0, 140)}` }
  }
}

/** Sanity check the API keys without placing an order. */
export async function verifyBinanceKeys(cred: ExchangeCredentials): Promise<{ ok: boolean; label: string }> {
  try {
    const bals = await binanceGetBalances(cred)
    const usdt = bals.find((b) => b.symbol === "USDT")
    return {
      ok: true,
      label: `Claves válidas · USDT libre ${usdt ? usdt.free.toFixed(2) : "0.00"}`,
    }
  } catch (e) {
    return { ok: false, label: `Claves inválidas: ${(e as Error).message.slice(0, 140)}` }
  }
}

export async function verifyKrakenKeys(cred: ExchangeCredentials): Promise<{ ok: boolean; label: string }> {
  try {
    const bals = await krakenGetBalances(cred)
    const usd = bals.find((b) => b.symbol === "ZUSD") ?? bals.find((b) => b.symbol === "USD")
    return {
      ok: true,
      label: `Claves válidas · USD libre ${usd ? usd.free.toFixed(2) : "0.00"}`,
    }
  } catch (e) {
    return { ok: false, label: `Claves inválidas: ${(e as Error).message.slice(0, 140)}` }
  }
}

/** Real market price for a token in USD (Binance public ticker — no key needed). */
export async function realTokenPriceUsd(token: string): Promise<number> {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${token}USDT`)
  if (!res.ok) throw new Error(`Precio ${token}USDT no disponible`)
  const j = (await res.json()) as { price: string }
  const p = parseFloat(j.price)
  if (!isFinite(p) || p <= 0) throw new Error(`Precio ${token}USDT inválido`)
  return p
}

/** Minimum tradable quote notional (USD) a symbol supports on Binance (real mode floor). */
export async function binanceMinNotional(symbol: string): Promise<number> {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`)
    if (!res.ok) return 5
    const j = (await res.json()) as {
      symbols: { filters: { filterType: string; minNotional?: string }[] }[]
    }
    const f = j.symbols[0]?.filters.find((x) => x.filterType === "MIN_NOTIONAL")
    const v = f?.minNotional ? parseFloat(f.minNotional) : NaN
    return isFinite(v) && v > 0 ? v : 5
  } catch {
    return 5
  }
}