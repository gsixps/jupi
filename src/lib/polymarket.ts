// POLYMARKET — public data + wallet analysis for the copy-trading demo.
//
// Everything here is public and CORS-open:
//   data-api.polymarket.com   leaderboards, trades and positions per wallet
//   clob.polymarket.com       order books, fee rates, market resolution
//
// Fees: some markets charge a taker fee. Its size is estimated per share as
// (base_fee / 20000) × p × (1 − p) — calibrated on a real fill (a 0.65 buy
// with base_fee 1000 paid 0.0114 USDC per share). base_fee 0 → no fee.

const DATA = 'https://data-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'

async function getJson<T>(url: string, ms = 15000): Promise<T> {
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

export type LbPeriod = 'WEEK' | 'MONTH' | 'ALL'

export interface LbRow {
  rank: string
  proxyWallet: string
  userName?: string
  vol: number
  pnl: number
}

export const fetchLeaderboard = (p: LbPeriod, limit = 50) =>
  getJson<LbRow[]>(`${DATA}/v1/leaderboard?timePeriod=${p}&orderBy=PNL&limit=${limit}`)

export interface PmTrade {
  proxyWallet: string
  side: 'BUY' | 'SELL'
  asset: string
  conditionId: string
  size: number
  price: number
  timestamp: number
  title: string
  slug: string
  outcome: string
  transactionHash: string
}

export const fetchTrades = (user: string, limit = 100) =>
  getJson<PmTrade[]>(`${DATA}/trades?user=${user}&limit=${limit}`)

export interface PmPosition {
  asset: string
  conditionId: string
  size: number
  avgPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
  realizedPnl: number
  curPrice: number
  redeemable: boolean
  title: string
  /** market end date, YYYY-MM-DD */
  endDate?: string
}

export const fetchPositions = (user: string, limit = 500) =>
  getJson<PmPosition[]>(`${DATA}/positions?user=${user}&limit=${limit}&sizeThreshold=1`)

export interface PmClosed {
  conditionId: string
  realizedPnl: number
  totalBought: number
  avgPrice: number
  title: string
  timestamp: number
}

/** Most recent CLOSED positions (the API caps pages at 50; winners that were
 *  redeemed only appear here, never in /positions). */
export async function fetchClosedRecent(user: string, pages = 4): Promise<PmClosed[]> {
  const out: PmClosed[] = []
  for (let i = 0; i < pages; i++) {
    const page = await getJson<PmClosed[]>(
      `${DATA}/closed-positions?user=${user}&sortBy=TIMESTAMP&sortDirection=DESC&limit=50&offset=${i * 50}`
    ).catch(() => [] as PmClosed[])
    out.push(...page)
    if (page.length < 50) break
  }
  return out
}

export interface Book {
  bestBid: number
  bestAsk: number
  /** USDC available at the best ask */
  askDepthUsd: number
}

/** Best bid/ask of an outcome token (the CLOB lists are not sorted for us). */
export async function fetchBook(tokenId: string): Promise<Book | null> {
  const j = await getJson<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(
    `${CLOB}/book?token_id=${tokenId}`
  ).catch(() => null)
  if (!j) return null
  const bids = (j.bids ?? []).map((x) => ({ p: +x.price, s: +x.size }))
  const asks = (j.asks ?? []).map((x) => ({ p: +x.price, s: +x.size }))
  if (!bids.length && !asks.length) return null
  const bb = bids.reduce((m, x) => (x.p > m.p ? x : m), { p: 0, s: 0 })
  const ba = asks.reduce((m, x) => (x.p < m.p ? x : m), { p: 1, s: 0 })
  return { bestBid: bb.p, bestAsk: asks.length ? ba.p : 1, askDepthUsd: ba.p * ba.s }
}

const feeCache = new Map<string, number>()
/** base_fee of an outcome token (0 = fee-free market). */
export async function fetchBaseFee(tokenId: string): Promise<number> {
  if (feeCache.has(tokenId)) return feeCache.get(tokenId)!
  const j = await getJson<{ base_fee?: number }>(`${CLOB}/fee-rate?token_id=${tokenId}`).catch(() => null)
  const f = Number(j?.base_fee ?? 0) || 0
  feeCache.set(tokenId, f)
  return f
}

/** Estimated fee in USDC for `shares` at `price`. */
export const feeUsd = (baseFee: number, price: number, shares: number) =>
  (baseFee / 20000) * price * (1 - price) * shares

/** Resolution of a market: winner token id once closed, else null. */
export async function fetchResolution(conditionId: string): Promise<{ closed: boolean; winner: string | null } | null> {
  const j = await getJson<{ closed?: boolean; tokens?: { token_id: string; winner?: boolean }[] }>(
    `${CLOB}/markets/${conditionId}`
  ).catch(() => null)
  if (!j) return null
  return { closed: !!j.closed, winner: j.tokens?.find((t) => t.winner)?.token_id ?? null }
}

// ---------------------------------------------------------------- analysis

export interface WalletAnalysis {
  wallet: string
  name: string
  pnlWeek: number | null
  pnlMonth: number | null
  pnlAll: number | null
  /** in how many of the 3 leaderboards (week / month / all) */
  boards: number
  trades: number
  tradesPerHour: number
  avgTradeUsd: number
  markets: number
  /** share of the recent profit coming from the single best position */
  topPositionShare: number
  /** recent closed positions that made money */
  winRate: number
  resolved: number
  /** realized P&L of those recent closed positions */
  recentPnl: number
  worstLoss: number
  copyable: boolean
  reasons: string[]
  score: number
}

export interface AnalysisRules {
  minBoards: number
  minTrades: number
  maxTradesPerHour: number
  maxAvgTradeUsd: number
  maxTopShare: number
}

export const DEFAULT_ANALYSIS_RULES: AnalysisRules = {
  minBoards: 2,
  minTrades: 40,
  maxTradesPerHour: 5,
  maxAvgTradeUsd: 25_000,
  maxTopShare: 0.5,
}

export async function analyzeWallet(
  wallet: string,
  name: string,
  pnl: { week: number | null; month: number | null; all: number | null },
  rules: AnalysisRules
): Promise<WalletAnalysis> {
  const [trades, closed, open] = await Promise.all([
    fetchTrades(wallet, 500).catch(() => [] as PmTrade[]),
    fetchClosedRecent(wallet),
    fetchPositions(wallet).catch(() => [] as PmPosition[]),
  ])
  // A position that expired worthless and was never redeemed stays in
  // /positions at price 0 — it never shows up as "closed". Count those losses
  // too, or the hit rate is inflated.
  // Same window as the closed sample: only markets that ended after its oldest close.
  const since = closed.length ? Math.min(...closed.map((c) => c.timestamp)) * 1000 : 0
  const deadLosses = open
    .filter((x) => (x.redeemable || x.curPrice === 0) && x.cashPnl < 0)
    .filter((x) => !x.endDate || Date.parse(x.endDate) >= since)
    .map((x) => x.cashPnl)
  const span = trades.length > 1 ? (trades[0].timestamp - trades[trades.length - 1].timestamp) / 3600 : 0
  const tradesPerHour = span > 0 ? trades.length / span : 0
  const avgTradeUsd = trades.length ? trades.reduce((a, t) => a + t.size * t.price, 0) / trades.length : 0
  const markets = new Set(trades.map((t) => t.conditionId)).size
  const pnls = [...closed.map((c) => c.realizedPnl), ...deadLosses]
  const gains = pnls.filter((x) => x > 0)
  const totalGain = gains.reduce((a, b) => a + b, 0)
  const topPositionShare = totalGain > 0 ? Math.max(...gains) / totalGain : 1
  const winRate = pnls.length ? gains.length / pnls.length : 0
  const recentPnl = pnls.reduce((a, b) => a + b, 0)
  const worstLoss = pnls.length ? Math.min(0, ...pnls) : 0
  const boards = [pnl.week, pnl.month, pnl.all].filter((x) => x !== null && x > 0).length

  const reasons: string[] = []
  if (boards < rules.minBoards) reasons.push(`solo en ${boards}/3 rankings (poca constancia)`)
  if (trades.length < rules.minTrades) reasons.push(`pocas operaciones (${trades.length})`)
  if (tradesPerHour > rules.maxTradesPerHour) reasons.push(`bot de alta frecuencia (${tradesPerHour.toFixed(0)}/h)`)
  if (avgTradeUsd > rules.maxAvgTradeUsd) reasons.push(`operaciones enormes (~${Math.round(avgTradeUsd)} USD): mueven el precio`)
  if (topPositionShare > rules.maxTopShare) reasons.push(`${Math.round(topPositionShare * 100)}% del beneficio en una sola apuesta`)
  if ((pnl.week ?? 0) < 0) reasons.push('pierde esta semana')
  if (pnls.length >= 10 && recentPnl <= 0) reasons.push('sus últimas posiciones cerradas pierden')

  const score =
    boards * 2 +
    Math.min(winRate, 0.8) * 5 +
    (1 - Math.min(topPositionShare, 1)) * 3 +
    Math.min(markets / 50, 1) * 2 -
    (tradesPerHour > rules.maxTradesPerHour ? 5 : 0)

  return {
    wallet,
    name,
    pnlWeek: pnl.week,
    pnlMonth: pnl.month,
    pnlAll: pnl.all,
    boards,
    trades: trades.length,
    tradesPerHour,
    avgTradeUsd,
    markets,
    topPositionShare,
    winRate,
    resolved: pnls.length,
    recentPnl,
    worstLoss,
    copyable: reasons.length === 0,
    reasons,
    score,
  }
}
