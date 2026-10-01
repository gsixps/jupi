// OANDA v20 client for the gold bot (XAU_USD only), through /api/oanda.
//
// Credentials (token + account id + practice/live) live in THIS browser's
// localStorage only; the server route forwards each call and stores nothing.

import type { Candle, TrendInterval } from '@/lib/trend'

export interface OandaCreds {
  token: string
  accountId: string
  env: 'practice' | 'live'
}

const KEY = 'mb_oanda_creds_v1'

export function loadOandaCreds(): OandaCreds | null {
  try {
    const raw = localStorage.getItem(KEY)
    const c = raw ? (JSON.parse(raw) as OandaCreds) : null
    return c?.token && c.accountId ? c : null
  } catch {
    return null
  }
}
export function saveOandaCreds(c: OandaCreds) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    /* storage unavailable */
  }
}
export function clearOandaCreds() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

async function call<T>(
  c: OandaCreds,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  query?: Record<string, string>,
  body?: unknown
): Promise<T> {
  let res: Response
  try {
    res = await fetch('/api/oanda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: c.env, token: c.token, method, path, query, body }),
    })
  } catch (e) {
    throw new OandaUnconfirmedError(`sin respuesta del proxy /api/oanda: ${(e as Error).message}`)
  }
  const text = await res.text()
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`OANDA ${res.status}: respuesta ilegible`)
  }
  if (res.status >= 500 && method !== 'GET') {
    throw new OandaUnconfirmedError(`OANDA ${res.status}: estado de la orden desconocido`)
  }
  if (!res.ok) {
    const m = (j as { errorMessage?: string })?.errorMessage ?? text.slice(0, 200)
    throw new Error(`OANDA ${res.status}: ${m}`)
  }
  return j as T
}

/** The order may or may not exist (network / 5xx): never re-send blindly. */
export class OandaUnconfirmedError extends Error {
  constructor(msg: string) {
    super(`${msg}. Revisa en OANDA (Trades abiertos) antes de volver a arrancar.`)
    this.name = 'OandaUnconfirmedError'
  }
}

export interface OandaSummary {
  balance: number
  nav: number
  marginAvailable: number
  currency: string
  openTradeCount: number
}

export async function oandaSummary(c: OandaCreds): Promise<OandaSummary> {
  const j = await call<{ account: Record<string, string | number> }>(c, 'GET', `/v3/accounts/${c.accountId}/summary`)
  const a = j.account
  return {
    balance: Number(a.balance),
    nav: Number(a.NAV),
    marginAvailable: Number(a.marginAvailable),
    currency: String(a.currency),
    openTradeCount: Number(a.openTradeCount),
  }
}

export interface OandaGoldSpec {
  minimumTradeSize: number
  tradeUnitsPrecision: number
  marginRate: number
  /** annual financing rate for a LONG position (negative = you pay) */
  longRate: number
}

export async function oandaGoldSpec(c: OandaCreds): Promise<OandaGoldSpec> {
  const j = await call<{
    instruments: {
      name: string
      minimumTradeSize: string
      tradeUnitsPrecision: number
      marginRate: string
      financing?: { longRate?: string }
    }[]
  }>(c, 'GET', `/v3/accounts/${c.accountId}/instruments`, { instruments: 'XAU_USD' })
  const i = j.instruments.find((x) => x.name === 'XAU_USD')
  if (!i) throw new Error('XAU_USD no disponible en esta cuenta de OANDA')
  return {
    minimumTradeSize: Number(i.minimumTradeSize) || 1,
    tradeUnitsPrecision: Number(i.tradeUnitsPrecision) || 0,
    marginRate: Number(i.marginRate) || 0.05,
    longRate: Number(i.financing?.longRate ?? -0.06),
  }
}

export async function oandaGoldPrice(c: OandaCreds): Promise<{ bid: number; ask: number }> {
  const j = await call<{ prices: { bids: { price: string }[]; asks: { price: string }[] }[] }>(
    c,
    'GET',
    `/v3/accounts/${c.accountId}/pricing`,
    { instruments: 'XAU_USD' }
  )
  const p = j.prices[0]
  return { bid: Number(p?.bids?.[0]?.price), ask: Number(p?.asks?.[0]?.price) }
}

const GRAN: Record<TrendInterval, string> = { '1h': 'H1', '4h': 'H4' }

/** XAU_USD mid candles (complete ones only). */
export async function oandaGoldCandles(c: OandaCreds, interval: TrendInterval, count: number): Promise<Candle[]> {
  const j = await call<{
    candles: { time: string; complete: boolean; volume: number; mid: { o: string; h: string; l: string; c: string } }[]
  }>(c, 'GET', '/v3/instruments/XAU_USD/candles', {
    granularity: GRAN[interval],
    count: String(Math.min(5000, count)),
    price: 'M',
  })
  return j.candles
    .filter((x) => x.complete)
    .map((x) => ({
      t: Math.round(Number(x.time) * 1000),
      o: Number(x.mid.o),
      h: Number(x.mid.h),
      l: Number(x.mid.l),
      c: Number(x.mid.c),
      v: x.volume,
    }))
}

export interface OandaFill {
  tradeId: string
  units: number
  price: number
  /** realized P&L reported by OANDA on a close (account currency) */
  pl: number
  financing: number
}

/** MARKET buy of `units` oz with a protective stop attached at the broker. */
export async function oandaBuyGold(c: OandaCreds, units: number, stop: number, precision: number): Promise<OandaFill> {
  const j = await call<{
    orderFillTransaction?: { tradeOpened?: { tradeID: string; units: string; price: string }; price?: string }
    orderCancelTransaction?: { reason?: string }
  }>(c, 'POST', `/v3/accounts/${c.accountId}/orders`, undefined, {
    order: {
      type: 'MARKET',
      instrument: 'XAU_USD',
      units: units.toFixed(precision),
      timeInForce: 'FOK',
      positionFill: 'DEFAULT',
      stopLossOnFill: { price: stop.toFixed(2), timeInForce: 'GTC' },
    },
  })
  const t = j.orderFillTransaction?.tradeOpened
  if (!t) throw new Error(`orden rechazada por OANDA: ${j.orderCancelTransaction?.reason ?? 'sin ejecución'}`)
  return { tradeId: t.tradeID, units: Number(t.units), price: Number(t.price), pl: 0, financing: 0 }
}

export async function oandaCloseTrade(c: OandaCreds, tradeId: string): Promise<OandaFill> {
  const j = await call<{
    orderFillTransaction?: { price?: string; pl?: string; financing?: string; units?: string }
  }>(c, 'PUT', `/v3/accounts/${c.accountId}/trades/${tradeId}/close`, undefined, { units: 'ALL' })
  const f = j.orderFillTransaction
  if (!f) throw new Error('OANDA no confirmó el cierre')
  return {
    tradeId,
    units: Math.abs(Number(f.units)),
    price: Number(f.price),
    pl: Number(f.pl ?? 0),
    financing: Number(f.financing ?? 0),
  }
}

/** Move the broker-side stop of an open trade (trailing stop). */
export async function oandaMoveStop(c: OandaCreds, tradeId: string, stop: number): Promise<void> {
  await call(c, 'PUT', `/v3/accounts/${c.accountId}/trades/${tradeId}/orders`, undefined, {
    stopLoss: { price: stop.toFixed(2), timeInForce: 'GTC' },
  })
}

export async function oandaOpenGoldTrades(c: OandaCreds): Promise<{ id: string; units: number; price: number }[]> {
  const j = await call<{ trades: { id: string; instrument: string; currentUnits: string; price: string }[] }>(
    c,
    'GET',
    `/v3/accounts/${c.accountId}/openTrades`
  )
  return j.trades
    .filter((t) => t.instrument === 'XAU_USD')
    .map((t) => ({ id: t.id, units: Number(t.currentUnits), price: Number(t.price) }))
}
