// PUMPFUN — meme-coin paper-trading engine (client-side).
//
// Method: "buy cheap, sell expensive" on pump.fun memecoins. Unlike the pool
// arbitrage bots (curve / binance) there is no cross-pair spread here — every
// meme trades at ONE price on its bonding curve. The bot instead plays the
// TIME game: it hunts dips and rides pumps, exactly like the seabot floor
// engine. Each tick:
//   1. Refresh USD prices for the watched meme universe (LIVE pump.fun API,
//      with the deterministic mock engine as fallback for sandbox).
//   2. Score every coin as an OPPORTUNITY: cheapness vs. its drifted
//      reference, short-term momentum, and age (new listings are hot).
//   3. SELL open lots at take-profit / stop-loss / trailing-stop.
//   4. BUY coins that are cheap + opportunity-scored above the threshold.
//   5. Update stats + log everything.
//
// Capital is FICTIONAL (USD) in demo mode. In live mode the bot executes real
// Jupiter swaps, which requires a connected Phantom wallet AND a real on-chain
// mint for the coin — so only coins whose mint is a genuine base58 address are
// tradable.

export const PUMPFUN_API_BASE =
  "https://frontend-api.pump.fun/coins?limit=40&offset=0&sort=created_timestamp&order=DESC&includeNsfw=false"

/** Wrapped SOL mint — the funding side of every real swap. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112"
export const SOL_DECIMALS = 9

/** A Solana mint is a base58 address: 32–44 chars, no 0/O/I/l. */
export function isValidMint(mint: string | null | undefined): boolean {
  if (!mint) return false
  if (mint.length < 32 || mint.length > 44) return false
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)
}

/** Lamports per token, from a USD notional and a USD unit price. */
export function usdToBaseUnits(usd: number, priceUsd: number, decimals: number): number {
  if (!(priceUsd > 0)) return 0
  return Math.floor((usd / priceUsd) * Math.pow(10, decimals))
}

// ---- deterministic pseudo-random (same engine as the other bots) ----
export function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Deterministic mock USD price for a meme coin. Fast wave (~1.5min) plus a
 * slower cycle (~5min), a per-20s noise bucket (±~2.5%) so dips & pumps keep
 * appearing, and a small long-term drift. Coins flagged `isNew` get an extra
 * upward ramp so the bot keeps detecting new-listing opportunities.
 */
export function mockPumpUsdPrice(
  id: string,
  baseUsd: number,
  t = Date.now(),
  opts: { isNew?: boolean } = {}
): number {
  const phase = seededRandom(id) * 6.2832
  const phase2 = seededRandom(id + "w") * 6.2832
  const phase3 = seededRandom(id + "d") * 6.2832
  const wave1 = Math.sin((t / 90000) * 6.2832 + phase) * 0.015
  const wave2 = Math.sin((t / 300000) * 6.2832 + phase2) * 0.02
  const drift = Math.sin((t / 1200000) * 6.2832 + phase3) * 0.025
  const noiseBucket = Math.floor(t / 20000)
  const noise = (seededRandom(id + noiseBucket) - 0.5) * 0.05
  const ramp = opts.isNew ? 0.0000008 * (t % 600000) : 0
  const price = baseUsd * (1 + wave1 + wave2 + drift + noise) + ramp
  return Math.max(0.000000001, Math.round(price * 1e10) / 1e10)
}

/** Drifted "reference" price for a coin — what the market thinks it is worth. */
export function mockPumpRefUsd(
  id: string,
  baseUsd: number,
  t = Date.now()
): number {
  const phase = seededRandom(id + "ref") * 6.2832
  const slow = Math.sin((t / 360000) * 6.2832 + phase) * 0.012
  return Math.max(0.000000001, baseUsd * (1 + slow))
}

export interface PumpCoinSeed {
  id: string // mint-ish key
  symbol: string
  name: string
  emoji: string // display avatar
  baseUsd: number // reference USD price
  baseMcapUsd: number // reference USD market cap
  createdAgoMs: number // age at seed time
  liquidityUsd: number
  volumeUsd: number
  isNew: boolean // fresh listing → hotter opportunity
}

/** Curated pump.fun meme universe — micro to mid caps on the bonding curve. */
export const PUMP_COIN_SEEDS: PumpCoinSeed[] = [
  { id: "pump-billy", symbol: "BILLY", name: "Bill the Butcher", emoji: "🧑‍🍳", baseUsd: 0.000452, baseMcapUsd: 41500000, createdAgoMs: 21 * 3600000, liquidityUsd: 620000, volumeUsd: 1810000, isNew: false },
  { id: "pump-waddle", symbol: "WADDLE", name: "Waddle", emoji: "🐧", baseUsd: 0.000128, baseMcapUsd: 12800000, createdAgoMs: 6 * 3600000, liquidityUsd: 240000, volumeUsd: 830000, isNew: true },
  { id: "pump-burrrd", symbol: "BURRRD", name: "Burrrd", emoji: "🐣", baseUsd: 0.0000312, baseMcapUsd: 3120000, createdAgoMs: 45 * 3600000, liquidityUsd: 88000, volumeUsd: 210000, isNew: false },
  { id: "pump-tyson", symbol: "TYSON", name: "Tyson", emoji: "🥊", baseUsd: 0.00841, baseMcapUsd: 8400000, createdAgoMs: 14 * 3600000, liquidityUsd: 360000, volumeUsd: 1240000, isNew: true },
  { id: "pump-ponke", symbol: "PONKE", name: "Ponke", emoji: "🐒", baseUsd: 0.00096, baseMcapUsd: 96500000, createdAgoMs: 60 * 3600000, liquidityUsd: 980000, volumeUsd: 3200000, isNew: false },
  { id: "pump-peanut", symbol: "PNUT", name: "Peanut the Squirrel", emoji: "🐿️", baseUsd: 0.0042, baseMcapUsd: 42100000, createdAgoMs: 11 * 3600000, liquidityUsd: 510000, volumeUsd: 2100000, isNew: true },
  { id: "pump-michi", symbol: "MICHI", name: "Michi the Cat", emoji: "🐈", baseUsd: 0.000128, baseMcapUsd: 12800000, createdAgoMs: 33 * 3600000, liquidityUsd: 300000, volumeUsd: 760000, isNew: false },
  { id: "pump-sophie", symbol: "SOPHIE", name: "Sophie", emoji: "🦉", baseUsd: 0.000063, baseMcapUsd: 6330000, createdAgoMs: 26 * 3600000, liquidityUsd: 120000, volumeUsd: 430000, isNew: false },
  { id: "pump-boot", symbol: "BOOT", name: "Boot", emoji: "👢", baseUsd: 0.0000009, baseMcapUsd: 910000, createdAgoMs: 2 * 3600000, liquidityUsd: 25000, volumeUsd: 120000, isNew: true },
  { id: "pump-fartcoin", symbol: "FARTCOIN", name: "Fartcoin", emoji: "💨", baseUsd: 0.000212, baseMcapUsd: 21100000, createdAgoMs: 5 * 3600000, liquidityUsd: 270000, volumeUsd: 980000, isNew: true },
  { id: "pump-snow", symbol: "SNOW", name: "Snow", emoji: "❄️", baseUsd: 0.000034, baseMcapUsd: 3400000, createdAgoMs: 52 * 3600000, liquidityUsd: 75000, volumeUsd: 190000, isNew: false },
  { id: "pump-chigga", symbol: "CHIGGA", name: "Chigga", emoji: "🦀", baseUsd: 0.0016, baseMcapUsd: 162000000, createdAgoMs: 90 * 3600000, liquidityUsd: 1400000, volumeUsd: 4100000, isNew: false },
  { id: "pump-silly", symbol: "SILLY", name: "Silly Dragon", emoji: "🐲", baseUsd: 0.00041, baseMcapUsd: 41000000, createdAgoMs: 12 * 3600000, liquidityUsd: 490000, volumeUsd: 1500000, isNew: true },
  { id: "pump-whiff", symbol: "WHIFF", name: "Whiffle", emoji: "🌈", baseUsd: 0.000012, baseMcapUsd: 1220000, createdAgoMs: 8 * 3600000, liquidityUsd: 40000, volumeUsd: 160000, isNew: true },
  { id: "pump-nooodle", symbol: "NOODLE", name: "Noodle", emoji: "🍜", baseUsd: 0.00015, baseMcapUsd: 15100000, createdAgoMs: 19 * 3600000, liquidityUsd: 310000, volumeUsd: 890000, isNew: false },
  { id: "pump-bonk2", symbol: "BONK2", name: "Bonk v2", emoji: "🐕", baseUsd: 0.00000065, baseMcapUsd: 650000, createdAgoMs: 1 * 3600000, liquidityUsd: 16000, volumeUsd: 94000, isNew: true },
]

export interface PumpCoinRow {
  id: string
  symbol: string
  name: string
  emoji: string
  priceUsd: number
  refUsd: number // drifted market reference
  mcapUsd: number
  ageMs: number
  liquidityUsd: number
  volumeUsd: number
  isNew: boolean
  momentumPct: number // % change vs previous price
  score: number // 0..100 opportunity score
  verdict: 'buy' | 'hot' | 'neutral' | 'sell'
  /**
   * On-chain mint. Empty for the mock demo universe (those tokens do not
   * exist), so live mode skips them instead of sending a doomed swap.
   */
  mint: string
  decimals: number
}

export interface PumpOpportunity {
  id: string
  symbol: string
  name: string
  emoji: string
  priceUsd: number
  refUsd: number
  mcapUsd: number
  score: number
  momentumPct: number
  ageMs: number
  kind: 'new-listing' | 'dip' | 'momentum' | 'pump'
  reason: string
  detectedAt: number
  executed: boolean
}

/**
 * Opportunity scoring → 0..100. Higher is a better buy candidate.
 *  - cheapness: price below its reference (dips score high)
 *  - momentum: short-term rise confirms the move
 *  - newness: young listings get a bonus, they're the platform's hot zone
 *  - liquidity: thin pools are discounted (safer fills)
 */
export function scorePumpOpportunity(args: {
  priceUsd: number
  refUsd: number
  momentumPct: number
  ageMs: number
  liquidityUsd: number
  isNew: boolean
}): number {
  const { priceUsd, refUsd, momentumPct, ageMs, liquidityUsd, isNew } = args
  const rel = refUsd > 0 ? priceUsd / refUsd : 1
  const cheap = Math.max(0, Math.min(45, (1 - rel) * 100 * 3))
  const mom = Math.max(-15, Math.min(15, momentumPct))
  const momScore = mom > 0 ? Math.min(25, mom * 2.5) : mom * -0.8
  const ageScore = isNew
    ? Math.max(0, 20 - ageMs / (3600000))
    : Math.max(0, Math.min(8, 12 - ageMs / (3600000 * 10)))
  const liqPenalty = Math.max(0, Math.min(12, (300000 - liquidityUsd) / 50000))
  const raw = cheap + momScore + ageScore - liqPenalty
  return Math.max(0, Math.min(100, Math.round(raw)))
}

/** Verdict label from a price vs reference + score. */
export function pumpVerdict(
  priceUsd: number,
  refUsd: number,
  score: number
): PumpCoinRow['verdict'] {
  if (refUsd > 0 && priceUsd <= refUsd * 0.985) return 'buy'
  if (refUsd > 0 && priceUsd >= refUsd * 1.03) return 'sell'
  if (score >= 55) return 'hot'
  return 'neutral'
}

/** Pick a readable kind for a recorded opportunity. */
export function pumpOpportunityKind(
  score: number,
  priceUsd: number,
  refUsd: number,
  ageMs: number,
  isNew: boolean
): PumpOpportunity['kind'] {
  if (isNew && ageMs < 12 * 3600000 && score >= 50) return 'new-listing'
  if (refUsd > 0 && priceUsd >= refUsd * 1.02) return 'momentum'
  if (refUsd > 0 && priceUsd <= refUsd * 0.985 && score >= 50) return 'dip'
  return score >= 60 ? 'pump' : 'momentum'
}