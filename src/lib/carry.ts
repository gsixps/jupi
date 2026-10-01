// CARRY — yield engine: USDC on Aave + delta-neutral funding carry on Bybit.
//
//   BASE:   idle capital earns the REAL Aave v3 USDC supply rate (Base),
//           compounded every tick (Aave itself compounds every block).
//   CARRY:  when a Bybit USDT perpetual pays a high AND stable funding rate,
//           part of the capital buys the asset on SPOT and shorts the same
//           quantity on the PERP. Price moves cancel; the short collects the
//           funding at every settlement while the rate is positive.
//   ROTATE: switch to a better-paying asset only when the extra yield pays
//           the round-trip costs within the planning horizon; go back to
//           Aave when the funding no longer beats it.
//
// Costs: Bybit taker fees (spot 0.10%, perp 0.055%, per side) and the real
// bid/ask of both legs at entry and exit. All market data is REAL; there is
// no simulated fallback.

export const AAVE_POOL_ID = '7e0661bf-8cf3-45e6-9424-31916d4c7b84' // Aave v3 USDC on Base (DefiLlama)
export const SPOT_FEE = 0.001
export const PERP_FEE = 0.00055
export const MIN_ORDER_USD = 5
const YEAR_MS = 365 * 24 * 3_600_000

export interface CarryCandidate {
  id: string
  label: string
  spot: string
  perp: string
}

export const CARRY_CANDIDATES: CarryCandidate[] = [
  { id: 'btc', label: 'BTC', spot: 'BTCUSDT', perp: 'BTCUSDT' },
  { id: 'eth', label: 'ETH', spot: 'ETHUSDT', perp: 'ETHUSDT' },
  { id: 'sol', label: 'SOL', spot: 'SOLUSDT', perp: 'SOLUSDT' },
  { id: 'xrp', label: 'XRP', spot: 'XRPUSDT', perp: 'XRPUSDT' },
  { id: 'doge', label: 'DOGE', spot: 'DOGEUSDT', perp: 'DOGEUSDT' },
  { id: 'ada', label: 'ADA', spot: 'ADAUSDT', perp: 'ADAUSDT' },
  { id: 'link', label: 'LINK', spot: 'LINKUSDT', perp: 'LINKUSDT' },
  { id: 'avax', label: 'AVAX', spot: 'AVAXUSDT', perp: 'AVAXUSDT' },
  { id: 'sui', label: 'SUI', spot: 'SUIUSDT', perp: 'SUIUSDT' },
  { id: 'ltc', label: 'LTC', spot: 'LTCUSDT', perp: 'LTCUSDT' },
  // tokenized stocks: spot xStock vs the TradFi perp on the same underlying
  { id: 'nvda', label: 'NVDA (xStock)', spot: 'NVDAXUSDT', perp: 'NVDAUSDT' },
  { id: 'tsla', label: 'TSLA (xStock)', spot: 'TSLAXUSDT', perp: 'TSLAUSDT' },
  { id: 'googl', label: 'GOOGL (xStock)', spot: 'GOOGLXUSDT', perp: 'GOOGLUSDT' },
  { id: 'aapl', label: 'AAPL (xStock)', spot: 'AAPLXUSDT', perp: 'AAPLUSDT' },
  { id: 'amzn', label: 'AMZN (xStock)', spot: 'AMZNXUSDT', perp: 'AMZNUSDT' },
  { id: 'meta', label: 'META (xStock)', spot: 'METAXUSDT', perp: 'METAUSDT' },
  { id: 'hood', label: 'HOOD (xStock)', spot: 'HOODXUSDT', perp: 'HOODUSDT' },
  { id: 'coin', label: 'COIN (xStock)', spot: 'COINXUSDT', perp: 'COINUSDT' },
]

export interface CarryQuote {
  spotBid: number
  spotAsk: number
  perpBid: number
  perpAsk: number
  /** current funding rate per interval (fraction) */
  fundingRate: number
  fundingIntervalH: number
  nextFundingTime: number
  perpVolumeUsd: number
}

export interface FundingStats {
  /** annualized mean of the settled rates over the window */
  avgApr: number
  /** annualized mean over the last 24 h */
  avg24hApr: number
  /** share of settlements with a positive rate */
  positiveShare: number
  samples: number
}

export interface CandidateView extends CarryCandidate {
  quote: CarryQuote | null
  funding: FundingStats | null
  currentApr: number
  /** round-trip cost fraction (fees of 4 fills + both book spreads) */
  roundTripCost: number
  /** yield over Aave, annualized, if eligible */
  edgeApr: number
  eligible: boolean
  why: string
}

// ---------------------------------------------------------------- data

async function getJson<T>(url: string, ms = 12000): Promise<T> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

/** Current Aave v3 USDC supply APY on Base, as a fraction (0.042 = 4.2%). */
export async function fetchAaveApy(): Promise<number> {
  const j = await getJson<{ data?: { apy?: number }[] }>(`https://yields.llama.fi/chart/${AAVE_POOL_ID}`, 20000)
  const last = j.data?.[j.data.length - 1]
  const apy = Number(last?.apy)
  if (!isFinite(apy) || apy < 0) throw new Error('Aave APY no disponible')
  return apy / 100
}

interface BybitTicker {
  symbol: string
  bid1Price?: string
  ask1Price?: string
  fundingRate?: string
  fundingIntervalHour?: string
  nextFundingTime?: string
  turnover24h?: string
}

/** Books of both legs + current funding for every candidate. */
export async function fetchCarryQuotes(): Promise<Record<string, CarryQuote>> {
  const [spot, lin] = await Promise.all([
    getJson<{ retCode: number; result: { list: BybitTicker[] } }>('https://api.bybit.com/v5/market/tickers?category=spot'),
    getJson<{ retCode: number; result: { list: BybitTicker[] } }>('https://api.bybit.com/v5/market/tickers?category=linear'),
  ])
  if (spot.retCode !== 0 || lin.retCode !== 0) throw new Error('Bybit tickers error')
  const S = new Map(spot.result.list.map((t) => [t.symbol, t]))
  const L = new Map(lin.result.list.map((t) => [t.symbol, t]))
  const out: Record<string, CarryQuote> = {}
  for (const c of CARRY_CANDIDATES) {
    const s = S.get(c.spot)
    const l = L.get(c.perp)
    if (!s || !l) continue
    const q: CarryQuote = {
      spotBid: parseFloat(s.bid1Price ?? '0'),
      spotAsk: parseFloat(s.ask1Price ?? '0'),
      perpBid: parseFloat(l.bid1Price ?? '0'),
      perpAsk: parseFloat(l.ask1Price ?? '0'),
      fundingRate: parseFloat(l.fundingRate ?? '0') || 0,
      fundingIntervalH: parseFloat(l.fundingIntervalHour ?? '8') || 8,
      nextFundingTime: Number(l.nextFundingTime ?? 0),
      perpVolumeUsd: parseFloat(l.turnover24h ?? '0') || 0,
    }
    if (q.spotBid > 0 && q.spotAsk > 0 && q.perpBid > 0 && q.perpAsk > 0) out[c.id] = q
  }
  return out
}

/** Settled funding over the last `days`, annualized. */
export async function fetchFundingStats(perp: string, intervalH: number, days = 7): Promise<FundingStats> {
  const j = await getJson<{ retCode: number; result: { list: { fundingRate: string; fundingRateTimestamp: string }[] } }>(
    `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${perp}&limit=200`
  )
  if (j.retCode !== 0) throw new Error(`funding ${perp}`)
  const now = Date.now()
  const rows = j.result.list
    .map((r) => ({ rate: parseFloat(r.fundingRate) || 0, t: Number(r.fundingRateTimestamp) }))
    .filter((r) => now - r.t <= days * 86_400_000)
  const perYear = (24 / intervalH) * 365
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const last24 = rows.filter((r) => now - r.t <= 86_400_000).map((r) => r.rate)
  return {
    avgApr: mean(rows.map((r) => r.rate)) * perYear,
    avg24hApr: mean(last24) * perYear,
    positiveShare: rows.length ? rows.filter((r) => r.rate > 0).length / rows.length : 0,
    samples: rows.length,
  }
}

// ---------------------------------------------------------------- math

/** Round-trip cost of a carry: 4 taker fills + the two book spreads. */
export function roundTripCost(q: CarryQuote): number {
  const spotSpread = (q.spotAsk - q.spotBid) / ((q.spotAsk + q.spotBid) / 2)
  const perpSpread = (q.perpAsk - q.perpBid) / ((q.perpAsk + q.perpBid) / 2)
  return 2 * (SPOT_FEE + PERP_FEE) + spotSpread + perpSpread
}

export interface CarryRules {
  /** minimum share of positive settlements in the 7-day window */
  minPositiveShare: number
  /** days the carry is expected to stay open (costs are amortized over it) */
  horizonDays: number
  /** costs must be covered this many times over the horizon */
  costCover: number
}

export const DEFAULT_CARRY_RULES: CarryRules = { minPositiveShare: 0.8, horizonDays: 30, costCover: 1.5 }

export function evaluateCandidate(
  c: CarryCandidate,
  q: CarryQuote | undefined,
  f: FundingStats | undefined,
  aaveApy: number,
  rules: CarryRules
): CandidateView {
  const base = { ...c, quote: q ?? null, funding: f ?? null }
  if (!q) return { ...base, currentApr: 0, roundTripCost: 0, edgeApr: 0, eligible: false, why: 'sin cotización' }
  const currentApr = q.fundingRate * (24 / q.fundingIntervalH) * 365
  const cost = roundTripCost(q)
  if (!f || f.samples < 3) {
    return { ...base, currentApr, roundTripCost: cost, edgeApr: 0, eligible: false, why: 'sin historial de funding' }
  }
  // the yield we plan on: the 7-day average, never more than the current rate
  const planned = Math.min(f.avgApr, Math.max(currentApr, 0))
  const edge = planned - aaveApy
  const needed = (cost * rules.costCover * 365) / rules.horizonDays
  let why = ''
  if (f.positiveShare < rules.minPositiveShare) why = `funding inestable (${Math.round(f.positiveShare * 100)}% positivo)`
  else if (currentApr <= 0) why = 'funding actual ≤ 0'
  else if (edge <= needed) why = `no compensa: +${(edge * 100).toFixed(1)}% sobre Aave < ${(needed * 100).toFixed(1)}% de costes`
  return { ...base, currentApr, roundTripCost: cost, edgeApr: edge, eligible: why === '', why: why || 'elegible' }
}

/** Grow a balance at an APY over dt (continuous compounding of the APY). */
export function accrue(balance: number, apy: number, dtMs: number): number {
  if (!(balance > 0) || !(dtMs > 0)) return balance
  return balance * Math.pow(1 + apy, dtMs / YEAR_MS)
}
