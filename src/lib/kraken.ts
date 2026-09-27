// KRAKEN — spot triangular arbitrage paper-trading engine.
//
// Method: "buy cheap, sell expensive" (same as seabot, Curve & Binance tabs).
// Market data comes from the REAL Kraken public API
// (https://api.kraken.com/0/public/Ticker) which returns the live last-price
// for every watched pair. The bot covers the full Kraken product shelf:
//   - crypto majors quoted in USD (XBT/BTC, ETH, SOL, XRP, ADA, DOGE, DOT,
//     LINK, AVAX, LTC, tokenized gold XAU);
//   - stablecoins (USDC, USDT) and fiat crosses (EUR/USD, USD/CHF);
//   - crypto cross pairs (ETH/BTC, SOL/BTC, SOL/ETH, XRP/BTC, …) and
//     EUR-quoted pairs (XBT/EUR, ETH/EUR, …) used as implied legs.
//
// For each route the bot compares the DIRECT USD price (e.g. SOL/USD) against
// an IMPLIED price built from two legs (e.g. SOL/BTC × BTC/USD, or
// SOL/EUR × EUR/USD). When they diverge beyond a threshold, an arbitrage
// window exists: buy the token via the cheap leg and sell via the dear one.
//
// Engine layer: a deterministic mock (sine waves + noise bucket) is used as a
// fallback when the browser cannot reach Kraken. Pure functions, no I/O.
// Fictional USD capital — no real orders are placed.
//
// NOTE ON NAMES: the Kraken Ticker API resolves an assetpair to a canonical
// key (e.g. "XBTUSD" → "XXBTZUSD", "XRPXBT" → "XXRPXXBT"). Requesting the
// canonical key returns that same key in the response, so `symbol` below is
// always the canonical key used for both the request and the lookup.

export const KRAKEN_TICKER_API = "https://api.kraken.com/0/public/Ticker"

// ---- deterministic pseudo-random (same engine as seabot, curve & binance) ----
export function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Deterministic mock price for a Kraken pair. Anchored at the last real Kraken
 * quote with slow 3min/12min sine waves + per-20s noise and a small per-pair
 * offset so direct vs implied prices disagree slightly → arb windows.
 */
export function mockKrakenPrice(
  symbol: string,
  anchor: number,
  t = Date.now()
): number {
  const phase = seededRandom(symbol) * 6.2832
  const phase2 = seededRandom(symbol + "w") * 6.2832
  const wave1 = Math.sin((t / 180000) * 6.2832 + phase) * 0.0008
  const wave2 = Math.sin((t / 720000) * 6.2832 + phase2) * 0.0012
  const noiseBucket = Math.floor(t / 20000)
  const noise = (seededRandom(symbol + noiseBucket) - 0.5) * 0.0008
  const offset = (seededRandom(symbol + "off") - 0.5) * 0.0006
  const price = anchor * (1 + wave1 + wave2 + noise + offset)
  return Math.round(price * 1e5) / 1e5
}

export type KrakenKind =
  | "crypto"
  | "stable"
  | "gold"
  | "cross"
  | "fiat"

export type KrakenQuote =
  | "USD"
  | "EUR"
  | "CHF"
  | "XBT"
  | "ETH"
  | "USDT"
  | "USDC"

export interface KrakenAsset {
  symbol: string // canonical key used on the Kraken Ticker API
  base: string // e.g. "SOL"
  quote: string // e.g. "USD"
  quoteType: KrakenQuote
  kind: KrakenKind
  anchorPerQuote: number // last known real Kraken price (in `quote` units)
}

/**
 * Watchlist — real Kraken spot pairs (canonical keys, verified against the
 * live API). Covers USD/EUR-quoted majors, stablecoins, gold, fiat crosses
 * and crypto cross pairs.
 */
export const KRAKEN_ASSETS: KrakenAsset[] = [
  // USD-quoted majors
  { symbol: "XXBTZUSD", base: "XBT", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 83906.1 },
  { symbol: "XETHZUSD", base: "ETH", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 2684.26 },
  { symbol: "SOLUSD", base: "SOL", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 120.37 },
  { symbol: "XXRPZUSD", base: "XRP", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 1.54791 },
  { symbol: "ADAUSD", base: "ADA", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 0.254321 },
  { symbol: "XDGUSD", base: "DOGE", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 0.0974664 },
  { symbol: "DOTUSD", base: "DOT", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 1.2278 },
  { symbol: "LINKUSD", base: "LINK", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 13.96244 },
  { symbol: "AVAXUSD", base: "AVAX", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 10.605 },
  { symbol: "XLTCZUSD", base: "LTC", quote: "USD", quoteType: "USD", kind: "crypto", anchorPerQuote: 72.82 },
  // tokenized gold (Kraken-unique product)
  { symbol: "XAUTUSD", base: "XAU", quote: "USD", quoteType: "USD", kind: "gold", anchorPerQuote: 4282.4 },
  // stables
  { symbol: "USDCUSD", base: "USDC", quote: "USD", quoteType: "USD", kind: "stable", anchorPerQuote: 0.9998 },
  { symbol: "USDTZUSD", base: "USDT", quote: "USD", quoteType: "USD", kind: "stable", anchorPerQuote: 0.99981 },
  // crypto cross pairs (BTC legs)
  { symbol: "XETHXXBT", base: "ETH", quote: "XBT", quoteType: "XBT", kind: "cross", anchorPerQuote: 0.031991 },
  { symbol: "SOLXBT", base: "SOL", quote: "XBT", quoteType: "XBT", kind: "cross", anchorPerQuote: 0.0014345 },
  { symbol: "SOLETH", base: "SOL", quote: "ETH", quoteType: "ETH", kind: "cross", anchorPerQuote: 0.044818 },
  { symbol: "XXRPXXBT", base: "XRP", quote: "XBT", quoteType: "XBT", kind: "cross", anchorPerQuote: 0.00001844 },
  { symbol: "ADAXBT", base: "ADA", quote: "XBT", quoteType: "XBT", kind: "cross", anchorPerQuote: 0.00000303 },
  { symbol: "DOTXBT", base: "DOT", quote: "XBT", quoteType: "XBT", kind: "cross", anchorPerQuote: 0.00001453 },
  { symbol: "LINKXBT", base: "LINK", quote: "XBT", quoteType: "XBT", kind: "cross", anchorPerQuote: 0.00016653 },
  // EUR-quoted pairs (implied legs + direct on FX)
  { symbol: "XXBTZEUR", base: "XBT", quote: "EUR", quoteType: "EUR", kind: "crypto", anchorPerQuote: 73676 },
  { symbol: "XETHZEUR", base: "ETH", quote: "EUR", quoteType: "EUR", kind: "crypto", anchorPerQuote: 2357.13 },
  { symbol: "XXRPZEUR", base: "XRP", quote: "EUR", quoteType: "EUR", kind: "crypto", anchorPerQuote: 1.35844 },
  { symbol: "ADAEUR", base: "ADA", quote: "EUR", quoteType: "EUR", kind: "crypto", anchorPerQuote: 0.223433 },
  { symbol: "XDGEUR", base: "DOGE", quote: "EUR", quoteType: "EUR", kind: "crypto", anchorPerQuote: 0.0856453 },
  { symbol: "LINKEUR", base: "LINK", quote: "EUR", quoteType: "EUR", kind: "crypto", anchorPerQuote: 12.26943 },
  // fiat crosses
  { symbol: "ZEURZUSD", base: "EUR", quote: "USD", quoteType: "USD", kind: "fiat", anchorPerQuote: 1.13883 },
  { symbol: "USDCHF", base: "USD", quote: "CHF", quoteType: "CHF", kind: "fiat", anchorPerQuote: 0.82886 },
]

/**
 * A triangular arbitrage route on Kraken. `token` trades directly against a
 * quote (directSymbol, a USD-priced pair) and also through two legs
 * (crossSymbol × usdtSymbol). Example 1 (crypto): SOL/USD vs SOL/XBT × XBT/USD.
 * Example 2 (fiat cross): XBT/USD vs XBT/EUR × EUR/USD. When direct and
 * implied diverge the bot buys the cheap leg and sells the dear one.
 */
export interface KrakenTriangleRoute {
  id: string
  name: string // e.g. "SOL · BTC route"
  token: string // e.g. "SOL"
  directSymbol: string // e.g. "SOLUSD"
  crossSymbol: string // e.g. "SOLXBT"
  usdtSymbol: string // e.g. "XXBTZUSD" (quote of the cross pair in USD)
}

export const KRAKEN_TRIANGLES: KrakenTriangleRoute[] = [
  { id: "t_eth_b", name: "ETH · BTC route", token: "ETH", directSymbol: "XETHZUSD", crossSymbol: "XETHXXBT", usdtSymbol: "XXBTZUSD" },
  { id: "t_sol_b", name: "SOL · BTC route", token: "SOL", directSymbol: "SOLUSD", crossSymbol: "SOLXBT", usdtSymbol: "XXBTZUSD" },
  { id: "t_sol_e", name: "SOL · ETH route", token: "SOL", directSymbol: "SOLUSD", crossSymbol: "SOLETH", usdtSymbol: "XETHZUSD" },
  { id: "t_xrp_b", name: "XRP · BTC route", token: "XRP", directSymbol: "XXRPZUSD", crossSymbol: "XXRPXXBT", usdtSymbol: "XXBTZUSD" },
  { id: "t_ada_b", name: "ADA · BTC route", token: "ADA", directSymbol: "ADAUSD", crossSymbol: "ADAXBT", usdtSymbol: "XXBTZUSD" },
  { id: "t_dot_b", name: "DOT · BTC route", token: "DOT", directSymbol: "DOTUSD", crossSymbol: "DOTXBT", usdtSymbol: "XXBTZUSD" },
  { id: "t_link_b", name: "LINK · BTC route", token: "LINK", directSymbol: "LINKUSD", crossSymbol: "LINKXBT", usdtSymbol: "XXBTZUSD" },
  // cross-fiat routes: direct USD pair vs EUR-quoted pair × EUR/USD
  { id: "t_xbt_eur", name: "XBT · EUR route", token: "XBT", directSymbol: "XXBTZUSD", crossSymbol: "XXBTZEUR", usdtSymbol: "ZEURZUSD" },
  { id: "t_eth_eur", name: "ETH · EUR route", token: "ETH", directSymbol: "XETHZUSD", crossSymbol: "XETHZEUR", usdtSymbol: "ZEURZUSD" },
  { id: "t_xrp_eur", name: "XRP · EUR route", token: "XRP", directSymbol: "XXRPZUSD", crossSymbol: "XXRPZEUR", usdtSymbol: "ZEURZUSD" },
  { id: "t_ada_eur", name: "ADA · EUR route", token: "ADA", directSymbol: "ADAUSD", crossSymbol: "ADAEUR", usdtSymbol: "ZEURZUSD" },
  { id: "t_doge_eur", name: "DOGE · EUR route", token: "DOGE", directSymbol: "XDGUSD", crossSymbol: "XDGEUR", usdtSymbol: "ZEURZUSD" },
  { id: "t_link_eur", name: "LINK · EUR route", token: "LINK", directSymbol: "LINKUSD", crossSymbol: "LINKEUR", usdtSymbol: "ZEURZUSD" },
]

/** Product summary surfaced in the Kraken header. */
export const KRAKEN_PRODUCTS = {
  pairs: KRAKEN_ASSETS.length,
  routes: KRAKEN_TRIANGLES.length,
  cryptoQuotes: ["USD", "EUR", "USDT", "USDC"] as const,
  crossPairs: KRAKEN_ASSETS.filter((a) => a.kind === "cross").length,
  fiatPairs: KRAKEN_ASSETS.filter((a) => a.kind === "fiat").length,
}

/** A resolved quote returned by the live Ticker endpoint. */
export interface KrakenTickerQuote {
  symbol: string
  last: number
  bid: number
  ask: number
  vol24h: number // in quote units after last-24h rollover
}

/**
 * Fetch live Kraken quotes for a batch of canonical pair keys in ONE request.
 * The Ticker endpoint rejects the whole batch if any pair is unknown, so we
 * only ever pass symbols from KRAKEN_ASSETS (verified against the live API).
 */
export async function fetchKrakenTickers(
  symbols: string[]
): Promise<Record<string, KrakenTickerQuote>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const url = `${KRAKEN_TICKER_API}?pair=${encodeURIComponent(symbols.join(","))}`
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`kraken api ${res.status}`)
    const body = (await res.json()) as {
      error: string[]
      result?: Record<string, { c: string[]; b: string[]; a: string[]; v: string[] }>
    }
    if (body.error && body.error.length > 0) {
      throw new Error(body.error[0])
    }
    const rows: Record<string, KrakenTickerQuote> = {}
    const r = body.result ?? {}
    for (const key of Object.keys(r)) {
      const q = r[key]
      const last = parseFloat(Array.isArray(q.c) ? q.c[0] : "0")
      const bid = parseFloat(Array.isArray(q.b) ? q.b[0] : "0")
      const ask = parseFloat(Array.isArray(q.a) ? q.a[0] : "0")
      const vol = parseFloat(Array.isArray(q.v) ? q.v[1] ?? q.v[0] ?? "0" : "0")
      if (!isFinite(last)) continue
      rows[key] = {
        symbol: key,
        last,
        bid: isFinite(bid) ? bid : last,
        ask: isFinite(ask) ? ask : last,
        vol24h: isFinite(vol) ? vol : 0,
      }
    }
    return rows
  } finally {
    clearTimeout(t)
  }
}

export interface KrakenPriceRow {
  symbol: string
  base: string
  quote: string
  quoteType: KrakenQuote
  kind: KrakenKind
  lastRaw: number // price in the pair's own quote unit
  priceUsd: number // normalized to USD using live fiat/cross legs (or mock)
  anchorUsd: number
  change24hPct: number
  vol24h: number
  hasVol: boolean
}

/**
 * Build USD-normalized price rows from a raw quote map (live or mock).
 * quote → USD factors are read from the same map when present.
 */
export function buildKrakenRows(
  raw: Record<string, number>,
  live: Record<string, KrakenTickerQuote> | null,
  now: number,
  mode: "live" | "mock"
): KrakenPriceRow[] {
  const usdPerQuote: Partial<Record<KrakenQuote, number>> = {}
  const q = (key: string): number => raw[key] ?? 0
  usdPerQuote.USD = 1
  usdPerQuote.USDT = q("USDTZUSD") || 1
  usdPerQuote.USDC = q("USDCUSD") || 1
  usdPerQuote.EUR = q("ZEURZUSD")
  // USD/CHF: 1 USD = x CHF → 1 CHF = 1/x USD
  usdPerQuote.CHF = q("USDCHF") > 0 ? 1 / q("USDCHF") : 0
  usdPerQuote.XBT = q("XXBTZUSD")
  usdPerQuote.ETH = q("XETHZUSD")

  return KRAKEN_ASSETS.map((a) => {
    let lastRaw = a.anchorPerQuote
    let vol24h = 0
    if (mode === "live" && live) {
      const qq = live[a.symbol]
      if (qq) {
        lastRaw = qq.last
        vol24h = qq.vol24h
      }
    } else if (mode === "mock") {
      lastRaw = mockKrakenPrice(a.symbol, a.anchorPerQuote, now)
    }
    const factor = usdPerQuote[a.quoteType] ?? 1
    const priceUsd = factor > 0 ? lastRaw * factor : lastRaw
    const anchorUsd = a.anchorPerQuote * (usdPerQuote[a.quoteType] || 1)
    const change = anchorUsd > 0 ? ((priceUsd - anchorUsd) / anchorUsd) * 100 : 0
    return {
      symbol: a.symbol,
      base: a.base,
      quote: a.quote,
      quoteType: a.quoteType,
      kind: a.kind,
      lastRaw,
      priceUsd,
      anchorUsd,
      change24hPct: change,
      vol24h,
      hasVol: mode === "live",
    }
  })
}