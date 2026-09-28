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
// Signed calls go through the local /api/kraken proxy: Kraken has no CORS.
async function krakenSignedPost(path: string, params: Record<string, string | number>, cred: ExchangeCredentials): Promise<unknown> {
  // Kraken sends no Access-Control-Allow-Origin and answers the CORS preflight
  // with 404, so a browser cannot sign and read a request itself. The keys go to
  // this app's own /api/kraken route, which signs with Node crypto and forwards
  // to Kraken. They are never stored on the server.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  let res: Response
  try {
    res = await fetch("/api/kraken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, params, apiKey: cred.apiKey, apiSecret: cred.apiSecret }),
      signal: ctrl.signal,
    })
  } catch (e) {
    throw new Error(
      (e as Error).name === "AbortError"
        ? "Kraken no respondió en 20s (proxy local)"
        : `no se pudo contactar el proxy local /api/kraken: ${(e as Error).message}`
    )
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let j: { error?: string[]; result?: unknown }
  try {
    j = JSON.parse(text) as { error?: string[]; result?: unknown }
  } catch {
    throw new Error(`Kraken ${res.status}: respuesta ilegible`)
  }
  if (Array.isArray(j.error) && j.error.length > 0) {
    throw new Error(`Kraken error: ${j.error.join(", ")}`)
  }
  if (!res.ok) {
    throw new Error(`Kraken ${res.status}: ${text.slice(0, 200)}`)
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface KrakenOrderOpts {
  cred: ExchangeCredentials
  pair: string // canonical pair, e.g. "XXBTZUSD"
  side: "buy" | "sell"
  volume: number // base asset volume
  ordertype?: "market" | "limit"
  price?: number // required when ordertype === 'limit'
  /** How long to wait for Kraken to report the fill (default 15s). */
  fillTimeoutMs?: number
}

export interface KrakenOrderFilters {
  /** Minimum order cost in the quote currency (Kraken `costmin`). */
  costmin: number
  /** Minimum order volume in the base asset (Kraken `ordermin`). */
  ordermin: number
  /** Smallest tradable volume increment (10^-pair_decimals). */
  lot: number
}

/** Order constraints for a pair — honoured before sending any real order. */
export async function krakenOrderFilters(pair: string): Promise<KrakenOrderFilters> {
  const fallback: KrakenOrderFilters = { costmin: 0, ordermin: 0, lot: 0.00000001 }
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/AssetPairs?pair=${encodeURIComponent(pair)}`
    )
    if (!res.ok) return fallback
    const j = (await res.json()) as {
      error: string[]
      result?: Record<
        string,
        { costmin?: number; ordermin?: number; pair_decimals?: number; lot_decimals?: number }
      >
    }
    if (Array.isArray(j.error) && j.error.length > 0) return fallback
    const first = j.result ? Object.values(j.result)[0] : undefined
    if (!first) return fallback
    // `lot_decimals` is the VOLUME precision (`pair_decimals` is the price one).
    // XXBTZUSD reports 1 vs 8: using the price value would round every BTC order
    // down to zero and silently skip the route.
    const volumeDecimals = Number(first.lot_decimals ?? first.pair_decimals)
    return {
      costmin: Number(first.costmin ?? 0) || 0,
      ordermin: Number(first.ordermin ?? 0) || 0,
      lot: isFinite(volumeDecimals) && volumeDecimals > 0
        ? Math.pow(10, -volumeDecimals)
        : fallback.lot,
    }
  } catch {
    return fallback
  }
}

/** Round a base-asset volume down to the pair's tradable increment. */
export function krakenRoundVolume(volume: number, filters: KrakenOrderFilters): number {
  const lot = filters.lot > 0 ? filters.lot : 0.00000001
  const rounded = Math.floor(volume / lot) * lot
  // Re-parse to avoid binary float dust like 0.30000000000000004.
  return Number(rounded.toFixed(8))
}

export async function krakenMarketOrder(opts: KrakenOrderOpts): Promise<ExchangeOrderResult> {
  const volume = Number(opts.volume.toFixed(8))
  if (!(volume > 0)) throw new Error("volume must be > 0")
  const result = (await krakenSignedPost(
    "/0/private/AddOrder",
    {
      pair: opts.pair,
      type: opts.side,
      ordertype: opts.ordertype ?? "market",
      ...(opts.ordertype === "limit" && opts.price ? { price: String(opts.price) } : {}),
      volume,
      oflags: "fciq",
    },
    opts.cred
  )) as { txid: string[] }
  const txid = (result.txid ?? [])[0]
  if (!txid) throw new Error("Kraken did not return an order id")

  // AddOrder only acknowledges the order. Query it so callers get the real
  // filled volume and cost instead of assuming the whole amount filled.
  // Kraken fills asynchronously, so a single immediate read usually returns
  // zero; poll until the order stops reporting a partial execution.
  let executedQty = 0
  let executedQuote = 0
  let price = 0
  const deadline = Date.now() + (opts.fillTimeoutMs ?? 15_000)
  for (;;) {
    try {
      const q = (await krakenSignedPost("/0/private/QueryOrders", { txid }, opts.cred)) as Record<
        string,
        { vol_exec?: string; cost?: string; price?: string; status?: string; vol?: string }
      >
      const o = q[txid]
      if (o) {
        const volExec = parseFloat(o.vol_exec ?? "0") || 0
        // A closed/cancelled order is final: stop waiting and report what filled.
        const status = (o.status ?? "").toLowerCase()
        if (status === "closed" || status === "canceled" || status === "expired") {
          executedQty = volExec
          executedQuote = parseFloat(o.cost ?? "0") || 0
          price = parseFloat(o.price ?? "0") || 0
          break
        }
        if (volExec > 0) {
          executedQty = volExec
          executedQuote = parseFloat(o.cost ?? "0") || 0
          price = parseFloat(o.price ?? "0") || 0
          // Fully filled: nothing left to wait for.
          if (volExec >= (parseFloat(o.vol ?? "0") || 0) - 1e-12) break
        }
      }
    } catch {
      // Order placed but not verifiable — report zero fills so the bot halts
      // rather than assuming a position it cannot confirm.
      break
    }
    if (Date.now() >= deadline) break
    await sleep(700)
  }
  if (price > 0 && executedQty > 0 && executedQuote === 0) {
    executedQuote = price * executedQty
  }
  return {
    orderId: txid,
    symbol: opts.pair,
    side: opts.side === "buy" ? "BUY" : "SELL",
    type: (opts.ordertype ?? "market").toUpperCase() as "MARKET",
    executedQty,
    executedQuote,
    price: price > 0 ? price : executedQty > 0 ? executedQuote / executedQty : 0,
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

/**
 * Free USD balance on Kraken. The REST API names fiat USD `ZUSD` and also
 * exposes a `USD` alias, so accept either (or the USDT/USDC stables) and sum
 * the first one that actually holds funds.
 */
export function krakenUsdFree(balances: ExchangeBalance[]): number {
  const find = (keys: string[]): number => {
    for (const k of keys) {
      const b = balances.find((x) => x.symbol.toUpperCase() === k)
      if (b && b.free > 0) return b.free
    }
    return 0
  }
  return find(["ZUSD", "USD"]) || find(["USDT", "USDC"])
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

/** Free USDT balance on Bybit. */
export function bybitUsdtFree(balances: ExchangeBalance[]): number {
  const b = balances.find((x) => x.symbol.toUpperCase() === 'USDT')
  return b ? b.free : 0
}

/** Free balance of one coin on Bybit (e.g. the spot inventory of AAPLX). */
export function bybitCoinFree(balances: ExchangeBalance[], coin: string): number {
  const b = balances.find((x) => x.symbol.toUpperCase() === coin.toUpperCase())
  return b ? b.free : 0
}

export interface BybitOrderOpts {
  cred: ExchangeCredentials
  category: 'spot' | 'linear'
  symbol: string
  side: 'Buy' | 'Sell'
  /**
   * Order size. Interpreted according to `marketUnit`:
   *  - `quoteCoin` → the USDT notional to spend
   *  - `baseCoin`  → the coin quantity to trade
   * Linear perps are always sized in base coin, so the unit is ignored there.
   */
  qty: number
  marketUnit?: 'baseCoin' | 'quoteCoin'
  reduceOnly?: boolean
}

export interface BybitInstrumentFilters {
  /** Minimum order value in the quote coin, in USDT. */
  minOrderValueUsd: number
  /** Minimum tradable base quantity. */
  minOrderQty: number
  /** Tradable base quantity increment. */
  qtyStep: number
  /** Tradable quote increment; 0 when the venue sizes orders in base coin only. */
  quoteQtyStep: number
  /** Maximum base quantity per market order. */
  maxOrderQty: number
}

const BYBIT_FILTER_CACHE = new Map<string, BybitInstrumentFilters>()

const BYBIT_FILTER_FALLBACK: BybitInstrumentFilters = {
  minOrderValueUsd: 5,
  minOrderQty: 0.00001,
  qtyStep: 0.00001,
  quoteQtyStep: 0.01,
  maxOrderQty: Number.POSITIVE_INFINITY,
}

/** `basePrecision` / `quotePrecision` are decimal counts on spot, e.g. "0.001" → 3. */
function precisionToStep(precision: string | undefined): number {
  if (!precision) return 0
  const n = parseFloat(precision)
  if (!isFinite(n) || n <= 0) return 0
  // 0.001 → 3 decimals; 0.00001 → 5 decimals.
  const decimals = Math.round(-Math.log10(n))
  return Number(Math.pow(10, -decimals).toPrecision(12))
}

/**
 * Real order constraints for a symbol, read from `instruments-info`. Cached for
 * the session because these only change when the instrument changes.
 *
 * The field names differ per category: spot exposes `minOrderAmt` plus
 * `basePrecision`/`quotePrecision` (no `qtyStep`), while linear perps expose
 * `minNotionalValue` and `qtyStep`. Both shapes are handled here.
 */
export async function bybitInstrumentFilters(
  category: 'spot' | 'linear',
  symbol: string
): Promise<BybitInstrumentFilters> {
  const key = `${category}:${symbol}`
  const cached = BYBIT_FILTER_CACHE.get(key)
  if (cached) return cached

  const filters = await (async (): Promise<BybitInstrumentFilters> => {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/instruments-info?category=${category}&symbol=${symbol}`
      )
      if (!res.ok) return BYBIT_FILTER_FALLBACK
      const j = (await res.json()) as {
        retCode: number
        result?: {
          list?: {
            lotSizeFilter?: {
              minOrderQty?: string
              maxOrderQty?: string
              qtyStep?: string
              basePrecision?: string
              quotePrecision?: string
              minNotionalValue?: string
              maxMktOrderQty?: string
              maxMarketOrderQty?: string
            }
            minOrderValue?: string
            minOrderAmt?: string
          }[]
        }
      }
      if (j.retCode !== 0 || !j.result?.list?.length) return BYBIT_FILTER_FALLBACK
      const it = j.result.list[0]
      const lot = it.lotSizeFilter ?? {}
      const qtyStep = parseFloat(lot.qtyStep ?? '0') || precisionToStep(lot.basePrecision)
      return {
        minOrderValueUsd:
          parseFloat(it.minOrderValue ?? lot.minNotionalValue ?? it.minOrderAmt ?? '0') || 0,
        minOrderQty: parseFloat(lot.minOrderQty ?? '0') || 0,
        qtyStep: qtyStep || BYBIT_FILTER_FALLBACK.qtyStep,
        maxOrderQty:
          parseFloat(
            lot.maxMarketOrderQty ?? lot.maxMktOrderQty ?? lot.maxOrderQty ?? '0'
          ) || BYBIT_FILTER_FALLBACK.maxOrderQty,
        // Spot also accepts a USDT-sized order (quotePrecision); perps are
        // always base sized, so the quote step is not applicable there.
        quoteQtyStep:
          category === 'spot'
            ? precisionToStep(lot.quotePrecision) || BYBIT_FILTER_FALLBACK.quoteQtyStep
            : 0,
      }
    } catch {
      return BYBIT_FILTER_FALLBACK
    }
  })()

  BYBIT_FILTER_CACHE.set(key, filters)
  return filters
}

/** Round a base quantity down to the symbol's `qtyStep`. */
export function bybitRoundQty(qty: number, filters: BybitInstrumentFilters): number {
  const step = filters.qtyStep > 0 ? filters.qtyStep : BYBIT_FILTER_FALLBACK.qtyStep
  const rounded = Math.floor(qty / step) * step
  // Re-parse to strip binary float dust (0.30000000000000004 -> 0.3).
  return Number(rounded.toPrecision(12))
}

/** Round a USDT notional down to the symbol's tradable quote increment. */
export function bybitRoundQuote(
  notionalUsd: number,
  filters: BybitInstrumentFilters
): number {
  const step = filters.quoteQtyStep > 0 ? filters.quoteQtyStep : 0.01
  const rounded = Math.floor(notionalUsd / step) * step
  return Number(rounded.toPrecision(12))
}

/**
 * Place a Bybit v5 market order (spot or linear) and report the REAL fill.
 *
 * `/v5/order/create` only acknowledges the order, so the order is then polled
 * through `/v5/order/realtime` to read the executed quantity, quote amount and
 * average price. If the fill cannot be confirmed the result reports zero fills
 * so the caller halts instead of assuming a position it cannot verify.
 */
export async function bybitMarketOrder(opts: BybitOrderOpts): Promise<ExchangeOrderResult> {
  const params: Record<string, string | number | boolean> = {
    category: opts.category,
    symbol: opts.symbol,
    side: opts.side,
    orderType: 'Market',
    timeInForce: 'IOC',
    ...(opts.category === 'spot'
      ? { marketUnit: opts.marketUnit ?? 'baseCoin', qty: String(opts.qty) }
      : { qty: String(opts.qty) }),
    ...(opts.reduceOnly ? { reduceOnly: true } : {}),
  }
  const result = (await bybitSigned('POST', '/v5/order/create', params, opts.cred)) as {
    orderId: string
    orderLinkId: string
  }
  const orderId = result.orderId ?? '?'

  // Poll briefly: IOC market orders are normally filled immediately, but the
  // snapshot can lag by a fraction of a second.
  let executedQty = 0
  let executedQuote = 0
  let price = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const q = (await bybitSigned(
        'GET',
        '/v5/order/realtime',
        { category: opts.category, orderId },
        opts.cred
      )) as {
        list?: {
          cumExecQty?: string
          cumExecValue?: string
          avgPrice?: string
          orderStatus?: string
        }[]
      }
      const o = q.list?.[0]
      if (o) {
        executedQty = parseFloat(o.cumExecQty ?? '0') || 0
        executedQuote = parseFloat(o.cumExecValue ?? '0') || 0
        price = parseFloat(o.avgPrice ?? '0') || 0
        if (executedQty > 0 || o.orderStatus === 'Filled' || o.orderStatus === 'Cancelled') break
      }
    } catch {
      // fall through to the retry / zero-fill result
    }
    await new Promise((r) => setTimeout(r, 350))
  }
  if (price > 0 && executedQty > 0 && executedQuote === 0) {
    executedQuote = price * executedQty
  }
  return {
    orderId,
    symbol: opts.symbol,
    side: opts.side === 'Buy' ? 'BUY' : 'SELL',
    type: 'MARKET',
    executedQty,
    executedQuote,
    price: price > 0 ? price : executedQty > 0 ? executedQuote / executedQty : 0,
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

/**
 * Kraken's error codes are cryptic and each one has a different fix. `EAPI:
 * Invalid key` in particular does NOT mean the signature is wrong: Kraken
 * authenticates the key FIRST, so this only ever means the key string it
 * received is not one it knows.
 */
export function krakenErrorHint(code: string): string {
  const c = code.trim()
  if (/^EAPI:Invalid key$/i.test(c)) {
    return 'Kraken no reconoce esa API Key (la firma ni se comprueba: primero valida la clave). Revisa que hayas pegado la Key —no el Secret— del MISMO par de claves, sin espacios ni comillas, y que la clave no esté revocada. Kraken solo muestra el Secret una vez, al crearla.'
  }
  if (/^EAPI:Invalid signature$/i.test(c)) {
    return 'La Key es válida pero la firma no cuadra: el Secret no corresponde a esa Key, o se pegó con caracteres de más.'
  }
  if (/^EAPI:Invalid nonce$/i.test(c)) {
    return 'Nonce duplicado o fuera de rango. Vuelve a verificar en unos segundos.'
  }
  if (/^EAPI:Feature disabled$/i.test(c)) {
    return 'Esa clave no tiene permiso para esta operación. En Kraken, edita la clave y activa Query Funds (y Trade para operar).'
  }
  if (/^EAPI:Rate limit exceeded$/i.test(c)) {
    return 'Demasiadas peticiones a la API de Kraken. Espera unos segundos y reintenta.'
  }
  if (/^ESession:/i.test(c)) {
    return 'Kraken cerró la sesión de la clave. Revisa que la clave siga activa.'
  }
  if (/^EOrder:Insufficient funds$/i.test(c)) {
    return 'Saldo insuficiente en Kraken para esa moneda.'
  }
  if (/^EOrder:Insufficient funds or margin/i.test(c)) {
    return 'Saldo o margen insuficiente en Kraken.'
  }
  if (/^EOrder:Invalid volume$/i.test(c)) {
    return 'Kraken rechazó el volumen: por debajo del mínimo del par o con más decimales de los permitidos.'
  }
  if (/^EGeneral:Invalid arguments$/i.test(c)) {
    return 'Kraken rechazó los parámetros de la orden (volumen o par).'
  }
  if (/^EAPI:Invalid arguments$/i.test(c)) {
    return 'Kraken rechazó los parámetros enviados por el proxy.'
  }
  return ''
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
    const raw = (e as Error).message
    const code = raw.match(/Kraken error: (.*)$/)?.[1] ?? ""
    const hint = krakenErrorHint(code)
    return {
      ok: false,
      label: hint ? `Claves rechazadas: ${code} — ${hint}` : `Claves inválidas: ${raw.slice(0, 160)}`,
    }
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