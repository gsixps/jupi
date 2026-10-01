// TREND — BTC/ETH trend-following engine (Donchian breakout + EMA filter).
//
// Rules, evaluated on CLOSED candles only (no peeking at the forming one):
//   ENTRY (long only, spot):  close > highest HIGH of the previous
//                             `entryBars` candles  AND  close > EMA(trendEma)
//   EXIT:                     close < lowest LOW of the previous `exitBars`
//                             candles,  OR  close < trailing stop, where the
//                             stop = highest close since entry − atrMult × ATR
//   SIZE:                     risk `riskPct` of equity per trade: the USD at
//                             risk between entry and the initial stop. Capped
//                             by the cash available (no leverage).
//
// Costs: taker fee + slippage on every fill. The SAME function drives the
// backtest, the demo and the live bot, so a backtest is what the bot does.
//
// Pure functions except fetchBinanceKlines (public Binance REST, no key).

export interface Candle {
  /** open time, ms */
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type TrendInterval = '1h' | '4h'

export interface TrendParams {
  interval: TrendInterval
  entryBars: number
  exitBars: number
  trendEma: number
  atrBars: number
  atrMult: number
  /** % of equity risked per trade (entry → initial stop) */
  riskPct: number
  /** taker fee per fill, fraction (Binance spot 0.001) */
  feeRate: number
  /** assumed slippage per fill, fraction */
  slippage: number
  /** cost of HOLDING the position, per year, as a fraction of its value
   *  (CFD overnight financing / swap). 0 for spot crypto. */
  holdCostPerYear?: number
}

export const DEFAULT_TREND_PARAMS: TrendParams = {
  interval: '4h',
  entryBars: 20,
  exitBars: 10,
  trendEma: 100,
  atrBars: 14,
  atrMult: 3,
  riskPct: 1,
  feeRate: 0.001,
  slippage: 0.0005,
}

// ---------------------------------------------------------------- data

const KLINES = 'https://api.binance.com/api/v3/klines'

/**
 * Up to `bars` most recent candles, paging backwards 1000 at a time. The last
 * element may be the still-forming candle: callers use `closedOnly`.
 */
export async function fetchBinanceKlines(
  symbol: string,
  interval: TrendInterval,
  bars: number
): Promise<Candle[]> {
  const out: Candle[] = []
  let endTime: number | undefined
  while (out.length < bars) {
    const limit = Math.min(1000, bars - out.length)
    const url = `${KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    let rows: unknown[][]
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`binance klines ${res.status}`)
      rows = (await res.json()) as unknown[][]
    } finally {
      clearTimeout(timer)
    }
    if (!rows.length) break
    const page = rows.map((r) => ({
      t: Number(r[0]),
      o: parseFloat(String(r[1])),
      h: parseFloat(String(r[2])),
      l: parseFloat(String(r[3])),
      c: parseFloat(String(r[4])),
      v: parseFloat(String(r[5])),
    }))
    out.unshift(...page)
    endTime = page[0].t - 1
    if (rows.length < limit) break
  }
  return out
}

export const INTERVAL_MS: Record<TrendInterval, number> = { '1h': 3_600_000, '4h': 14_400_000 }

/** Financing charged for holding `valueUsd` during `ms`. */
export function holdCost(valueUsd: number, ms: number, p: TrendParams): number {
  return valueUsd * (p.holdCostPerYear ?? 0) * (ms / (365 * 86_400_000))
}

/** Drop the candle that is still forming. */
export function closedOnly(candles: Candle[], interval: TrendInterval, now = Date.now()): Candle[] {
  const last = candles[candles.length - 1]
  if (last && last.t + INTERVAL_MS[interval] > now) return candles.slice(0, -1)
  return candles
}

// ---------------------------------------------------------------- indicators

export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Wilder's ATR. */
export function atr(c: Candle[], period: number): number[] {
  const out: number[] = new Array(c.length).fill(NaN)
  if (c.length <= period) return out
  const tr = c.map((x, i) =>
    i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))
  )
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period
  out[period] = prev
  for (let i = period + 1; i < c.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period
    out[i] = prev
  }
  return out
}

function highest(c: Candle[], end: number, n: number): number {
  let m = -Infinity
  for (let i = Math.max(0, end - n); i < end; i++) m = Math.max(m, c[i].h)
  return m
}
function lowest(c: Candle[], end: number, n: number): number {
  let m = Infinity
  for (let i = Math.max(0, end - n); i < end; i++) m = Math.min(m, c[i].l)
  return m
}

// ---------------------------------------------------------------- signal

export interface TrendPosition {
  entryTime: number
  entryPrice: number
  qty: number
  /** USD spent including the entry fee */
  costUsd: number
  /** highest close since entry (for the trailing stop) */
  peakClose: number
  stop: number
}

export interface TrendSnapshot {
  close: number
  ema: number
  atr: number
  donchianHigh: number
  donchianLow: number
  /** candle open time the snapshot refers to */
  t: number
}

export type TrendDecision =
  | { action: 'buy'; reason: string; stop: number; snap: TrendSnapshot }
  | { action: 'sell'; reason: string; snap: TrendSnapshot }
  | { action: 'hold'; reason: string; snap: TrendSnapshot; stop?: number }
  | { action: 'none'; reason: string }

/** Minimum candles before the first decision. */
export function warmupBars(p: TrendParams): number {
  return Math.max(p.trendEma, p.entryBars, p.exitBars, p.atrBars + 1) + 1
}

/**
 * Decision on the LAST candle of `c` (closed candles only). `pos` is the
 * open position, if any; its stop/peak are updated in the returned snapshot.
 */
export function decide(
  c: Candle[],
  p: TrendParams,
  pos: TrendPosition | null,
  cache?: { ema: number[]; atr: number[] }
): TrendDecision {
  const i = c.length - 1
  if (i + 1 < warmupBars(p)) return { action: 'none', reason: `calentando (${i + 1}/${warmupBars(p)} velas)` }
  const e = cache?.ema ?? ema(c.map((x) => x.c), p.trendEma)
  const a = cache?.atr ?? atr(c, p.atrBars)
  const snap: TrendSnapshot = {
    close: c[i].c,
    ema: e[i],
    atr: a[i],
    donchianHigh: highest(c, i, p.entryBars),
    donchianLow: lowest(c, i, p.exitBars),
    t: c[i].t,
  }
  if (pos) {
    const peak = Math.max(pos.peakClose, snap.close)
    const trail = Math.max(pos.stop, peak - p.atrMult * snap.atr)
    if (snap.close < snap.donchianLow) {
      return { action: 'sell', reason: `cierre ${fmt(snap.close)} < mínimo de ${p.exitBars} velas ${fmt(snap.donchianLow)}`, snap }
    }
    if (snap.close < trail) {
      return { action: 'sell', reason: `cierre ${fmt(snap.close)} < stop dinámico ${fmt(trail)} (${p.atrMult}×ATR)`, snap }
    }
    return { action: 'hold', reason: `en tendencia · stop ${fmt(trail)}`, snap, stop: trail }
  }
  if (snap.close > snap.donchianHigh && snap.close > snap.ema) {
    return {
      action: 'buy',
      reason: `ruptura: cierre ${fmt(snap.close)} > máximo de ${p.entryBars} velas ${fmt(snap.donchianHigh)} y > EMA${p.trendEma} ${fmt(snap.ema)}`,
      stop: snap.close - p.atrMult * snap.atr,
      snap,
    }
  }
  const why =
    snap.close <= snap.ema
      ? `bajo la EMA${p.trendEma} (${fmt(snap.ema)}) — sin tendencia alcista`
      : `esperando ruptura de ${fmt(snap.donchianHigh)}`
  return { action: 'hold', reason: why, snap }
}

/** Units to buy so that (entry − stop) × qty = riskPct of equity, cash-capped. */
export function positionSize(
  equityUsd: number,
  cashUsd: number,
  entry: number,
  stop: number,
  p: TrendParams
): number {
  const perUnitRisk = entry - stop
  if (!(perUnitRisk > 0) || !(entry > 0)) return 0
  const riskUsd = (equityUsd * p.riskPct) / 100
  const byRisk = riskUsd / perUnitRisk
  const byCash = (cashUsd / (1 + p.feeRate + p.slippage)) / entry
  return Math.max(0, Math.min(byRisk, byCash))
}

/** Effective fill prices with slippage. */
export const buyFill = (px: number, p: TrendParams) => px * (1 + p.slippage)
export const sellFill = (px: number, p: TrendParams) => px * (1 - p.slippage)

// ---------------------------------------------------------------- backtest

export interface TrendTrade {
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  qty: number
  pnlUsd: number
  pnlPct: number
  reason: string
}

export interface BacktestResult {
  trades: TrendTrade[]
  equity: { t: number; equity: number }[]
  startEquity: number
  endEquity: number
  returnPct: number
  buyHoldPct: number
  maxDrawdownPct: number
  winRatePct: number
  profitFactor: number
  exposurePct: number
  fromTime: number
  toTime: number
  openPosition: TrendPosition | null
}

export function backtest(candles: Candle[], p: TrendParams, startEquity = 1000): BacktestResult {
  const closes = candles.map((x) => x.c)
  const e = ema(closes, p.trendEma)
  const a = atr(candles, p.atrBars)
  const warm = warmupBars(p)
  let cash = startEquity
  let pos: TrendPosition | null = null
  const trades: TrendTrade[] = []
  const equity: { t: number; equity: number }[] = []
  let peakEq = startEquity
  let maxDd = 0
  let barsIn = 0
  for (let i = warm - 1; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1)
    const d = decide(slice, p, pos, { ema: e.slice(0, i + 1), atr: a.slice(0, i + 1) })
    const px = candles[i].c
    if (d.action === 'buy') {
      const eq = cash
      const fill = buyFill(px, p)
      const qty = positionSize(eq, cash, fill, d.stop, p)
      if (qty > 0) {
        const cost = qty * fill * (1 + p.feeRate)
        cash -= cost
        pos = { entryTime: candles[i].t, entryPrice: fill, qty, costUsd: cost, peakClose: px, stop: d.stop }
      }
    } else if (d.action === 'sell' && pos) {
      const fill = sellFill(px, p)
      const proceeds = pos.qty * fill * (1 - p.feeRate)
      cash += proceeds
      trades.push({
        entryTime: pos.entryTime,
        exitTime: candles[i].t,
        entryPrice: pos.entryPrice,
        exitPrice: fill,
        qty: pos.qty,
        pnlUsd: proceeds - pos.costUsd,
        pnlPct: ((proceeds - pos.costUsd) / pos.costUsd) * 100,
        reason: d.reason,
      })
      pos = null
    } else if (d.action === 'hold' && pos) {
      pos.peakClose = Math.max(pos.peakClose, px)
      if (d.stop !== undefined) pos.stop = d.stop
    }
    if (pos) {
      barsIn++
      // overnight financing / swap of a held CFD position
      cash -= holdCost(pos.qty * px, INTERVAL_MS[p.interval], p)
    }
    const eqNow = cash + (pos ? pos.qty * sellFill(px, p) * (1 - p.feeRate) : 0)
    equity.push({ t: candles[i].t, equity: eqNow })
    peakEq = Math.max(peakEq, eqNow)
    maxDd = Math.max(maxDd, ((peakEq - eqNow) / peakEq) * 100)
  }
  const end = equity.length ? equity[equity.length - 1].equity : startEquity
  const wins = trades.filter((t) => t.pnlUsd > 0)
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0)
  const grossLoss = -trades.filter((t) => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0)
  const first = candles[warm - 1]?.c ?? candles[0]?.c ?? 0
  const last = candles[candles.length - 1]?.c ?? 0
  return {
    trades,
    equity,
    startEquity,
    endEquity: end,
    returnPct: ((end - startEquity) / startEquity) * 100,
    buyHoldPct: first > 0 ? ((last * (1 - p.feeRate) ** 2 - first) / first) * 100 : 0,
    maxDrawdownPct: maxDd,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    exposurePct: equity.length ? (barsIn / equity.length) * 100 : 0,
    fromTime: candles[warm - 1]?.t ?? 0,
    toTime: candles[candles.length - 1]?.t ?? 0,
    openPosition: pos,
  }
}

function fmt(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(2)
}
