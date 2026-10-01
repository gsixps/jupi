// BINANCE trading hook — CLIENT-SIDE, triangular arbitrage.
//
// Two modes:
//   • DEMO (default) — real market data from the Binance public API with
//     FICTIONAL USD capital. No orders are ever sent.
//   • REAL — the user provides Binance API keys in the panel; the hook then
//     places real spot MARKET orders and the capital is the real USDT balance.
//     Compound interest scales the per-trade budget with the real equity.
//
// One tick = one strategy cycle (same skeleton as seabot / curve):
//   1. Refresh live quotes for every watched symbol (REAL Binance API, with
//      the deterministic mock as fallback for sandbox).
//   2. For each open position, SELL when the spread widened to take-profit,
//      dropped to stop-loss, or trailed from peak.
//   3. For each triangle route, BUY when direct vs implied USD price differ by
//      ≥ minSpreadBps: buy the token via the cheap leg, target the dear leg.
//   4. Update stats + log everything.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  BINANCE_SYMBOLS,
  BINANCE_TRIANGLES,
  BINANCE_API_BASE,
  mockSymbolUsdPrice,
} from '@/lib/binance'
import type {
  BinanceArbOpportunity,
  BinancePriceRow,
  BinanceTriangleRoute,
} from '@/lib/binance'
import {
  binanceGetBalances,
  binanceLotSize,
  binanceMarketOrder,
  loadCreds,
  type ExchangeBalance,
  type ExchangeCredentials,
} from '@/lib/cex'
import type { EquityPoint } from '@/lib/trading-types'
import {
  clearLiveSnapshot,
  loadLiveSnapshot,
  reconcileLiveState,
  saveLiveSnapshot,
} from '@/lib/live-state'
import { planTriangleCycle, cyclePathLabel, type CyclePlan, type TrianglePairBook } from '@/lib/triangle-exec'
import { executeTriangleCycle } from '@/lib/triangle-live'
import { binanceVenue, fetchBinanceBooks } from '@/lib/binance-triangle-live'
import { TAKER_FEE, paperRoundTrip } from '@/lib/paper-fees'

const LIVE_BOT = 'binance'

// 3-LEG TRIANGLE (demo AND live use the same planner, books and fees, so a
// demo cycle is exactly what the live bot would have done).
/** Binance spot taker fee per leg, in bps (no BNB discount). */
const FEE_BPS_PER_LEG = TAKER_FEE.binance * 10000
/** Minimum NET return of a cycle, after the 3 fees. */
const MIN_NET_PROFIT_BPS = 10
/** Skip a cycle when any of its 3 books is wider than this. */
const MAX_BOOK_SPREAD_BPS = 30
// LIVE risk controls (not a promise of profitability).
const LIVE_MAX_CYCLE_USD = 25
const LIVE_FUNDS_BUFFER = 0.02
const LIVE_MAX_DAILY_LOSS_USD = 5
const LIVE_MAX_CONSECUTIVE_LOSSES = 3
const LIVE_COOLDOWN_MS = 60_000

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const LOG_CAP = 120

export interface BinanceConfig {
  capitalUsd: number
  budgetPerTradeUsd: number
  maxHoldings: number
  minSpreadBps: number // buy trigger: |implied - direct| ≥ this
  stopLossBps: number
  trailingBps: number // trailing exit in bps off the peak spread
  tickIntervalMs: number
  dataMode: 'live' | 'mock'
  compound: boolean // reinvest profits → per-trade budget scales with equity
  /** Place real orders with real capital (requires Binance API keys). */
  liveTrading: boolean
}

export const DEFAULT_BINANCE_CONFIG: BinanceConfig = {
  capitalUsd: 10000,
  budgetPerTradeUsd: 2000,
  maxHoldings: 6,
  minSpreadBps: 3,
  stopLossBps: 2,
  trailingBps: 2,
  tickIntervalMs: 10000,
  dataMode: 'live',
  compound: true,
  liveTrading: false,
}

export interface BinanceHolding {
  id: string
  routeId: string
  routeName: string
  token: string
  side: 'direct_cheap' | 'cross_cheap'
  buyPrice: number // normalized USD per token paid (cheap leg)
  currentPrice: number // normalized USD per token (dear leg now)
  peakPrice: number
  notionalUsd: number
  status: 'open' | 'sold'
  boughtAt: number
  soldAt?: number
  sellPrice?: number
  pnlUsd?: number
  /** LIVE only: base quantity actually filled on the exchange. */
  realBaseQty?: number
  /** LIVE only: quote amount actually paid (BUY) or received (SELL). */
  realQuoteUsd?: number
  /** LIVE only: real order ids, for reconciliation. */
  realOrderId?: string
  realExitOrderId?: string
}

export interface BinanceTrade {
  id: string
  /** 'cycle' = one complete 3-leg triangle (USDT → … → USDT). */
  type: 'buy' | 'sell' | 'cycle'
  routeId: string
  routeName: string
  token: string
  priceUsd: number
  notionalUsd: number
  pnlUsd: number
  profitBps: number
  reason: string
  status: 'open' | 'filled'
  createdAt: number
}

export interface BinanceStats {
  running: boolean
  startedAt: number | null
  uptimeMs: number
  capitalUsd: number
  cashUsd: number
  investedUsd: number
  equityUsd: number
  realizedPnlUsd: number
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  openHoldings: number
  arbsDetected: number
  scanCount: number
  lastScanAt: number
  liveData: boolean
  compound: boolean
  compoundFactor: number
}

export interface BinanceLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

export interface BinanceState {
  enabled: boolean
  config: BinanceConfig
  cashUsd: number
  rows: BinancePriceRow[]
  holdings: BinanceHolding[]
  trades: BinanceTrade[]
  stats: BinanceStats | null
  equityCurve: EquityPoint[]
  logs: BinanceLogEntry[]
  status: 'idle' | 'scanning' | 'executing' | 'paused'
  priceHistory: Record<string, number[]>
  opps: BinanceArbOpportunity[]
  lastUpdatedAt: number | null
  dataSource: 'live' | 'mock'
  /**
   * LIVE safety latch. When a real order is rejected (insufficient balance,
   * min notional, API error) the bot stops itself and records why. It NEVER
   * falls back to the simulated engine with real money at stake.
   */
  halted: boolean
  haltReason: string | null
}

/** Build price rows (live or mock). */
function buildRows(
  now: number,
  mode: BinanceConfig['dataMode'],
  live?: Record<string, number>
): BinancePriceRow[] {
  return BINANCE_SYMBOLS.map((s) => {
    let priceUsd = s.anchorUsd
    if (live) {
      const p = live[s.symbol]
      if (p && p > 0) priceUsd = p
    } else if (mode === 'mock') {
      priceUsd = mockSymbolUsdPrice(s.symbol, s.anchorUsd, now)
    }
    return { symbol: s.symbol, base: s.base, quote: s.quote, priceUsd, anchorUsd: s.anchorUsd }
  })
}

async function fetchBinancePrices(): Promise<Record<string, number>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(BINANCE_API_BASE, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`binance api ${res.status}`)
    const arr = (await res.json()) as { symbol: string; price: string }[]
    const out: Record<string, number> = {}
    for (const x of arr) {
      const p = parseFloat(x.price)
      if (isFinite(p)) out[x.symbol] = p
    }
    return out
  } finally {
    clearTimeout(t)
  }
}

/** Direct vs implied divergence: positive means cross-implied > direct. */
function routeSpread(
  route: BinanceTriangleRoute,
  priceBySym: Record<string, number>
): { directUsd: number; impliedUsd: number; spreadBps: number } | null {
  const direct = priceBySym[route.directSymbol]
  const cross = priceBySym[route.crossSymbol]
  const usdt = priceBySym[route.usdtSymbol]
  if (!direct || !cross || !usdt || direct <= 0) return null
  const implied = cross * usdt
  const spreadBps = Math.round(((implied - direct) / direct) * 10000)
  return { directUsd: direct, impliedUsd: implied, spreadBps }
}

export function useBinanceBot() {
  const [state, setState] = useState<BinanceState>(() => {
    const now = Date.now()
    const rows = buildRows(now, 'mock')
    const priceHistory: Record<string, number[]> = {}
    for (const r of rows) {
      const h: number[] = []
      for (let i = 20; i >= 0; i--) {
        h.push(mockSymbolUsdPrice(r.symbol, r.anchorUsd, now - i * 10000))
      }
      priceHistory[r.symbol] = h
    }
    // LIVE positions survive a refresh: without this the bot forgets the coins
    // it owns on Binance and buys the same asset twice.
    const snap = loadLiveSnapshot<BinanceHolding>(LIVE_BOT)
    return {
      enabled: false,
      config: { ...DEFAULT_BINANCE_CONFIG },
      cashUsd: snap?.cashUsd ?? DEFAULT_BINANCE_CONFIG.capitalUsd,
      rows,
      holdings: snap?.open ?? [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: snap
        ? [
            {
              time: Date.now(),
              msg: `Sesión live restaurada: ${snap.open.length} posición(es) abierta(s) desde ${new Date(snap.savedAt).toLocaleString()}. Se verificará contra Binance al arrancar.`,
              level: 'info',
            },
          ]
        : [],
      status: 'idle',
      priceHistory,
      opps: [],
      lastUpdatedAt: null,
      dataSource: 'mock',
      halted: false,
      haltReason: null,
    }
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  /** consecutive ticks without fresh Binance quotes */
  const liveFailRef = useRef(0)
  const liveRiskRef = useRef({
    day: new Date().toISOString().slice(0, 10),
    realizedPnl: 0,
    consecutiveLosses: 0,
    lastOrderAt: 0,
  })

  const log = useCallback((msg: string, level: BinanceLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[binance] ${msg}`)
  }, [])

  /**
   * Stop the bot for good (or until the user presses Start again) and surface
   * the reason. Used whenever a REAL order path fails: with real money we
   * would rather halt and warn than quietly keep simulating.
   */
  const halt = useCallback(
    (reason: string) => {
      if (loopRef.current) {
        clearInterval(loopRef.current)
        loopRef.current = null
      }
      setState((s) => ({
        ...s,
        enabled: false,
        halted: true,
        haltReason: reason,
        status: 'paused',
        stats: s.stats ? { ...s.stats, running: false } : s.stats,
      }))
      log(`⛔ BOT DETENIDO (live): ${reason}`, 'error')
    },
    [log]
  )

  const scan = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const s0 = stateRef.current
      if (!s0.enabled) {
        inFlightRef.current = false
        return
      }
      setState((s) => ({ ...s, status: 'scanning' }))
      const now = Date.now()
      const cfg = s0.config

      // 1. Refresh quotes — live Binance API or mock engine
      let rows: BinancePriceRow[]
      let liveData = false
      // Executable books (bid/ask) for the 3-leg planner.
      let books: Record<string, TrianglePairBook> | null = null
      if (cfg.dataMode === 'live' || cfg.liveTrading) {
        try {
          const [live, b] = await Promise.all([
            fetchBinancePrices(),
            fetchBinanceBooks(BINANCE_SYMBOLS.map((x) => x.symbol)),
          ])
          rows = buildRows(now, 'live', live)
          books = b
          liveData = true
          liveFailRef.current = 0
        } catch (e) {
          // REAL prices only: no simulated fallback, in demo or live. Skip the
          // tick; with real money, halt after 5 in a row.
          liveFailRef.current += 1
          if (cfg.liveTrading && liveFailRef.current >= 5) {
            halt(`Binance API inaccesible ${liveFailRef.current} ciclos seguidos — detenido por seguridad`)
            return
          }
          log(`Binance API no disponible (${(e as Error).message}) — ciclo omitido, sin precios simulados`, 'warn')
          setState((st) => ({ ...st, status: 'paused' }))
          return
        }
      } else {
        // Explicit SIMULATION mode chosen by the user: synthetic prices,
        // labelled as such, never used with real money.
        rows = buildRows(now, 'mock')
        books = {}
        for (const r of rows) books[r.symbol] = { bid: r.priceUsd, ask: r.priceUsd }
      }

      const priceBySym: Record<string, number> = {}
      for (const r of rows) priceBySym[r.symbol] = r.priceUsd

      const priceHistory: Record<string, number[]> = {}
      for (const r of rows) {
        const arr = [...(s0.priceHistory[r.symbol] ?? []), r.priceUsd]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        priceHistory[r.symbol] = arr
      }
      setState((s) => ({
        ...s,
        rows,
        priceHistory,
        dataSource: liveData ? 'live' : 'mock',
        lastUpdatedAt: now,
      }))


      // 2. SELL logic — scan open holdings (spread converged? stop? trail?)
      let cash = stateRef.current.cashUsd
      let holdings = stateRef.current.holdings.map((h) => ({ ...h }))
      const trades = [...stateRef.current.trades]
      const opps: BinanceArbOpportunity[] = []

      // LIVE: resolve the credential once per scan and mirror the real USDT
      // balance so `cash` always matches what the exchange actually holds.
      let cred: ExchangeCredentials | null = null
      let realTrades = 0
      if (cfg.liveTrading) {
        cred = loadCreds('binance')
        if (!cred || !cred.apiKey || !cred.apiSecret) {
          halt('faltan credenciales de Binance (API key + secret)')
          return
        }
        let bals: ExchangeBalance[]
        try {
          bals = await binanceGetBalances(cred)
          const usdt = bals.find((b) => b.symbol === 'USDT')
          if (!usdt) {
            halt('la cuenta de Binance no tiene saldo en USDT')
            return
          }
          cash = usdt.free
        } catch (e) {
          halt(`no se pudo leer el saldo real: ${(e as Error).message}`)
          return
        }

        // Binance decides the quantities: a refresh, a manual sell or a partial
        // fill all end up here.
        const open = holdings.filter((h) => h.status === 'open')
        if (open.length > 0) {
          const balances = new Map<string, number>()
          for (const b of bals) balances.set(b.symbol, b.free)
          const rec = reconcileLiveState<BinanceHolding>({
            bot: LIVE_BOT,
            persisted: open,
            balances,
            minQty: 0.00000001,
            view: (h) => ({ liveAsset: h.token, liveQty: h.realBaseQty ?? 0, liveLabel: h.routeName }),
            withQty: (h, qty) => ({ ...h, realBaseQty: qty }),
          })
          for (const n of rec.notes) log(`Binance: ${n}`, 'info')
          if (rec.fatal) {
            halt(rec.fatal)
            return
          }
          const gone = new Set(rec.missing.map((h) => h.id))
          holdings = [
            ...rec.holdings,
            ...open
              .filter((h) => gone.has(h.id))
              .map((h) => ({
                ...h,
                status: 'sold' as const,
                soldAt: Date.now(),
                sellPrice: h.currentPrice,
                pnlUsd: 0,
              })),
          ]
          if (rec.missing.length > 0) {
            log(
              `Binance: ${rec.missing.length} posición(es) ya no existen en la cuenta y se marcan como cerradas`,
              'warn'
            )
          }
        }
      }

      for (const h of holdings) {
        if (h.status !== 'open') continue
        const route = BINANCE_TRIANGLES.find((r) => r.id === h.routeId)
        if (!route) continue
        const s = routeSpread(route, priceBySym)
        if (!s) continue
        // current normalized USD per token depends on which leg was bought
        const cur = h.side === 'cross_cheap' ? s.directUsd : s.impliedUsd
        h.currentPrice = cur
        const target = h.buyPrice * (1 + cfg.minSpreadBps / 10000)
        const stop = h.buyPrice * (1 - cfg.stopLossBps / 10000)

        let reason: string | null = null
        if (cur >= target) {
          reason = `Take profit ${cfg.minSpreadBps}bps`
        } else if (cur <= stop) {
          reason = `Stop loss -${cfg.stopLossBps}bps`
        } else if (
          cfg.trailingBps > 0 &&
          cur <= h.peakPrice * (1 - cfg.trailingBps / 10000)
        ) {
          reason = `Trailing stop -${cfg.trailingBps}bps from peak`
        }

        if (reason) {
          // LIVE: the exit is a real SELL of the base quantity we actually
          // received. Use the exchange fill as the source of truth for P&L.
          if (cfg.liveTrading && cred) {
            const qty = h.realBaseQty ?? 0
            if (qty <= 0) {
              halt(`posición ${h.routeName} sin cantidad real registrada; no se puede cerrar`)
              return
            }
            const symbol = `${h.token}USDT`
            let order
            try {
              order = await binanceMarketOrder({ cred, symbol, side: 'SELL', sellBaseQty: qty })
            } catch (e) {
              halt(`orden SELL ${symbol} rechazada: ${(e as Error).message}`)
              return
            }
            if (order.executedQty <= 0) {
              halt(`orden SELL ${symbol} sin fills (${order.orderId})`)
              return
            }
            const proceeds = order.executedQuote
            h.realExitOrderId = order.orderId
            h.realBaseQty = order.executedQty
            h.realQuoteUsd = proceeds
            h.sellPrice = order.price
            h.currentPrice = order.price
            const pnl = proceeds - h.notionalUsd
            h.soldAt = now
            h.status = 'sold'
            h.pnlUsd = pnl
            cash += proceeds
            const pnlBps = Math.round((pnl / h.notionalUsd) * 10000)
            trades.unshift({
              id: `bnt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'sell',
              routeId: h.routeId,
              routeName: h.routeName,
              token: h.token,
              priceUsd: order.price,
              notionalUsd: h.notionalUsd,
              pnlUsd: pnl,
              profitBps: pnlBps,
              reason: `${reason} (real)`,
              status: 'filled',
              createdAt: now,
            })
            opps.unshift({
              id: `bnp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              routeId: h.routeId,
              name: h.routeName,
              side: h.side,
              buyPrice: h.buyPrice,
              sellPrice: order.price,
              spreadBps: pnlBps,
              notionalUsd: h.notionalUsd,
              profitUsd: pnl,
              detectedAt: now,
              executed: true,
            })
            log(
              `LIVE SELL ${symbol} ${order.executedQty} @ ${order.price.toFixed(6)} → ${fmtUsdLocal(proceeds, 2)} USD (${pnl >= 0 ? '+' : ''}${fmtUsdLocal(pnl, 2)})`,
              'trade'
            )
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdLocal(cash, 2)} USD (P&L real ${pnl >= 0 ? '+' : ''}${fmtUsdLocal(pnl, 2)})`,
              'info'
            )
            realTrades++
            continue
          }

          // Honest paper exit: Binance taker fee on the buy AND the sell.
          const pnl = paperRoundTrip(h.notionalUsd, h.buyPrice, cur, TAKER_FEE.binance).pnlUsd
          const pnlBps = Math.round((pnl / h.notionalUsd) * 10000)
          h.status = 'sold'
          h.soldAt = now
          h.sellPrice = cur
          h.pnlUsd = pnl
          cash += h.notionalUsd + pnl
          trades.unshift({
            id: `bnt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'sell',
            routeId: h.routeId,
            routeName: h.routeName,
            token: h.token,
            priceUsd: cur,
            notionalUsd: h.notionalUsd,
            pnlUsd: pnl,
            profitBps: pnlBps,
            reason,
            status: 'filled',
            createdAt: now,
          })
          opps.unshift({
            id: `bnp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            routeId: h.routeId,
            name: h.routeName,
            side: h.side,
            buyPrice: h.buyPrice,
            sellPrice: cur,
            spreadBps: pnlBps,
            notionalUsd: h.notionalUsd,
            profitUsd: pnl,
            detectedAt: now,
            executed: true,
          })
          log(
            `CERRADO ${h.routeName} (${h.token}) — ${cur.toFixed(6)} USD (${pnl >= 0 ? '+' : ''}${fmtBpsLocal(pnlBps)})`,
            'trade'
          )
          if (cfg.compound) {
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdLocal(cash, 2)} USD (P&L ${pnl >= 0 ? '+' : ''}${fmtUsdLocal(pnl, 2)})`,
              'info'
            )
          }
        } else {
          h.peakPrice = Math.max(h.peakPrice, cur)
        }
      }

      // 3. TRIANGLE — plan every route on the live books with the 3 Binance
      // fees; fire only cycles that clear them. DEMO books the planned result,
      // LIVE executes the 3 legs for real. Same planner, same books, same fees.
      const openBefore = holdings.filter((h) => h.status === 'open')
      const investedBefore = openBefore.reduce((a, h) => a + h.notionalUsd, 0)
      const equityBefore = cash + investedBefore
      // Compound interest: scale per-cycle budget with grown capital
      const compoundFactor = cfg.compound ? Math.max(equityBefore, 1) / Math.max(cfg.capitalUsd, 1) : 1
      let notional = Math.min(cfg.budgetPerTradeUsd * compoundFactor, cash)
      const risk = liveRiskRef.current
      let cooling = false
      if (cfg.liveTrading && cred) {
        const today = new Date().toISOString().slice(0, 10)
        if (risk.day !== today) {
          risk.day = today
          risk.realizedPnl = 0
          risk.consecutiveLosses = 0
        }
        if (risk.realizedPnl <= -LIVE_MAX_DAILY_LOSS_USD) {
          halt(`límite diario alcanzado: ${risk.realizedPnl.toFixed(2)} USD`)
          return
        }
        if (risk.consecutiveLosses >= LIVE_MAX_CONSECUTIVE_LOSSES) {
          halt(`${risk.consecutiveLosses} ciclos con pérdida seguidos; revisión manual requerida`)
          return
        }
        cooling = Date.now() - risk.lastOrderAt < LIVE_COOLDOWN_MS
        notional = Math.min(notional, LIVE_MAX_CYCLE_USD, cfg.capitalUsd, cash * (1 - LIVE_FUNDS_BUFFER))
      }

      const candidates: { plan: CyclePlan; route: BinanceTriangleRoute; inter: string }[] = []
      let best: CyclePlan | null = null
      if (books && notional >= 1) {
        for (const route of BINANCE_TRIANGLES) {
          const inter = BINANCE_SYMBOLS.find((x) => x.symbol === route.usdtSymbol)?.base ?? 'X'
          const plan = planTriangleCycle(route, inter, books, notional, FEE_BPS_PER_LEG)
          if (!plan) continue
          if (!best || plan.netBps > best.netBps) best = plan
          if (plan.netBps >= MIN_NET_PROFIT_BPS && plan.netProfitUsd > 0) candidates.push({ plan, route, inter })
        }
        candidates.sort((a, b) => b.plan.netBps - a.plan.netBps)
      }

      if (candidates.length === 0) {
        if (best && (s0.stats?.scanCount ?? 0) % 6 === 0) {
          log(
            `3-leg: sin ciclo rentable — mejor ${best.routeName} ${best.netBps.toFixed(0)}bps netos ` +
              `(bruto ${best.grossBps.toFixed(0)}bps − 3×${FEE_BPS_PER_LEG}bps comisión; necesita ≥ ${MIN_NET_PROFIT_BPS})`,
            'info'
          )
        }
      } else if (!cooling) {
        const { plan, route, inter } = candidates[0]
        const path = cyclePathLabel(plan, inter)
        let pnl = plan.netProfitUsd
        let legText = plan.legs.map((l) => `${l.side === 'buy' ? 'B' : 'S'}:${l.pair}@${l.price.toPrecision(6)}`).join(' → ')
        let label = cfg.dataMode === 'mock' && !cfg.liveTrading ? '[simulación]' : '[demo, precios reales]'
        let executed = true
        if (cfg.liveTrading && cred && books) {
          setState((st) => ({ ...st, status: 'executing' }))
          const outcome = await executeTriangleCycle(binanceVenue(cred, books), plan, route, {
            books,
            maxBookSpreadBps: MAX_BOOK_SPREAD_BPS,
          })
          risk.lastOrderAt = Date.now()
          if (outcome.kind === 'fatal') {
            halt(outcome.reason)
            return
          }
          if (outcome.kind === 'skip') {
            log(`⏭ ${route.name}: ${outcome.reason}`, 'warn')
            executed = false
          } else {
            const legs = outcome.kind === 'done' ? outcome.legs : [...outcome.legs, outcome.unwind]
            pnl = outcome.netProfitUsd
            legText = legs.map((l) => `${l.side === 'buy' ? 'B' : 'S'}:${l.pair}@${l.price.toPrecision(6)}`).join(' → ')
            label = outcome.kind === 'done' ? '[real]' : `DESHECHO [real]: ${outcome.reason}`
            risk.realizedPnl += pnl
            risk.consecutiveLosses = pnl < 0 ? risk.consecutiveLosses + 1 : 0
            realTrades++
          }
        } else {
          // Demo: the cycle settles at the planned USD result (fees included).
          cash += pnl
        }
        if (executed) {
          trades.unshift({
            id: `bnt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'cycle',
            routeId: route.id,
            routeName: route.name,
            token: route.token,
            priceUsd: plan.legs[0].price,
            notionalUsd: plan.notionalUsd,
            pnlUsd: pnl,
            profitBps: Math.round((pnl / plan.notionalUsd) * 10000),
            reason: `${path} ${label} ${legText}`,
            status: 'filled',
            createdAt: now,
          })
          opps.unshift({
            id: `bnp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            routeId: route.id,
            name: route.name,
            side: plan.direction,
            buyPrice: plan.legs[0].price,
            sellPrice: plan.legs[2].price,
            spreadBps: Math.round(plan.grossBps),
            notionalUsd: plan.notionalUsd,
            profitUsd: pnl,
            detectedAt: now,
            executed: true,
          })
          log(
            `3-LEG ${path} ${label} ${pnl >= 0 ? '+' : ''}${fmtUsdLocal(pnl, 4)} USD sobre ${fmtUsdLocal(plan.notionalUsd, 2)} — ${legText}`,
            pnl >= 0 ? 'trade' : 'warn'
          )
        }
        if (cfg.liveTrading) {
          if (risk.realizedPnl <= -LIVE_MAX_DAILY_LOSS_USD) {
            halt(`límite diario alcanzado: P&L real ${risk.realizedPnl.toFixed(2)} USD`)
            return
          }
          if (risk.consecutiveLosses >= LIVE_MAX_CONSECUTIVE_LOSSES) {
            halt(`${risk.consecutiveLosses} ciclos reales con pérdida seguidos; revisión manual requerida`)
            return
          }
        }
      }

      // 3b. LIVE: re-read the real balance after trading so the displayed
      // cash/equity is the exchange truth, not an approximation of the fills.
      if (cfg.liveTrading && cred && realTrades > 0) {
        try {
          const bals = await binanceGetBalances(cred)
          const usdt = bals.find((b) => b.symbol === 'USDT')
          if (usdt) cash = usdt.free
        } catch (e) {
          halt(`no se pudo reconciliar el saldo tras operar: ${(e as Error).message}`)
          return
        }
      }

      // 4. Stats
      const open = holdings.filter((h) => h.status === 'open')
      const invested = open.reduce((a, h) => a + h.notionalUsd, 0)
      const equity = cash + invested
      const sold = holdings.filter((h) => h.status === 'sold')
      // 3-leg cycles close in the same tick: they never become holdings.
      const cycles = trades.filter((t) => t.type === 'cycle')
      const realized =
        sold.reduce((a, h) => a + (h.pnlUsd ?? 0), 0) + cycles.reduce((a, t) => a + t.pnlUsd, 0)
      const wins =
        sold.filter((h) => (h.pnlUsd ?? 0) >= 0).length + cycles.filter((t) => t.pnlUsd >= 0).length
      const total = sold.length + cycles.length
      const prevStats = stateRef.current.stats
      const stats: BinanceStats = {
        running: s0.enabled,
        startedAt: s0.enabled ? (prevStats?.startedAt ?? now) : null,
        uptimeMs: s0.enabled ? now - (prevStats?.startedAt ?? now) : 0,
        capitalUsd: cfg.capitalUsd,
        cashUsd: cash,
        investedUsd: invested,
        equityUsd: equity,
        realizedPnlUsd: realized,
        totalTrades: total,
        wins,
        losses: total - wins,
        winRate: total > 0 ? (wins / total) * 100 : 0,
        openHoldings: open.length,
        arbsDetected: opps.length,
        scanCount: (prevStats?.scanCount ?? 0) + 1,
        lastScanAt: now,
        liveData: stateRef.current.dataSource === 'live',
        compound: cfg.compound,
        compoundFactor,
      }
      const unrealized = open.reduce((a, h) => a + (h.currentPrice - h.buyPrice) * (h.notionalUsd / h.buyPrice), 0)
      const eqPoint: EquityPoint = {
        timestamp: now,
        equity,
        balance: cash,
        openPnl: unrealized,
      }

      setState((s) => ({
        ...s,
        cashUsd: cash,
        holdings,
        trades: trades.slice(0, TRADE_CAP),
        opps: [...opps, ...s.opps].slice(0, TRADE_CAP),
        stats,
        equityCurve: [...s.equityCurve, eqPoint].slice(-200),
        status: 'scanning',
        dataSource: liveData ? 'live' : 'mock',
      }))

      // Persist only what a refresh must not lose: the open live positions.
      if (cfg.liveTrading) {
        saveLiveSnapshot(
          LIVE_BOT,
          holdings.filter((h) => h.status === 'open'),
          { cashUsd: cash, wasRunning: true }
        )
      }

    } finally {
      inFlightRef.current = false
    }
  }, [log])

  const start = useCallback(() => {
    const cfg = stateRef.current.config
    if (cfg.liveTrading) {
      const c = loadCreds('binance')
      if (!c || !c.apiKey || !c.apiSecret) {
        halt('modo live sin credenciales de Binance — configura la API key y el secret')
        return
      }
    }
    setState((s) => ({
      ...s,
      enabled: true,
      halted: false,
      haltReason: null,
      status: 'scanning',
      stats: s.stats ? { ...s.stats, running: true } : s.stats,
    }))
    log(
      cfg.liveTrading
        ? `BINANCE BOT iniciado en MODO LIVE — triangle arb con órdenes reales en ${cfg.capitalUsd.toFixed(2)} USD`
        : `BINANCE BOT iniciado — ${cfg.capitalUsd.toFixed(2)} USD ficticios, triangle arb`,
      'trade'
    )
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => {
      scan().catch((e) => {
        if (stateRef.current.config.liveTrading) halt(`error inesperado: ${e.message}`)
        else log(`Scan error: ${e.message}`, 'error')
      })
    }, cfg.tickIntervalMs)
  }, [scan, log, halt])

  const stop = useCallback(() => {
    setState((s) => ({ ...s, enabled: false, status: 'idle' }))
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log('Binance bot detenido', 'info')
  }, [log])

  const resetAccount = useCallback(() => {
    const cfg = stateRef.current.config
    setState((s) => ({
      ...s,
      enabled: false,
      halted: false,
      haltReason: null,
      status: 'idle',
      cashUsd: cfg.capitalUsd,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: [],
      opps: [],
    }))
    clearLiveSnapshot(LIVE_BOT)
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log(`Cuenta reiniciada a ${cfg.capitalUsd.toFixed(2)} USD`, 'info')
  }, [log])

  /**
   * Resolve a reconciliation stop with Binance as the source of truth. Closes
   * what the exchange no longer holds and lifts the halt. Never places an order.
   */
  const syncWithExchange = useCallback(async () => {
    const cred = loadCreds('binance')
    if (!cred) {
      setState((s) => ({ ...s, halted: true, haltReason: 'no hay credenciales de Binance' }))
      return
    }
    setState((s) => ({ ...s, status: 'scanning' }))
    try {
      const bals = await binanceGetBalances(cred)
      const balances = new Map<string, number>()
      for (const b of bals) balances.set(b.symbol, b.free)
      const now = Date.now()
      const open = stateRef.current.holdings.filter((h) => h.status === 'open')
      const rec = reconcileLiveState<BinanceHolding>({
        bot: LIVE_BOT,
        persisted: open,
        balances,
        minQty: 0.00000001,
        view: (h) => ({ liveAsset: h.token, liveQty: h.realBaseQty ?? 0, liveLabel: h.routeName }),
        withQty: (h, qty) => ({ ...h, realBaseQty: qty }),
      })
      const gone = new Set(rec.missing.map((h) => h.id))
      const holdings = [
        ...open.filter((h) => !gone.has(h.id) && (h.realBaseQty ?? 0) > 0),
        ...open
          .filter((h) => gone.has(h.id))
          .map((h) => ({
            ...h,
            status: 'sold' as const,
            soldAt: now,
            sellPrice: h.currentPrice,
            pnlUsd: 0,
          })),
      ]
      const cash = balances.get('USDT') ?? 0
      setState((s) => ({
        ...s,
        holdings: [...s.holdings.filter((h) => h.status === 'sold'), ...holdings],
        cashUsd: cash,
        halted: false,
        haltReason: null,
        status: 'idle',
      }))
      saveLiveSnapshot(LIVE_BOT, holdings, { cashUsd: cash, wasRunning: false })
      log(
        `Sincronizado con Binance: ${holdings.length} posición(es) abierta(s), ${rec.missing.length} cerrada(s), USDT ${cash.toFixed(2)}`,
        'info'
      )
      for (const n of rec.notes) log(`Binance: ${n}`, 'info')
      if (rec.untracked.length > 0) {
        log(`Binance: saldo sin posición registrada: ${rec.untracked.join(', ')}`, 'warn')
      }
    } catch (e) {
      setState((s) => ({ ...s, status: 'idle' }))
      log(`no se pudo sincronizar con Binance: ${(e as Error).message}`, 'error')
    }
  }, [log])

  const updateConfig = useCallback((patch: Partial<BinanceConfig>) => {
    setState((s) => {
      const next = { ...s.config, ...patch }
      if (patch.capitalUsd !== undefined && !s.enabled) {
        return { ...s, config: next, cashUsd: patch.capitalUsd }
      }
      return { ...s, config: next }
    })
  }, [])

  useEffect(() => {
    return () => {
      if (loopRef.current) clearInterval(loopRef.current)
    }
  }, [])

  return {
    ...state,
    scanCount: state.stats?.scanCount ?? 0,
    start,
    stop,
    scan: () => scan(),
    updateConfig,
    resetAccount,
    syncWithExchange,
    log,
    halt,
  }
}

function fmtBpsLocal(n: number): string {
  if (n >= 0) return `+${(n / 100).toFixed(2)}%`
  return `${(n / 100).toFixed(2)}%`
}

function fmtUsdLocal(n: number, d = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}