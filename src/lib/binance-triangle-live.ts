// BINANCE adapter for the venue-agnostic 3-leg executor (src/lib/triangle-live.ts).
//
// Binance specifics: commissions are charged in the asset RECEIVED (base on a
// buy, quote on a sell) — or in BNB when "pay fees with BNB" is on, which this
// adapter converts to USD with the BNBUSDT bid. A 5xx or a lost response means
// "status unknown" (BinanceOrderUnconfirmedError) → the cycle halts.

import {
  BinanceOrderUnconfirmedError,
  binanceMarketOrderBase,
  binanceSymbolFilters,
  type ExchangeCredentials,
} from '@/lib/cex'
import type { TriangleBook, TriangleVenue, VenueFilters } from '@/lib/triangle-live'

const BOOK_API = 'https://api.binance.com/api/v3/ticker/bookTicker'

/** Top-of-book for many symbols in ONE request. Throws on failure. */
export async function fetchBinanceBooks(symbols: string[]): Promise<Record<string, TriangleBook>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10000)
  try {
    const url = `${BOOK_API}?symbols=${encodeURIComponent(JSON.stringify(symbols))}`
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`binance bookTicker ${res.status}`)
    const rows = (await res.json()) as { symbol: string; bidPrice: string; askPrice: string }[]
    const out: Record<string, TriangleBook> = {}
    for (const r of rows) {
      const bid = parseFloat(r.bidPrice)
      const ask = parseFloat(r.askPrice)
      if (bid > 0 && ask > 0) out[r.symbol] = { bid, ask }
    }
    return out
  } finally {
    clearTimeout(t)
  }
}

export function binanceVenue(
  cred: ExchangeCredentials,
  books: Record<string, TriangleBook>
): TriangleVenue {
  const meta: Record<string, { base: string; quote: string } & VenueFilters> = {}
  const getMeta = async (pair: string) => {
    if (!meta[pair]) {
      const f = await binanceSymbolFilters(pair)
      if (!f) return null
      meta[pair] = f
    }
    return meta[pair]
  }
  return {
    name: 'Binance',
    filters: async (pair) => {
      const m = await getMeta(pair)
      return m ? { ordermin: m.ordermin, costmin: m.costmin, lot: m.lot } : null
    },
    async marketOrder(pair, side, volume) {
      const m = await getMeta(pair)
      if (!m) throw new Error(`sin filtros de Binance para ${pair}`)
      const o = await binanceMarketOrderBase(cred, pair, side === 'buy' ? 'BUY' : 'SELL', volume)
      let feeBase = 0
      let feeQuote = 0
      let feeOtherUsd = 0
      for (const [asset, amt] of Object.entries(o.commissions)) {
        if (asset === m.base) feeBase += amt
        else if (asset === m.quote) feeQuote += amt
        else if (asset === 'USDT') feeOtherUsd += amt
        else feeOtherUsd += amt * (books[`${asset}USDT`]?.bid ?? 0)
      }
      return {
        orderId: o.orderId,
        qty: o.executedQty,
        price: o.price,
        quote: o.executedQuote,
        feeQuote,
        feeBase,
        feeOtherUsd,
      }
    },
    isUnconfirmed: (e) => e instanceof BinanceOrderUnconfirmedError,
  }
}
