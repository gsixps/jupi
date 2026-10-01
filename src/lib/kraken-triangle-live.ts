// KRAKEN adapter for the venue-agnostic 3-leg executor (src/lib/triangle-live.ts).
//
// Kraken specifics: orders use oflags=fciq, so every fee is charged in the
// QUOTE currency (feeBase is always 0); an accepted order whose fill cannot be
// confirmed raises KrakenOrderUnconfirmedError → the cycle halts.

import {
  KrakenOrderUnconfirmedError,
  krakenMarketOrder,
  krakenOrderFilters,
  type ExchangeCredentials,
} from '@/lib/cex'
import type { KrakenTickerQuote } from '@/lib/kraken'
import type { CyclePlan, TriangleRouteShape } from '@/lib/triangle-exec'
import {
  executeTriangleCycle,
  type LiveCycleOutcome,
  type TriangleBook,
  type TriangleVenue,
} from '@/lib/triangle-live'

export type { LiveCycleOutcome, LiveLegResult } from '@/lib/triangle-live'

export function krakenVenue(cred: ExchangeCredentials): TriangleVenue {
  return {
    name: 'Kraken',
    filters: (pair) => krakenOrderFilters(pair),
    async marketOrder(pair, side, volume) {
      const o = await krakenMarketOrder({ cred, pair, side, volume })
      return {
        orderId: o.orderId,
        qty: o.executedQty,
        price: o.price,
        quote: o.executedQuote,
        feeQuote: o.feeQuote ?? 0,
        feeBase: 0,
        feeOtherUsd: 0,
      }
    },
    isUnconfirmed: (e) => e instanceof KrakenOrderUnconfirmedError,
  }
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
  const books: Record<string, TriangleBook> = {}
  for (const [sym, q] of Object.entries(ctx.tickers)) books[sym] = { bid: q.bid, ask: q.ask }
  return executeTriangleCycle(krakenVenue(ctx.cred), plan, route, {
    books,
    maxBookSpreadBps: ctx.maxBookSpreadBps,
  })
}
