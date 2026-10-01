// TRIANGLE — LIVE execution of one planned 3-leg cycle, venue-agnostic.
//
// Legs run SEQUENTIALLY as market orders; every leg is sized from the REAL
// fill of the previous one (never from the plan). Before the first order, all
// three legs are checked against fresh books and the venue's per-pair
// minimums, so the predictable failures cost nothing.
//
// If a leg fails AFTER money moved, the cycle is unwound with ONE market sell
// of whatever asset is held at that moment, on its USD pair:
//   holding TOKEN → sell on route.directSymbol
//   holding X     → sell on route.usdtSymbol
// so the account is back in USD with a single order and the P&L is measured
// in USD only. An order that was accepted but could not be confirmed is never
// unwound blindly: the caller halts.
//
// Fees: each venue reports them where it charges them — in the quote
// currency (Kraken fciq; Binance on sells), in the base asset (Binance on
// buys) or in a third asset (Binance BNB), which the adapter converts to USD.

import type { CyclePlan, TriangleRouteShape } from '@/lib/triangle-exec'

/** Fresh top-of-book for one pair, in the pair's own quote currency. */
export interface TriangleBook {
  bid: number
  ask: number
}

export interface VenueFilters {
  /** minimum base volume */
  ordermin: number
  /** minimum order cost, in the pair's quote currency */
  costmin: number
  /** base volume increment */
  lot: number
}

export interface VenueFill {
  orderId: string
  /** base volume executed */
  qty: number
  /** average price, quote per base */
  price: number
  /** quote volume executed (before fees) */
  quote: number
  /** fee charged in the QUOTE currency */
  feeQuote: number
  /** fee charged in the BASE asset (reduces what a buy delivers) */
  feeBase: number
  /** fee charged in a third asset, converted to USD (e.g. BNB) */
  feeOtherUsd: number
}

export interface TriangleVenue {
  name: string
  filters(pair: string): Promise<VenueFilters | null>
  marketOrder(pair: string, side: 'buy' | 'sell', baseVolume: number): Promise<VenueFill>
  /** True when the order may have reached the venue but its fate is unknown. */
  isUnconfirmed(e: unknown): boolean
}

/** Generic "accepted but not confirmed" error adapters can throw. */
export class OrderUnconfirmedError extends Error {
  constructor(public orderId: string, message?: string) {
    super(
      message ??
        `orden ${orderId} enviada pero sin confirmar (timeout o error de red). NO la reenvíes: revísala en el exchange antes de volver a arrancar.`
    )
    this.name = 'OrderUnconfirmedError'
  }
}

/** Gap between legs — private rate limits. */
const LEG_GAP_MS = 300
/** Leg 2 of a cross_cheap cycle buys TOKEN with the inter asset: keep this
 *  margin over the taker fee + slippage so cost + fee fits what leg 1 gave. */
const CROSS_BUY_MARGIN = 0.008

export interface LiveLegResult extends VenueFill {
  pair: string
  side: 'buy' | 'sell'
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

function roundDown(volume: number, lot: number): number {
  const step = lot > 0 ? lot : 1e-8
  return Number((Math.floor(volume / step + 1e-9) * step).toFixed(8))
}

/** What a BUY delivers in base, and a SELL in quote, net of fees. */
const baseOut = (l: VenueFill) => l.qty - l.feeBase
const quoteOut = (l: VenueFill) => l.quote - l.feeQuote

export async function executeTriangleCycle(
  venue: TriangleVenue,
  plan: CyclePlan,
  route: TriangleRouteShape,
  ctx: { books: Record<string, TriangleBook>; maxBookSpreadBps: number }
): Promise<LiveCycleOutcome> {
  const { books, maxBookSpreadBps } = ctx

  // 1. Fresh, tight books on all three pairs.
  for (const leg of plan.legs) {
    const q = books[leg.pair]
    if (!q || !(q.bid > 0) || !(q.ask > 0)) {
      return { kind: 'skip', reason: `sin cotización en vivo para ${leg.pair}` }
    }
    const w = ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10000
    if (w > maxBookSpreadBps) {
      return { kind: 'skip', reason: `libro de ${leg.pair} demasiado ancho (${w.toFixed(0)}bps > ${maxBookSpreadBps})` }
    }
  }

  // 2. Venue minimums for EVERY leg, before any money moves.
  const filters: Record<string, VenueFilters> = {}
  for (const leg of plan.legs) {
    const fl = await venue.filters(leg.pair).catch(() => null)
    if (!fl) return { kind: 'skip', reason: `no se pudieron leer los mínimos de ${leg.pair}` }
    filters[leg.pair] = fl
    // 2% below plan: the real fills will differ a little from the plan.
    const vol = roundDown(leg.qty * 0.98, fl.lot)
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
    const vol = roundDown(volume, fl.lot)
    if (!(vol > 0) || (fl.ordermin > 0 && vol < fl.ordermin)) {
      throw new SkipError(`${pair}: volumen ${vol} por debajo del mínimo ${fl.ordermin}`)
    }
    const o = await venue.marketOrder(pair, side, vol)
    if (o.qty <= 0) {
      throw new Error(`orden ${side} ${pair} (${o.orderId}) cerrada sin ejecución`)
    }
    return { ...o, pair, side }
  }

  /** What is held after the completed legs, and where to sell it for USD. */
  const holding = (): { pair: string; qty: number } | null => {
    const last = legs[legs.length - 1]
    if (!last) return null
    if (plan.direction === 'direct_cheap') {
      // after leg 1: TOKEN · after leg 2: X
      return legs.length === 1
        ? { pair: route.directSymbol, qty: baseOut(last) }
        : { pair: route.usdtSymbol, qty: quoteOut(last) }
    }
    // cross_cheap — after leg 1: X · after leg 2: TOKEN
    return legs.length === 1
      ? { pair: route.usdtSymbol, qty: baseOut(last) }
      : { pair: route.directSymbol, qty: baseOut(last) }
  }

  // USD value of the fees of every leg (quote fees of the cross pair are in X;
  // base fees are in TOKEN or X — price them with the live books).
  const interBid = books[route.usdtSymbol].bid
  const tokenBid = books[route.directSymbol].bid
  const feeUsd = (l: LiveLegResult): number => {
    const quoteUsd = l.pair === route.crossSymbol ? interBid : 1
    const baseUsd = l.pair === route.usdtSymbol ? interBid : tokenBid
    return l.feeQuote * quoteUsd + l.feeBase * baseUsd + l.feeOtherUsd
  }
  const spentUsd = () => legs[0].quote + legs[0].feeQuote + legs[0].feeOtherUsd
  const otherFeesAfterLeg1 = (all: LiveLegResult[]) =>
    all.slice(1).reduce((a, l) => a + l.feeOtherUsd, 0)

  try {
    if (plan.direction === 'direct_cheap') {
      // USD → TOKEN (direct) → X (cross) → USD (inter)
      const l1 = await send(route.directSymbol, 'buy', plan.notionalUsd / books[route.directSymbol].ask)
      legs.push(l1)
      await sleep(LEG_GAP_MS)
      const l2 = await send(route.crossSymbol, 'sell', baseOut(l1))
      legs.push(l2)
      await sleep(LEG_GAP_MS)
      const l3 = await send(route.usdtSymbol, 'sell', quoteOut(l2))
      legs.push(l3)
    } else {
      // USD → X (inter) → TOKEN (cross) → USD (direct)
      const l1 = await send(route.usdtSymbol, 'buy', plan.notionalUsd / books[route.usdtSymbol].ask)
      legs.push(l1)
      await sleep(LEG_GAP_MS)
      const askC = books[route.crossSymbol].ask
      const l2 = await send(route.crossSymbol, 'buy', baseOut(l1) / (askC * (1 + CROSS_BUY_MARGIN)))
      legs.push(l2)
      await sleep(LEG_GAP_MS)
      const l3 = await send(route.directSymbol, 'sell', baseOut(l2))
      legs.push(l3)
    }
    const got = quoteOut(legs[2])
    return {
      kind: 'done',
      legs,
      netProfitUsd: got - spentUsd() - otherFeesAfterLeg1(legs),
      feeTotalUsd: legs.reduce((a, l) => a + feeUsd(l), 0),
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (venue.isUnconfirmed(e)) {
      return { kind: 'fatal', reason: `pierna ${legs.length + 1} del ciclo ${plan.routeName}: ${msg}` }
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
        netProfitUsd: quoteOut(u) - spentUsd() - otherFeesAfterLeg1([...legs, u]),
      }
    } catch (e2) {
      return {
        kind: 'fatal',
        reason:
          `pierna ${legs.length + 1} del ciclo ${plan.routeName} falló (${msg}) y no se pudo vender ` +
          `${h.qty} en ${h.pair} (${(e2 as Error).message}). Revisa tu cuenta y vende ese saldo a USD a mano antes de volver a arrancar.`,
      }
    }
  }
}
