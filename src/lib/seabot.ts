// SEABOT — NFT "buy low, sell high" paper-trading engine (client-side port).
//
// Ports the SeaSniper / "seabot" methodology (an OpenSea auto-trader) into the
// browser, mirroring the jupi paper-trading architecture:
//   - A set of watched NFT collections with REAL-ish floor prices.
//   - One tick = refresh floor prices → SELL (take-profit / stop-loss /
//     trailing-stop) → BUY (floor ≤ max buy price, budget/capacity allows).
//   - Fictional ETH capital, every P&L figure computed at the market rate.
//
// Market data layer: REAL OpenSea floors and sales through the server proxy
// /api/opensea (the API key stays on the server). The deterministic mock
// engine below only runs in the explicit SIMULATION data mode.

export const ETH_USD_PRICE = 3247.18

export interface SeabotCollectionSeed {
  slug: string
  name: string
  baseFloor: number // ETH
  supply: number
  owners: number
  totalVol: number
  chain: 'polygon' | 'ethereum'
  tier: 1 | 2 | 3 | 4
  minCapitalUsd: number
}

/** Curated collections — tiers 1..4, cheap Polygon → blue-chip Ethereum. */
export const SEABOT_COLLECTIONS: SeabotCollectionSeed[] = [
  { slug: 'my-art-668275197', name: 'My Art', baseFloor: 0.0007, supply: 1000, owners: 5, totalVol: 0.1, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'heavenly-dream-515030012', name: 'Heavenly Dream', baseFloor: 0.0009, supply: 1000, owners: 8, totalVol: 0.2, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'blackz-84567206', name: 'Blackz', baseFloor: 0.004, supply: 5000, owners: 50, totalVol: 1.0, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'vfs-751202961', name: 'VFS', baseFloor: 0.004, supply: 3000, owners: 45, totalVol: 0.8, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'supra-3-0', name: 'NEO', baseFloor: 0.004, supply: 8000, owners: 80, totalVol: 1.5, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'carf-109798033', name: 'Carf', baseFloor: 0.004, supply: 2000, owners: 30, totalVol: 0.5, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'folcw', name: 'Folcw', baseFloor: 0.004, supply: 4000, owners: 60, totalVol: 0.9, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'morfo-165915828', name: 'Morfo', baseFloor: 0.004, supply: 6000, owners: 70, totalVol: 1.2, chain: 'polygon', tier: 1, minCapitalUsd: 1 },
  { slug: 'the-last-guardian-336572531', name: 'The Last Guardian', baseFloor: 0.01, supply: 5000, owners: 100, totalVol: 5.0, chain: 'polygon', tier: 2, minCapitalUsd: 50 },
  { slug: 'bones-of-vice', name: 'Bones of Vice', baseFloor: 0.025, supply: 3000, owners: 200, totalVol: 15.0, chain: 'polygon', tier: 2, minCapitalUsd: 50 },
  { slug: 'verrucktes-etwas', name: 'Verruecktes Etwas', baseFloor: 0.05, supply: 2500, owners: 150, totalVol: 25.0, chain: 'polygon', tier: 2, minCapitalUsd: 50 },
  { slug: 'crystalkhatt', name: 'CrystalKhatt', baseFloor: 0.06, supply: 1000, owners: 100, totalVol: 20.0, chain: 'polygon', tier: 3, minCapitalUsd: 500 },
  { slug: 'nft-worlds', name: 'NFT Worlds', baseFloor: 1.499, supply: 10000, owners: 870, totalVol: 55942, chain: 'polygon', tier: 3, minCapitalUsd: 5000 },
  { slug: 'bored-ape-yacht-club', name: 'BAYC', baseFloor: 12.0, supply: 10000, owners: 5800, totalVol: 300000, chain: 'ethereum', tier: 4, minCapitalUsd: 50000 },
  { slug: 'cryptopunks', name: 'CryptoPunks', baseFloor: 30.0, supply: 10000, owners: 3700, totalVol: 380000, chain: 'ethereum', tier: 4, minCapitalUsd: 50000 },
  { slug: 'azuki', name: 'Azuki', baseFloor: 5.5, supply: 10000, owners: 5200, totalVol: 100000, chain: 'ethereum', tier: 4, minCapitalUsd: 50000 },
  { slug: 'pudgy-penguins', name: 'Pudgy Penguins', baseFloor: 6.0, supply: 8888, owners: 4900, totalVol: 56000, chain: 'ethereum', tier: 4, minCapitalUsd: 50000 },
]

// ---- deterministic pseudo-random (from the seabot project) ----
export function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Generate a realistic live floor price for a collection based on its base
 * floor and the current time. Continuous sine waves (fast 2-min + slower
 * 8-min), a slow daily drift and a per-20s noise bucket so prices move
 * visibly across ticks — giving the bot frequent buy-low / sell-high windows.
 * Identical to the seabot project's mockFloorPrice.
 */
export function mockFloorPrice(slug: string, baseFloor: number, t = Date.now()): number {
  const phase = seededRandom(slug) * 6.2832
  const phase2 = seededRandom(slug + 'x') * 6.2832
  const phase3 = seededRandom(slug + 'd') * 6.2832
  const wave1 = Math.sin((t / 120000) * 6.2832 + phase) * 0.045
  const wave2 = Math.sin((t / 480000) * 6.2832 + phase2) * 0.06
  const drift = Math.sin((t / (1000 * 60 * 60 * 12)) * 6.2832 + phase3) * 0.03
  const noiseBucket = Math.floor(t / 20000)
  const noise = (seededRandom(slug + noiseBucket) - 0.5) * 0.04
  const factor = 1 + wave1 + wave2 + drift + noise
  const price = baseFloor * factor
  return Math.max(0.001, Math.round(price * 10000) / 10000)
}

export interface SeabotCollection {
  slug: string
  name: string
  baseFloor: number
  tier: number
  minCapitalUsd: number
  floorPrice: number
  oneDayChange: number
  oneDayVolume: number
  watch: boolean
  maxBuyPrice: number
  targetProfitPct: number
  stopLossPct: number
  // REAL data (OpenSea) — absent in simulation mode
  oneDaySales?: number
  avg7dEth?: number
  chain?: string
  creatorFeePct?: number
  live?: boolean
  dataError?: string
}

export interface SeabotHolding {
  id: string
  collectionSlug: string
  collectionName: string
  tokenId: string
  buyPriceEth: number
  currentPriceEth: number
  peakPriceEth: number
  status: 'open' | 'sold'
  boughtAt: number
  soldAt?: number
  sellPriceEth?: number
  pnlEth?: number
}

export interface SeabotTrade {
  id: string
  type: 'buy' | 'sell'
  collectionSlug: string
  collectionName: string
  tokenId: string
  priceEth: number
  pnlEth: number
  reason: string
  status: 'filled' | 'pending' | 'failed'
  createdAt: number
}

export interface SeabotLogEntry {
  time: number
  level: 'info' | 'warn' | 'error' | 'trade'
  msg: string
}

export interface SeabotConfig {
  capitalEth: number
  budgetPerTradeEth: number
  maxHoldings: number
  globalTargetPct: number
  globalStopLossPct: number
  trailingStopPct: number
  tickIntervalMs: number
  compound: boolean // reinvest profits → per-trade budget scales with equity
  /** Buy/sell real NFTs on-chain with a connected wallet and real ETH. */
  liveTrading: boolean
  /** 'live' = real OpenSea floors/sales (needs OPENSEA_API_KEY on the
   *  server); 'mock' = explicit SIMULATION with synthetic floors. */
  dataMode: 'live' | 'mock'
  /** Buy when the floor is at least this % below the 7-day average sale. */
  dipPct: number
}

export const DEFAULT_SEABOT_CONFIG: SeabotConfig = {
  capitalEth: 10, // starting fictional ETH (~$32k) — enough to reach tier 3/4
  budgetPerTradeEth: 0.01, // ~$32 per NFT
  maxHoldings: 10,
  globalTargetPct: 7,
  globalStopLossPct: 5,
  trailingStopPct: 0, // 0 = disabled
  tickIntervalMs: 8000,
  compound: true,
  liveTrading: false,
  dataMode: 'live',
  dipPct: 5,
}

export interface SeabotStats {
  running: boolean
  startedAt: number | null
  uptimeMs: number
  capitalEth: number
  cashEth: number
  investedEth: number
  equityEth: number
  realizedPnlEth: number
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  openHoldings: number
  scanCount: number
  lastScanAt: number | null
  compound: boolean
  compoundFactor: number
}

const TOKEN_NAMES = ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10']

export function mockTokenId(slug: string, t: number): string {
  const seed = `${slug}${t}`
  const name = TOKEN_NAMES[Math.floor(seededRandom(seed) * TOKEN_NAMES.length)]
  const n = Math.floor(seededRandom(seed + 't') * 9999)
  return `${name}-${n}`
}
// ---- REAL market data (OpenSea via the server proxy /api/opensea) ----

export interface OpenSeaCollectionData {
  ok: boolean
  error?: string
  floorEth: number
  floorSymbol: string
  oneDaySales: number
  oneDayVolume: number
  sevenDaySales: number
  sevenDayVolume: number
  chain: string
  creatorFeePct: number
}

/** Live floors + sales for many collections. Throws with OpenSea's/the
 *  proxy's message when unavailable (e.g. no OPENSEA_API_KEY). */
export async function fetchOpenSeaCollections(
  slugs: string[]
): Promise<Record<string, OpenSeaCollectionData>> {
  const res = await fetch(`/api/opensea?slugs=${encodeURIComponent(slugs.join(','))}`, {
    cache: 'no-store',
  })
  const j = (await res.json().catch(() => ({}))) as {
    collections?: Record<string, OpenSeaCollectionData>
    error?: string
  }
  if (!res.ok || !j.collections) throw new Error(j.error ?? `OpenSea proxy ${res.status}`)
  return j.collections
}

/** Live ETH/USD (Binance public ticker). */
export async function fetchEthUsd(): Promise<number> {
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`ETH price ${res.status}`)
  const p = parseFloat(((await res.json()) as { price: string }).price)
  if (!(p > 0)) throw new Error('ETH price invalid')
  return p
}

/** OpenSea marketplace fee charged to the SELLER, in percent (assumption;
 *  creator fees come from the collection itself). */
export const OPENSEA_MARKET_FEE_PCT = 1

/** Rough gas of ONE NFT purchase or sale, in USD, per chain. */
export const NFT_GAS_USD: Record<string, number> = {
  ethereum: 3,
  matic: 0.02,
  polygon: 0.02,
  base: 0.05,
  arbitrum: 0.05,
}
export const nftGasUsd = (chain: string) => NFT_GAS_USD[chain] ?? 3

/** A sale only counts as fillable when the collection actually trades. */
export const MIN_DAILY_SALES_TO_SELL = 3
