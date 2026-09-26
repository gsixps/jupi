// Pure trading strategy functions. NO I/O.
import type { QuoteResult, PriceMap } from "./jupiter"

/**
 * Simple moving average of the last `window` values.
 * Returns 0 if not enough data.
 */
export function computeSMA(prices: number[], window: number): number {
  if (!prices.length || window <= 0) return 0
  const w = Math.min(window, prices.length)
  if (prices.length < w) return 0
  const slice = prices.slice(prices.length - w)
  const sum = slice.reduce((a, b) => a + b, 0)
  return sum / w
}

export interface MeanRevSignal {
  action: "BUY" | "HOLD" | null
  reason: string
}

/**
 * Mean reversion signal.
 * Given price history (oldest..newest), compute SMA(window=min(20, len)).
 * If latest price < SMA * (1 - buyThreshold/100) -> BUY (oversold, expect reversion up).
 * Does NOT return SELL here (sell logic depends on entry price, handled in engine).
 */
export function meanReversionSignal(
  prices: number[],
  cfg: { buyThreshold: number; sellThreshold: number; stopLossPct: number }
): MeanRevSignal {
  if (!prices.length) return { action: null, reason: "no price data" }
  const window = Math.min(20, prices.length)
  if (prices.length < 5) {
    return { action: null, reason: `warming up (${prices.length}/5 prices)` }
  }
  const sma = computeSMA(prices, window)
  if (sma <= 0) return { action: null, reason: "SMA=0" }
  const latest = prices[prices.length - 1]
  const deviationPct = ((sma - latest) / sma) * 100 // positive => below SMA
  const buyTrigger = cfg.buyThreshold
  if (deviationPct >= buyTrigger) {
    return {
      action: "BUY",
      reason: `Price ${latest.toFixed(4)} < SMA ${sma.toFixed(4)} (${deviationPct.toFixed(2)}% below)`,
    }
  }
  return { action: "HOLD", reason: `Price ${latest.toFixed(4)} near SMA ${sma.toFixed(4)} (${deviationPct.toFixed(2)}%)` }
}

export interface CloseSignal {
  action: "SELL" | "STOPLOSS" | null
  reason: string
  pnlPct: number
}

/**
 * Decide whether to close an open position.
 * - SELL (take profit) when currentPrice >= entryPrice * (1 + sellThreshold/100)
 * - STOPLOSS when currentPrice <= entryPrice * (1 - stopLossPct/100)
 */
export function shouldClosePosition(
  pos: { entryPrice: number },
  currentPrice: number,
  cfg: { sellThreshold: number; stopLossPct: number }
): CloseSignal {
  const entry = pos.entryPrice
  if (!entry || entry <= 0) return { action: null, reason: "no entry price", pnlPct: 0 }
  const pnlPct = (currentPrice / entry - 1) * 100
  const takeProfit = entry * (1 + cfg.sellThreshold / 100)
  const stopLoss = entry * (1 - cfg.stopLossPct / 100)
  if (currentPrice >= takeProfit) {
    return {
      action: "SELL",
      reason: `Take profit ${pnlPct.toFixed(2)}% (>= ${cfg.sellThreshold}%)`,
      pnlPct,
    }
  }
  if (currentPrice <= stopLoss) {
    return {
      action: "STOPLOSS",
      reason: `Stop loss ${pnlPct.toFixed(2)}% (<= -${cfg.stopLossPct}%)`,
      pnlPct,
    }
  }
  return { action: null, reason: `Holding, PnL ${pnlPct.toFixed(2)}%`, pnlPct }
}

/**
 * Build triangular arbitrage cycles [USDC, A, B, USDC] for each unordered pair (A,B)
 * of tradable mints. Limits to the first 8 cycles to control API load.
 */
export function buildArbCycles(tradableMints: string[], usdcMint: string): string[][] {
  const cycles: string[][] = []
  const n = tradableMints.length
  for (let i = 0; i < n && cycles.length < 8; i++) {
    for (let j = i + 1; j < n && cycles.length < 8; j++) {
      const a = tradableMints[i]
      const b = tradableMints[j]
      if (a === usdcMint || b === usdcMint) continue
      cycles.push([usdcMint, a, b, usdcMint])
    }
  }
  return cycles
}

export interface CycleReturn {
  profitUsd: number
  profitPct: number
  profitBps: number
  outUsd: number
}

/**
 * Compute the return for a triangular arb cycle given the leg quotes and the
 * input USD amount.
 *
 * The cycle is [USDC, A, B, USDC] so legs are:
 *   leg1: USDC -> A
 *   leg2: A -> B
 *   leg3: B -> USDC
 *
 * We track the running base amount through each leg's outAmount, then convert
 * the final USDC base amount to USD via decimals (6).
 *
 * `inputUsd` is the USD input. We assume leg1's inputMint is USDC with 6 decimals;
 * the caller passes leg1.inAmount as the USDC base units (= inputUsd * 1e6).
 */
export function computeCycleReturn(
  legQuotes: QuoteResult[],
  inputUsd: number,
  _prices: PriceMap
): CycleReturn {
  if (!legQuotes.length || inputUsd <= 0) {
    return { profitUsd: 0, profitPct: 0, profitBps: 0, outUsd: 0 }
  }
  // Walk the chain: each leg's outAmount (base units) becomes the input base
  // amount for the next leg. The final leg's outAmount is in USDC base units
  // (6 decimals).
  let runningBase = legQuotes[0].inAmount // start = leg1 input in base units (USDC base)
  for (const q of legQuotes) {
    // The quote was computed with `runningBase` as input for the first leg
    // and the chain follows. We just take each leg's outAmount in sequence.
    runningBase = q.outAmount
  }
  // Final runningBase is the final leg's outAmount (USDC base units, 6 decimals)
  const outUsd = runningBase / Math.pow(10, 6)
  const profitUsd = outUsd - inputUsd
  const profitPct = inputUsd > 0 ? (profitUsd / inputUsd) * 100 : 0
  const profitBps = inputUsd > 0 ? (profitUsd / inputUsd) * 10000 : 0
  return { profitUsd, profitPct, profitBps, outUsd }
}
