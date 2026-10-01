// KRAKEN TRIANGLE — LIVE execution of one planned 3-leg cycle (real orders).
//
// Legs run SEQUENTIALLY as market orders; every leg is sized from the REAL
// fill of the previous one (never from the plan). Before the first order, all
// three legs are checked against fresh books and Kraken's per-pair minimums,
// so the predictable failures (volume below ordermin, thin book) cost nothing.
//
// If a leg fails AFTER money moved, the cycle is unwound with ONE market sell
// of whatever asset is held at that moment, on its USD pair:
//   holding TOKEN → sell on route.directSymbol
//   holding X     → sell on route.usdtSymbol
// so the account is back in USD with a single order and the P&L is measured
// in USD only. An order that was accepted but could not be confirmed
// (KrakenOrderUnconfirmedError) is never unwound blindly: the caller halts.
//
// Kraken fees (oflags=fciq) are charged in the QUOTE currency of each pair:
// a BUY costs `cost + fee`, a SELL yields `cost - fee`.

import {
  KrakenOrderUnconfirmedError,
  krakenMarketOrder,
  krakenOrderFilters,
  krakenRoundVolume,
  type ExchangeCredentials,
  type KrakenOrderFilters,
} from '@/lib/cex'
import type { KrakenTickerQuote } from '@/lib/kraken'
import type { CyclePlan, TriangleRouteShape } from '@/lib/triangle-exec'

/** Gap between legs — Kraken's private rate limit. */
const LEG_GAP_MS = 300
/** Leg 2 of a cross_cheap cycle buys TOKEN with the inter asset: keep this
 *  margin over the taker fee + slippage so cost + fee fits what leg 1 gave. */
const CROSS_BUY_MARGIN = 0.008

export interface LiveLegResult {
  pair: string
  side: 'buy' | 'sell'
  orderId: string
  qty: number
  price: number
  quote: number
  fee: number
}

export type LiveCycleOutcome =
  /** all 3 legs filled — netProfitUsd from real fills and fees */
  | { kind: 'done'; legs: LiveLegResult[]; netProfitUsd: number; feeTotalUsd: number }
  /** nothing was sent (pre-trade check failed, or leg 1 rejected) */
  | { kind: 'skip'; reason: string }
  /** a later leg failed; the held asset was sold back to USD */
  | { kind: 'unwound'; reason: string; legs: LiveLegResult[]; unwind: LiveLegResult; netProfitUsd: number }
  /** money is in an unknown or stuck state — the caller MUST halt */
  | { kind: 'fatal'; reason: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class SkipError extends Error {}

function bookWidthBps(q: KrakenTickerQuote): number {
  return ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10000
}

export async function executeLiveTriangle(
  plan: CyclePlan,
  route: TriangleRouteShape,
  ctx: {
    cred: ExchangeCredentials
    tickers: Record<string, KrakenTickerQuote>
    maxBookSpreadBps: number
  }
): Promise<LiveCycleOutcome> {
  const { cred, tickers, maxBookSpreadBps } = ctx

  // 1. Fresh, tight books on all three pairs.
  for (const leg of plan.legs) {
    const q = tickers[leg.pair]
    if (!q || !(q.bid > 0) || !(q.ask > 0)) {
      return { kind: 'skip', reason: `sin cotización en vivo para ${leg.pair}` }
    }
    const w = bookWidthBps(q)
    if (w > maxBookSpreadBps) {
      return { kind: 'skip', reason: `libro de ${leg.pair} demasiado ancho (${w.toFixed(0)}bps > ${maxBookSpreadBps})` }
    }
  }

  // 2. Kraken minimums for EVERY leg, before any money moves.
  const filters: Record<string, KrakenOrderFilters> = {}
  for (const leg of plan.legs) {
    const fl = await krakenOrderFilters(leg.pair).catch(() => null)
    if (!fl) return { kind: 'skip', reason: `no se pudieron leer los mínimos de ${leg.pair}` }
    filters[leg.pair] = fl
    // 2% below plan: the real fills will differ a little from the plan.
    const vol = krakenRoundVolume(leg.qty * 0.98, fl)
    if (fl.ordermin > 0 && vol < fl.ordermin) {
      return { kind: 'skip', reason: `${leg.pair}: ${vol} < mínimo ${fl.ordermin}` }
    }
    if (fl.costmin > 0 && vol * leg.price < fl.costmin) {
      return { kind: 'skip', reason: `${leg.pair}: coste ${(vol * leg.price).toPrecision(4)} < mínimo ${fl.costmin}` }
    }
  }

  const legs: LiveLegResult[] = []

  const send = async (pair: string, side: 'buy' | 'sell', volume: number): Promise<LiveLegResult> => {
    const fl = filters[pair]
    const vol = krakenRoundVolume(volume, fl)
    if (!(vol > 0) || (fl.ordermin > 0 && vol < fl.ordermin)) {
      throw new SkipError(`${pair}: volumen ${vol} por debajo del mínimo ${fl.ordermin}`)
    }
    const o = await krakenMarketOrder({ cred, pair, side, volume: vol })
    if (o.executedQty <= 0) {
      throw new Error(`orden ${side} ${pair} (${o.orderId}) cerrada sin ejecución`)
    }
    return {
      pair,
      side,
      orderId: o.orderId,
      qty: o.executedQty,
      price: o.price,
      quote: o.executedQuote,
      fee: o.feeQuote ?? 0,
    }
  }

  /** What is held after the completed legs, and where to sell it for USD. */
  const holding = (): { pair: string; qty: number } | null => {
    const last = legs[legs.length - 1]
    if (!last) return null
    if (plan.direction === 'direct_cheap') {
      // after leg 1: TOKEN · after leg 2: X (proceeds net of fee)
      return legs.length === 1
        ? { pair: route.directSymbol, qty: last.qty }
        : { pair: route.usdtSymbol, qty: last.quote - last.fee }
    }
    // cross_cheap — after leg 1: X · after leg 2: TOKEN
    return legs.length === 1
      ? { pair: route.usdtSymbol, qty: last.qty }
      : { pair: route.directSymbol, qty: last.qty }
  }

  const spentUsd = () => legs[0].quote + legs[0].fee
  /** leg-2 fee is in the inter asset; convert with its USD bid. */
  const interBid = tickers[route.usdtSymbol].bid

  try {
    if (plan.direction === 'direct_cheap') {
      // USD → TOKEN (direct) → X (cross) → USD (inter)
      const l1 = await send(route.directSymbol, 'buy', plan.notionalUsd / tickers[route.directSymbol].ask)
      legs.push(l1)
      await sleep(LEG_GAP_MS)
      const l2 = await send(route.crossSymbol, 'sell', l1.qty)
      legs.push(l2)
      await sleep(LEG_GAP_MS)
      const l3 = await send(route.usdtSymbol, 'sell', l2.quote - l2.fee)
      legs.push(l3)
    } else {
      // USD → X (inter) → TOKEN (cross) → USD (direct)
      const l1 = await send(route.usdtSymbol, 'buy', plan.notionalUsd / tickers[route.usdtSymbol].ask)
      legs.push(l1)
      await sleep(LEG_GAP_MS)
      const askC = tickers[route.crossSymbol].ask
      const l2 = await send(route.crossSymbol, 'buy', l1.qty / (askC * (1 + CROSS_BUY_MARGIN)))
      legs.push(l2)
      await sleep(LEG_GAP_MS)
      const l3 = await send(route.directSymbol, 'sell', l2.qty)
      legs.push(l3)
    }
    const got = legs[2].quote - legs[2].fee
    return {
      kind: 'done',
      legs,
      netProfitUsd: got - spentUsd(),
      feeTotalUsd: legs[0].fee + legs[1].fee * interBid + legs[2].fee,
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (e instanceof KrakenOrderUnconfirmedError) {
      return {
        kind: 'fatal',
        reason: `pierna ${legs.length + 1} del ciclo ${plan.routeName}: ${msg}`,
      }
    }
    if (legs.length === 0) {
      return { kind: 'skip', reason: e instanceof SkipError ? msg : `pierna 1 rechazada: ${msg}` }
    }

    // Money moved: sell what is held back to USD with ONE order.
    const h = holding()
    if (!h) return { kind: 'fatal', reason: `estado del ciclo desconocido tras: ${msg}` }
    await sleep(LEG_GAP_MS)
    try {
      const u = await send(h.pair, 'sell', h.qty)
      return {
        kind: 'unwound',
        reason: `pierna ${legs.length + 1} falló (${msg}); vendido a USD en ${h.pair}`,
        legs,
        unwind: u,
        netProfitUsd: u.quote - u.fee - spentUsd(),
      }
    } catch (e2) {
      return {
        kind: 'fatal',
        reason:
          `pierna ${legs.length + 1} del ciclo ${plan.routeName} falló (${msg}) y no se pudo vender ` +
          `${h.qty} en ${h.pair} (${(e2 as Error).message}). Revisa tu cuenta de Kraken y vende ese saldo a USD a mano antes de volver a arrancar.`,
      }
    }
  }
}
