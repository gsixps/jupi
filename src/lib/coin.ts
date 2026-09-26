// COIN ASSETS — single-asset cross-pair accumulation bot (Bitcoin / Ethereum).
//
// Method: "buy cheap, sell expensive, and HOLD the asset". The same coin (BTC
// or ETH) is quoted on Binance against different stablecoins (USDT, USDC,
// FDUSD). Because those quotes drift apart, the bot buys the coin on the
// CHEAPEST pair and later sells on the DEAREST pair, netting +coin every cycle.
// Open lots ARE the stored coin: the equity is the stored balance re-priced.
//
// Market data: live Binance ticker/price API, with the deterministic mock
// (sine waves + noise) as fallback — identical to the seabot / curve / binance
// demo layers. Pure functions, no I/O.

export const BINANCE_API_BASE = "https://api.binance.com/api/v3/ticker/price"

// ---- deterministic pseudo-random (same engine as the other bots) ----
export function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/** Deterministic mock USD price for a trailing pair of the same coin. */
export function mockCoinUsdPrice(
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

export interface CoinPair {
  symbol: string // e.g. "BTCUSDT"
  quote: string // e.g. "USDT"
  anchorUsd: number // last known real Binance price (USD)
}

export interface CoinAssetDef {
  key: 'btc' | 'eth'
  name: string // "Bitcoin"
  symbol: string // "BTC"
  accent: 'amber' | 'indigo'
  pairs: CoinPair[]
  capitalUsd: number
  budgetPerTradeUsd: number
  maxHoldings: number
  minSpreadBps: number // buy when cheapest vs dearest spread ≥ this
  targetPct: number // take-profit % above buy price
  stopLossPct: number
  trailingPct: number
  tickIntervalMs: number
}

export const COIN_ASSETS: Record<'btc' | 'eth', CoinAssetDef> = {
  btc: {
    key: 'btc',
    name: 'Bitcoin',
    symbol: 'BTC',
    accent: 'amber',
    pairs: [
      { symbol: 'BTCUSDT', quote: 'USDT', anchorUsd: 83926 },
      { symbol: 'BTCUSDC', quote: 'USDC', anchorUsd: 83931.99 },
      { symbol: 'BTCFDUSD', quote: 'FDUSD', anchorUsd: 83980.87 },
    ],
    capitalUsd: 10000,
    budgetPerTradeUsd: 500,
    maxHoldings: 20,
    minSpreadBps: 3,
    targetPct: 1.5,
    stopLossPct: 0.5,
    trailingPct: 0.4,
    tickIntervalMs: 10000,
  },
  eth: {
    key: 'eth',
    name: 'Ethereum',
    symbol: 'ETH',
    accent: 'indigo',
    pairs: [
      { symbol: 'ETHUSDT', quote: 'USDT', anchorUsd: 2686.7 },
      { symbol: 'ETHUSDC', quote: 'USDC', anchorUsd: 2686.79 },
      { symbol: 'ETHFDUSD', quote: 'FDUSD', anchorUsd: 2688.0 },
    ],
    capitalUsd: 10000,
    budgetPerTradeUsd: 500,
    maxHoldings: 20,
    minSpreadBps: 3,
    targetPct: 1.5,
    stopLossPct: 0.5,
    trailingPct: 0.4,
    tickIntervalMs: 10000,
  },
}

export interface CoinPriceRow {
  symbol: string
  quote: string
  priceUsd: number
  anchorUsd: number
}

export interface CoinArbSignal {
  id: string
  cheapestSymbol: string
  dearestSymbol: string
  cheapestUsd: number
  dearestUsd: number
  spreadBps: number
  detectedAt: number
}