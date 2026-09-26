// BINANCE — spot triangular arbitrage paper-trading engine.
//
// Method: "buy cheap, sell expensive" (same as seabot & Curve tabs). Market
// data comes from the REAL Binance API
// (https://api.binance.com/api/v3/ticker/price) which returns the live price
// for every symbol. For each watched token the bot compares the DIRECT USD
// price (e.g. SOLUSDT) against the IMPLIED price through a cross leg
// (SOLBTC × BTCUSDT). When the two diverge beyond a threshold, an arbitrage
// window exists: buy the token via the cheap leg and sell via the dear one.
//
// Engine layer: a deterministic mock (sine waves + noise bucket) is used as a
// fallback when the browser cannot reach Binance (sandbox) — identical to the
// seabot / Curve demo data layer. Pure functions, no I/O.

export const BINANCE_API_BASE = "https://api.binance.com/api/v3/ticker/price"

// ---- deterministic pseudo-random (same engine as seabot & curve) ----
export function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Deterministic mock USD price for a spot symbol. Anchored at the last real
 * Binance quote with slow 3min/12min sine waves + per-20s noise, plus a small
 * per-pair offset so direct vs implied prices disagree slightly → arb windows.
 */
export function mockSymbolUsdPrice(
  symbol: string,
  anchorUsd: number,
  t = Date.now()
): number {
  const phase = seededRandom(symbol) * 6.2832
  const phase2 = seededRandom(symbol + "w") * 6.2832
  const wave1 = Math.sin((t / 180000) * 6.2832 + phase) * 0.0008
  const wave2 = Math.sin((t / 720000) * 6.2832 + phase2) * 0.0012
  const noiseBucket = Math.floor(t / 20000)
  const noise = (seededRandom(symbol + noiseBucket) - 0.5) * 0.0008
  const offset = (seededRandom(symbol + "off") - 0.5) * 0.0006
  const price = anchorUsd * (1 + wave1 + wave2 + noise + offset)
  return Math.round(price * 1e5) / 1e5
}

export interface BinanceSymbol {
  symbol: string // e.g. "SOLUSDT"
  base: string // e.g. "SOL"
  quote: string // e.g. "USDT"
  anchorUsd: number // last known real Binance price (USD)
}

/** Watchlist — every symbol also exists on Binance spot. */
export const BINANCE_SYMBOLS: BinanceSymbol[] = [
  // USD-quoted majors
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT", anchorUsd: 83978.56 },
  { symbol: "ETHUSDT", base: "ETH", quote: "USDT", anchorUsd: 2688.22 },
  { symbol: "SOLUSDT", base: "SOL", quote: "USDT", anchorUsd: 120.73 },
  { symbol: "BNBUSDT", base: "BNB", quote: "USDT", anchorUsd: 773.42 },
  { symbol: "XRPUSDT", base: "XRP", quote: "USDT", anchorUsd: 1.5536 },
  { symbol: "ADAUSDT", base: "ADA", quote: "USDT", anchorUsd: 0.7421 },
  { symbol: "DOGEUSDT", base: "DOGE", quote: "USDT", anchorUsd: 0.1984 },
  { symbol: "DOTUSDT", base: "DOT", quote: "USDT", anchorUsd: 6.71 },
  { symbol: "LINKUSDT", base: "LINK", quote: "USDT", anchorUsd: 18.42 },
  { symbol: "AVAXUSDT", base: "AVAX", quote: "USDT", anchorUsd: 35.87 },
  { symbol: "LTCUSDT", base: "LTC", quote: "USDT", anchorUsd: 92.33 },
  // cross pairs (implied legs)
  { symbol: "ETHBTC", base: "ETH", quote: "BTC", anchorUsd: 0.03201 },
  { symbol: "SOLBTC", base: "SOL", quote: "BTC", anchorUsd: 0.0014377 },
  { symbol: "SOLETH", base: "SOL", quote: "ETH", anchorUsd: 0.0449 },
  { symbol: "BNBBTC", base: "BNB", quote: "BTC", anchorUsd: 0.009209 },
  { symbol: "BNBETH", base: "BNB", quote: "ETH", anchorUsd: 0.2876 },
  { symbol: "XRPBTC", base: "XRP", quote: "BTC", anchorUsd: 0.0000185 },
  { symbol: "XRPETH", base: "XRP", quote: "ETH", anchorUsd: 0.0005777 },
  { symbol: "ADABTC", base: "ADA", quote: "BTC", anchorUsd: 0.00000884 },
  { symbol: "DOTBTC", base: "DOT", quote: "BTC", anchorUsd: 0.0000799 },
  { symbol: "LINKBTC", base: "LINK", quote: "BTC", anchorUsd: 0.0002194 },
  { symbol: "AVAXBTC", base: "AVAX", quote: "BTC", anchorUsd: 0.0004271 },
  { symbol: "LTCBTC", base: "LTC", quote: "BTC", anchorUsd: 0.0010995 },
]

/**
 * A triangular arbitrage route. `token` trades against USDT directly
 * (directSymbol) and through a cross pair, e.g. SOLUSDT vs SOLBTC × BTCUSDT.
 * When direct and implied diverge, the bot buys the cheap leg and sells the
 * dear one (a classic cross-venue-free triangle arb on Binance).
 */
export interface BinanceTriangleRoute {
  id: string
  name: string // e.g. "SOL · BTC route"
  token: string // e.g. "SOL"
  directSymbol: string // e.g. "SOLUSDT"
  crossSymbol: string // e.g. "SOLBTC"
  usdtSymbol: string // e.g. "BTCUSDT" (quote of the cross pair in USD)
}

export const BINANCE_TRIANGLES: BinanceTriangleRoute[] = [
  { id: "t_eth_b", name: "ETH · BTC route", token: "ETH", directSymbol: "ETHUSDT", crossSymbol: "ETHBTC", usdtSymbol: "BTCUSDT" },
  { id: "t_sol_b", name: "SOL · BTC route", token: "SOL", directSymbol: "SOLUSDT", crossSymbol: "SOLBTC", usdtSymbol: "BTCUSDT" },
  { id: "t_sol_e", name: "SOL · ETH route", token: "SOL", directSymbol: "SOLUSDT", crossSymbol: "SOLETH", usdtSymbol: "ETHUSDT" },
  { id: "t_bnb_b", name: "BNB · BTC route", token: "BNB", directSymbol: "BNBUSDT", crossSymbol: "BNBBTC", usdtSymbol: "BTCUSDT" },
  { id: "t_bnb_e", name: "BNB · ETH route", token: "BNB", directSymbol: "BNBUSDT", crossSymbol: "BNBETH", usdtSymbol: "ETHUSDT" },
  { id: "t_xrp_b", name: "XRP · BTC route", token: "XRP", directSymbol: "XRPUSDT", crossSymbol: "XRPBTC", usdtSymbol: "BTCUSDT" },
  { id: "t_xrp_e", name: "XRP · ETH route", token: "XRP", directSymbol: "XRPUSDT", crossSymbol: "XRPETH", usdtSymbol: "ETHUSDT" },
  { id: "t_ada_b", name: "ADA · BTC route", token: "ADA", directSymbol: "ADAUSDT", crossSymbol: "ADABTC", usdtSymbol: "BTCUSDT" },
  { id: "t_dot_b", name: "DOT · BTC route", token: "DOT", directSymbol: "DOTUSDT", crossSymbol: "DOTBTC", usdtSymbol: "BTCUSDT" },
  { id: "t_link_b", name: "LINK · BTC route", token: "LINK", directSymbol: "LINKUSDT", crossSymbol: "LINKBTC", usdtSymbol: "BTCUSDT" },
  { id: "t_avax_b", name: "AVAX · BTC route", token: "AVAX", directSymbol: "AVAXUSDT", crossSymbol: "AVAXBTC", usdtSymbol: "BTCUSDT" },
  { id: "t_ltc_b", name: "LTC · BTC route", token: "LTC", directSymbol: "LTCUSDT", crossSymbol: "LTCBTC", usdtSymbol: "BTCUSDT" },
]

export interface BinancePriceRow {
  symbol: string
  base: string
  quote: string
  priceUsd: number
  anchorUsd: number
}

export interface BinanceArbOpportunity {
  id: string
  routeId: string
  name: string
  side: "direct_cheap" | "cross_cheap"
  buyPrice: number // USD price paid for token via cheap leg
  sellPrice: number // USD price received via dear leg (normalized per token)
  spreadBps: number
  notionalUsd: number
  profitUsd: number
  detectedAt: number
  executed: boolean
}