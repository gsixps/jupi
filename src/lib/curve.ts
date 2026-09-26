// CURVE FINANCE — stablecoin arbitrage paper-trading engine (client-side).
//
// Method: like the seabot/Jupiter bots, "buy cheap, sell expensive". The
// market data layer is the REAL Curve Finance API
// (https://api.curve.fi/api/getPools/ethereum/main) which reports an implied
// usdPrice per coin per pool. Stablecoins should track $1, so when the same
// coin is quoted cheaper in one pool and dearer in another, the bot buys the
// cheap pool and sells the dear one (a classic Curve stablecoin arb).
//
// Engine layer: deterministic mock (sine waves + noise bucket) is used as a
// fallback when the browser cannot reach the Curve API (sandbox), exactly like
// the seabot demo data layer. Pure functions, no I/O.

export const CURVE_API_BASE = "https://api.curve.fi/api/getPools/ethereum/main"

export interface CurveCoin {
  address: string
  symbol: string
  name: string
  usdPrice: number // implied USD price for this coin in this pool
  poolBalance: number // raw pool balance (token units)
  decimals: number
}

export interface CurvePool {
  id: string
  name: string
  address: string
  assetTypeName: string
  usdTotal: number
  isBroken: boolean
  coins: CurveCoin[]
}

// ---- deterministic pseudo-random (same engine as seabot) ----
export function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Deterministic mock USD price for a stablecoin in a pool. Anchored to 1.0
 * with small sine waves (periods 3min + 12min) plus per-20s noise (±~8bps),
 * and a per-pool offset so different pools disagree slightly → arb windows.
 */
export function mockStableUsdPrice(
  poolAddress: string,
  coinSymbol: string,
  t = Date.now()
): number {
  const phase = seededRandom(poolAddress) * 6.2832
  const phase2 = seededRandom(poolAddress + coinSymbol) * 6.2832
  const wave1 = Math.sin((t / 180000) * 6.2832 + phase) * 0.0008
  const wave2 = Math.sin((t / 720000) * 6.2832 + phase2) * 0.0012
  const noiseBucket = Math.floor(t / 20000)
  const noise = (seededRandom(poolAddress + coinSymbol + noiseBucket) - 0.5) * 0.0008
  const offset = (seededRandom(poolAddress + "off") - 0.5) * 0.0006
  const price = 1 + wave1 + wave2 + noise + offset
  return Math.round(price * 1e8) / 1e8
}

/** Stablecoin pool seeds — classic Curve stable pools with their base prices. */
export const CURVE_STABLE_POOLS: CurvePool[] = [
  {
    id: "0",
    name: "Curve.fi DAI/USDC/USDT",
    address: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7",
    assetTypeName: "Stable",
    usdTotal: 161271712,
    isBroken: false,
    coins: [
      { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", name: "Dai Stablecoin", usdPrice: 1.00007, poolBalance: 0, decimals: 18 },
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", name: "USD Coin", usdPrice: 1, poolBalance: 0, decimals: 6 },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD", usdPrice: 1, poolBalance: 0, decimals: 6 },
    ],
  },
  {
    id: "1",
    name: "Curve.fi aDAI/aUSDC/aUSDT",
    address: "0xDeBF20617708857ebe4F679508E7b7863a8A8EeE",
    assetTypeName: "Stable",
    usdTotal: 304472,
    isBroken: false,
    coins: [
      { address: "0x028171bCA77440897B824Ca71D1c56caC55b68A3", symbol: "aDAI", name: "Aave DAI", usdPrice: 0.999326, poolBalance: 0, decimals: 18 },
      { address: "0xBcca60bB61934080951369a648Fb03DF4F96263C", symbol: "aUSDC", name: "Aave USDC", usdPrice: 0.999554, poolBalance: 0, decimals: 6 },
      { address: "0x3Ed3B47Dd13EC9a98b44e6204A523E766B225811", symbol: "aUSDT", name: "Aave USDT", usdPrice: 0.999372, poolBalance: 0, decimals: 6 },
    ],
  },
  {
    id: "3",
    name: "Curve.fi yDAI/yUSDC/yUSDT/yBUSD",
    address: "0x79a8C46DeA5aDa233ABaFFD40F3A0A2B1e5A4F27",
    assetTypeName: "Stable",
    usdTotal: 35131,
    isBroken: false,
    coins: [
      { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "yDAI", name: "Yield DAI", usdPrice: 0.999859, poolBalance: 0, decimals: 18 },
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", name: "USD Coin", usdPrice: 0.999907, poolBalance: 0, decimals: 6 },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD", usdPrice: 1, poolBalance: 0, decimals: 6 },
      { address: "0x8E870D67F660D95d5be530380D0eC0bd388289E1", symbol: "BUSD", name: "Binance USD", usdPrice: 0.999828, poolBalance: 0, decimals: 18 },
    ],
  },
  {
    id: "11",
    name: "Curve.fi aDAI/aSUSD",
    address: "0x8038C01A0390a8c547446a0b144a1c9A5c843dA0A",
    assetTypeName: "Stable",
    usdTotal: 151997,
    isBroken: false,
    coins: [
      { address: "0x028171bCA77440897B824Ca71D1c56caC55b68A3", symbol: "aDAI", name: "Aave DAI", usdPrice: 0.999326, poolBalance: 0, decimals: 18 },
      { address: "0x57Ab1ec28E1294350527a967282FbD34e911a", symbol: "sUSD", name: "Synthetix USD", usdPrice: 1.009515, poolBalance: 0, decimals: 18 },
    ],
  },
]

export interface CurvePoolRow extends CurvePool {
  // runtime fields
  quote: number // this pool's "stable quote" (weighted avg deviation from $1)
  deviationBps: number // signed deviation of the coin quote from $1, in bps
}

export interface CurveArbOpportunity {
  id: string
  coinSymbol: string
  buyPool: string // pool name
  sellPool: string // pool name
  buyPrice: number
  sellPrice: number
  profitBps: number
  inputUsd: number
  outUsd: number
  detectedAt: number
  executed: boolean
}

/** Pick a stablecoin the arbitrage actually trades (underscore = real coin). */
export function arbCoinSymbol(symbol: string): string {
  return symbol.replace(/^a/, "").replace(/^y/, "")
}