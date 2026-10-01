// KRAKEN paper-trading hook — CLIENT-SIDE, triangular arbitrage over the full
// Kraken product shelf (crypto majors, stables, gold, cross pairs, EUR pairs
// and fiat crosses).
//
// One tick = one strategy cycle (same skeleton as seabot / curve / binance):
//   1. Refresh live quotes for every watched pair (REAL Kraken Ticker API,
//      with the deterministic mock as fallback for sandbox).
//   2. For each open position, SELL when the spread widened to take-profit,
//      dropped to stop-loss, or trailed from peak.
//   3. For each triangle route, BUY when direct vs implied USD price differ by
//      ≥ minSpreadBps: buy the token via the cheap leg, target the dear leg.
//   4. Update stats + log everything.
//
// Paper mode is fictional. LIVE mode can place real Kraken orders only after explicit activation and safety checks.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  KRAKEN_ASSETS,
  KRAKEN_TRIANGLES,
  buildKrakenRows,
  fetchKrakenTickers,
  mockKrakenPrice,
} from '@/lib/kraken'
import type {
  KrakenPriceRow,
  KrakenTickerQuote,
  KrakenTriangleRoute,
} from '@/lib/kraken'
import type { EquityPoint } from '@/lib/trading-types'
import {
  krakenBaseAsset,
  krakenGetBalances,
  krakenMarketOrder,
  krakenUsdFree,
  krakenStablesFree,
  loadCreds,
  type ExchangeCredentials,
  type ExchangeBalance,
} from '@/lib/cex'
import {
  clearLiveSnapshot,
  loadLiveSnapshot,
  reconcileLiveState,
  saveLiveSnapshot,
} from '@/lib/live-state'
import {
  cyclePathLabel,
  planTriangleCycle,
  type CyclePlan,
  type TrianglePairBook,
} from '@/lib/triangle-exec'
import { executeLiveTriangle } from '@/lib/kraken-triangle-live'
import { TAKER_FEE, paperRoundTrip } from '@/lib/paper-fees'

const LIVE_BOT = 'kraken'

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const LOG_CAP = 120

// LIVE SAFETY DEFAULTS.
// These are risk controls, not a promise of profitability.
const LIVE_MAX_ORDER_USD = 10
const LIVE_MAX_DAILY_LOSS_USD = 5
const LIVE_MAX_CONSECUTIVE_LOSSES = 3
const LIVE_COOLDOWN_MS = 60_000
/** Share of free USD kept aside for taker fee (≤0.40%) + market slippage. */
const LIVE_FUNDS_BUFFER = 0.02
/** Kraken's smallest order cost on USD pairs (costmin 0.5). */
const LIVE_MIN_ORDER_USD = 0.5
/** Take-profit floor in LIVE: must clear the round trip of taker fees
 *  (2 × ≤0.40%) plus slippage, whatever the minSpreadBps slider says. */
const LIVE_MIN_TAKE_PROFIT_BPS = 120
/** 3-leg planning fee per leg: Kraken Pro taker for <10k USD 30-day volume. */
const LIVE_FEE_BPS_PER_LEG = 40
/** Minimum NET return of a cycle, after the 3 fees, to send real orders. */
const LIVE_MIN_NET_PROFIT_BPS = 10
/** Skip a cycle when any of its 3 books is wider than this (bps). */
const LIVE_MAX_BOOK_SPREAD_BPS = 30

// Master switch for LIVE. With it on, LIVE runs the sequential 3-leg cycle in
// src/lib/kraken-triangle-live.ts (fill-sized legs, single-order unwind back
// to USD, halt on any unconfirmed order). Set to false to block real orders.
const LIVE_TRIANGLE_EXECUTION_ENABLED = true

export interface KrakenConfig {
  capitalUsd: number
  budgetPerTradeUsd: number
  maxHoldings: number
  minSpreadBps: number // buy trigger: |implied - direct| ≥ this
  stopLossBps: number
  trailingBps: number // trailing exit in bps off the peak spread
  tickIntervalMs: number
  dataMode: 'live' | 'mock'
  compound: boolean // reinvest profits → per-trade budget scales with equity
  /** Place real orders with real capital (requires Kraken API keys). */
  liveTrading: boolean
}

export const DEFAULT_KRAKEN_CONFIG: KrakenConfig = {
  capitalUsd: 1000,
  budgetPerTradeUsd: 10,
  maxHoldings: 1,
  minSpreadBps: 100,
  stopLossBps: 100,
  trailingBps: 50,
  tickIntervalMs: 10000,
  dataMode: 'live',
  compound: false,
  liveTrading: false,
}

export interface KrakenHolding {
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
  /** LIVE only: base quantity actually filled on Kraken. */
  realBaseQty?: number
  /** LIVE only: quote amount actually paid (BUY) or received (SELL). */
  realQuoteUsd?: number
  /** LIVE only: real Kraken order ids (txid) for reconciliation. */
  realOrderId?: string
  realExitOrderId?: string
  /** LIVE only: the USD pair the position was opened on. */
  realPair?: string
}

export interface KrakenTrade {
  id: string
  /** 'cycle' = one complete LIVE 3-leg triangle (USD → … → USD). */
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

export interface KrakenStats {
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

export interface KrakenLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

export interface KrakenState {
  enabled: boolean
  config: KrakenConfig
  cashUsd: number
  rows: KrakenPriceRow[]
  holdings: KrakenHolding[]
  trades: KrakenTrade[]
  stats: KrakenStats | null
  equityCurve: EquityPoint[]
  logs: KrakenLogEntry[]
  status: 'idle' | 'scanning' | 'executing' | 'paused'
  priceHistory: Record<string, number[]>
  opps: (KrakenArbOpportunity)[]
  lastUpdatedAt: number | null
  dataSource: 'live' | 'mock'
  /**
   * LIVE safety latch. A rejected real order (no funds, below the pair minimum,
   * API error) stops the bot and records why. It never silently falls back to
   * the simulated engine while real money is at stake.
   */
  halted: boolean
  haltReason: string | null
  /**
   * Set when the halt was caused by a mismatch between the recorded positions
   * and what Kraken actually holds. The UI uses this to offer the manual
   * "sync with the exchange" action, instead of guessing from the message text.
   */
  syncOffer: string | null
}

export interface KrakenArbOpportunity {
  id: string
  routeId: string
  name: string
  side: 'direct_cheap' | 'cross_cheap'
  buyPrice: number
  sellPrice: number
  spreadBps: number
  notionalUsd: number
  profitUsd: number
  detectedAt: number
  executed: boolean
}

/** Build the raw quote map (symbol → own-quote price) for live or mock. */
function buildRaw(
  now: number,
  mode: KrakenConfig['dataMode'],
  live?: Record<string, KrakenTickerQuote>
): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const a of KRAKEN_ASSETS) {
    if (mode === 'live' && live) {
      const q = live[a.symbol]
      raw[a.symbol] = q ? q.last : a.anchorPerQuote
    } else if (mode === 'mock') {
      raw[a.symbol] = mockKrakenPrice(a.symbol, a.anchorPerQuote, now)
    } else {
      raw[a.symbol] = a.anchorPerQuote
    }
  }
  return raw
}


/** Direct vs implied divergence in USD. Positive ⇒ cross-implied > direct. */
function routeSpread(
  route: KrakenTriangleRoute,
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

export function useKrakenBot() {
  const [state, setState] = useState<KrakenState>(() => {
    const now = Date.now()
    const raw = buildRaw(now, 'mock')
    const rows = buildKrakenRows(raw, null, now, 'mock')
    const priceHistory: Record<string, number[]> = {}
    for (const a of KRAKEN_ASSETS) {
      const h: number[] = []
      for (let i = 20; i >= 0; i--) {
        h.push(mockKrakenPrice(a.symbol, a.anchorPerQuote, now - i * 10000))
      }
      priceHistory[a.symbol] = h
    }
    // LIVE positions survive a refresh: without this the bot forgets the coins
    // it owns on Kraken and happily buys the same asset twice.
    const snap = loadLiveSnapshot<KrakenHolding>(LIVE_BOT)
    return {
      enabled: false,
      config: { ...DEFAULT_KRAKEN_CONFIG },
      cashUsd: snap?.cashUsd ?? DEFAULT_KRAKEN_CONFIG.capitalUsd,
      rows,
      holdings: snap?.open ?? [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: snap
        ? [
            {
              time: Date.now(),
              msg: `Sesión live restaurada: ${snap.open.length} posición(es) abierta(s) desde ${new Date(snap.savedAt).toLocaleString()}. Se verificará contra Kraken al arrancar.`,
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
      syncOffer: null,
    }
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  /** LIVE: consecutive ticks without fresh Kraken quotes. */
  const liveFailRef = useRef(0)
  const liveRiskRef = useRef({
    day: new Date().toISOString().slice(0, 10),
    realizedPnl: 0,
    consecutiveLosses: 0,
    lastOrderAt: 0,
  })

  const log = useCallback((msg: string, level: KrakenLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[kraken] ${msg}`)
  }, [])

  /**
   * Stop the bot and surface why. Triggered whenever a REAL order path fails:
   * with real money we halt and warn rather than keep simulating.
   */
  const halt = useCallback(
    (reason: string, syncOffer?: string) => {
      if (loopRef.current) {
        clearInterval(loopRef.current)
        loopRef.current = null
      }
      setState((s) => ({
        ...s,
        enabled: false,
        halted: true,
        haltReason: reason,
        syncOffer: syncOffer ?? null,
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

      // 1. Refresh quotes — live Kraken API or mock engine
      let raw: Record<string, number>
      let liveData = false
      // Full books (bid/ask) — the 3-leg planner prices legs at ask/bid, not last.
      let liveTickers: Record<string, KrakenTickerQuote> | null = null
      if (cfg.liveTrading) {
        // REAL MONEY: never trade on simulated or months-old anchor prices.
        // No fresh quotes → skip this tick; 5 in a row → halt.
        liveTickers = await fetchKrakenTickers(KRAKEN_ASSETS.map((a) => a.symbol)).catch(() => null)
        if (!liveTickers) {
          liveFailRef.current += 1
          if (liveFailRef.current >= 5) {
            halt(`Kraken API inaccesible ${liveFailRef.current} ciclos seguidos con dinero real — detenido por seguridad`)
            return
          }
          log(`Kraken API no disponible (${liveFailRef.current}/5) — ciclo omitido (sin precios simulados con dinero real)`, 'warn')
          setState((s) => ({ ...s, status: 'paused' }))
          return
        }
        liveFailRef.current = 0
        raw = {}
        for (const a of KRAKEN_ASSETS) {
          const q = liveTickers[a.symbol]
          if (q) raw[a.symbol] = q.last
        }
        liveData = true
      } else if (cfg.dataMode === 'live') {
        liveTickers = await fetchKrakenTickers(KRAKEN_ASSETS.map((a) => a.symbol)).catch(() => null)
        if (liveTickers) {
          raw = {}
          for (const a of KRAKEN_ASSETS) raw[a.symbol] = liveTickers[a.symbol]?.last ?? a.anchorPerQuote
          liveData = true
        } else {
          // REAL prices only: no simulated fallback in the demo either.
          log('Kraken API no disponible — ciclo omitido, sin precios simulados', 'warn')
          setState((s) => ({ ...s, status: 'paused' }))
          return
        }
      } else {
        raw = buildRaw(now, 'mock')
      }

      const rows = buildKrakenRows(raw, liveTickers, now, liveData ? 'live' : 'mock')
      const priceHistory: Record<string, number[]> = {}
      for (const a of KRAKEN_ASSETS) {
        const sym = a.symbol
        const arr = [...(s0.priceHistory[sym] ?? []), raw[sym] ?? a.anchorPerQuote]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        priceHistory[sym] = arr
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
      const opps: KrakenArbOpportunity[] = []

      // LIVE: mirror the real USD balance (Kraken reports fiat USD as ZUSD).
      let cred: ExchangeCredentials | null = null
      let realTrades = 0
      if (cfg.liveTrading) {
        if (!LIVE_TRIANGLE_EXECUTION_ENABLED) {
          halt(
            'LIVE bloqueado: el motor actual detecta divergencia triangular pero no ejecuta/reconcilia de forma segura las 3 patas. Usa paper hasta instalar y validar el ejecutor 3-leg.'
          )
          return
        }
        cred = loadCreds('kraken')
        if (!cred || !cred.apiKey || !cred.apiSecret) {
          halt('faltan credenciales de Kraken (API key + secret)')
          return
        }
        let bals: ExchangeBalance[]
        try {
          bals = await krakenGetBalances(cred)
          cash = krakenUsdFree(bals)
        } catch (e) {
          halt(`no se pudo leer el saldo real: ${(e as Error).message}`)
          return
        }
        const stables = krakenStablesFree(bals)
        if (cash < LIVE_MIN_ORDER_USD && stables >= LIVE_MIN_ORDER_USD) {
          halt(
            `tu saldo está en USDT/USDC (${stables.toFixed(2)}), pero el bot opera pares en USD (ZUSD: ${cash.toFixed(2)}). ` +
              'Convierte a USD en Kraken (Comprar/Convertir → USD) y vuelve a arrancar.'
          )
          return
        }

        // The exchange decides the quantities. A refresh, a manual sell or a
        // partial fill all end up here.
        const open = holdings.filter((h) => h.status === 'open')
        if (open.length > 0) {
          const balances = new Map<string, number>()
          for (const b of bals) balances.set(b.symbol, b.free)
          const rec = reconcileLiveState<KrakenHolding>({
            bot: LIVE_BOT,
            persisted: open,
            balances,
            minQty: 0.00000001,
            view: (h) => ({
              liveAsset: krakenBaseAsset(h.token),
              liveQty: h.realBaseQty ?? 0,
              liveLabel: h.routeName,
            }),
            withQty: (h, qty) => ({ ...h, realBaseQty: qty }),
          })
          for (const n of rec.notes) log(`Kraken: ${n}`, 'info')
          if (rec.fatal) {
            halt(
              rec.fatal,
              'Las posiciones guardadas no coinciden con Kraken. Pulsa "Sincronizar con el exchange" para adoptar el saldo real de la cuenta; no se coloca ninguna orden.'
            )
            return
          }
          const closed = new Set(rec.missing.map((h) => h.id))
          holdings = [
            ...rec.holdings,
            ...open
              .filter((h) => closed.has(h.id))
              .map((h) => ({
                ...h,
                status: 'sold' as const,
                soldAt: now,
                sellPrice: h.currentPrice,
                pnlUsd: 0,
              })),
          ]
          if (rec.missing.length > 0) {
            log(
              `Kraken: ${rec.missing.length} posición(es) ya no existen en la cuenta y se marcan como cerradas`,
              'warn'
            )
          }
        }
      }

      for (const h of holdings) {
        if (h.status !== 'open') continue
        const route = KRAKEN_TRIANGLES.find((r) => r.id === h.routeId)
        if (!route) continue
        const s = routeSpread(route, raw)
        if (!s) continue
        // current normalized USD per token depends on which leg was bought
        const cur = cfg.liveTrading ? s.directUsd : (h.side === 'cross_cheap' ? s.directUsd : s.impliedUsd)
        h.currentPrice = cur
        const takeProfitBps = cfg.liveTrading
          ? Math.max(cfg.minSpreadBps, LIVE_MIN_TAKE_PROFIT_BPS)
          : cfg.minSpreadBps
        const target = h.buyPrice * (1 + takeProfitBps / 10000)
        const stop = h.buyPrice * (1 - cfg.stopLossBps / 10000)

        let reason: string | null = null
        if (cur >= target) {
          reason = `Take profit ${takeProfitBps}bps`
        } else if (cur <= stop) {
          reason = `Stop loss -${cfg.stopLossBps}bps`
        } else if (
          cfg.trailingBps > 0 &&
          cur <= h.peakPrice * (1 - cfg.trailingBps / 10000)
        ) {
          reason = `Trailing stop -${cfg.trailingBps}bps from peak`
        }

        if (reason) {
          // LIVE: close the real position on the same USD pair it was opened
          // on, using the base quantity Kraken actually filled.
          if (cfg.liveTrading && cred) {
            const qty = h.realBaseQty ?? 0
            const pair = h.realPair
            if (!(qty > 0) || !pair) {
              halt(`posición ${h.routeName} sin cantidad/par real registrado; no se puede cerrar`)
              return
            }
            let order
            try {
              order = await krakenMarketOrder({ cred, pair, side: 'sell', volume: qty })
            } catch (e) {
              halt(`orden SELL ${pair} rechazada: ${(e as Error).message}`)
              return
            }
            if (order.executedQty <= 0) {
              halt(`orden SELL ${pair} sin fills (${order.orderId})`)
              return
            }
            // fciq: Kraken takes the fee from the USD side — net it out.
            const proceeds = order.executedQuote - (order.feeQuote ?? 0)
            h.realExitOrderId = order.orderId
            h.sellPrice = order.price
            h.currentPrice = order.price
            h.realQuoteUsd = proceeds
            const pnl = proceeds - h.notionalUsd
            const pnlBps = Math.round((pnl / h.notionalUsd) * 10000)
            h.status = 'sold'
            h.soldAt = now
            h.pnlUsd = pnl
            cash += proceeds
            trades.unshift({
              id: `krt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
              id: `krp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
              `LIVE SELL ${pair} ${order.executedQty} @ ${order.price.toFixed(6)} → ${fmtUsdKraken(proceeds, 2)} USD (${pnl >= 0 ? '+' : ''}${fmtUsdKraken(pnl, 2)})`,
              'trade'
            )
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdKraken(cash, 2)} USD (P&L real ${pnl >= 0 ? '+' : ''}${fmtUsdKraken(pnl, 2)})`,
              'info'
            )
            const risk = liveRiskRef.current
            const today = new Date().toISOString().slice(0, 10)
            if (risk.day !== today) {
              risk.day = today
              risk.realizedPnl = 0
              risk.consecutiveLosses = 0
            }
            risk.realizedPnl += pnl
            risk.consecutiveLosses = pnl < 0 ? risk.consecutiveLosses + 1 : 0
            risk.lastOrderAt = Date.now()
            realTrades++
            if (risk.realizedPnl <= -LIVE_MAX_DAILY_LOSS_USD) {
              halt(`límite diario alcanzado: P&L real ${risk.realizedPnl.toFixed(2)} USD`)
              return
            }
            if (risk.consecutiveLosses >= LIVE_MAX_CONSECUTIVE_LOSSES) {
              halt(`${risk.consecutiveLosses} pérdidas reales consecutivas; revisión manual requerida`)
              return
            }
            continue
          }

          // Honest paper exit: Kraken taker fee on the buy AND the sell.
          const pnl = paperRoundTrip(h.notionalUsd, h.buyPrice, cur, TAKER_FEE.kraken).pnlUsd
          const pnlBps = Math.round((pnl / h.notionalUsd) * 10000)
          h.status = 'sold'
          h.soldAt = now
          h.sellPrice = cur
          h.pnlUsd = pnl
          cash += h.notionalUsd + pnl
          trades.unshift({
            id: `krt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
            id: `krp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
              `⚡ Interés compuesto: capital disponible → ${fmtUsdKraken(cash, 2)} USD (P&L ${pnl >= 0 ? '+' : ''}${fmtUsdKraken(pnl, 2)})`,
              'info'
            )
          }
        } else {
          h.peakPrice = Math.max(h.peakPrice, cur)
        }
      }

      // 3a. LIVE — full 3-leg triangle cycle (USD → … → USD in one tick).
      if (cfg.liveTrading && cred && liveTickers) {
        const risk = liveRiskRef.current
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
          halt(`${risk.consecutiveLosses} pérdidas consecutivas; revisión manual requerida`)
          return
        }
        const cooling = Date.now() - risk.lastOrderAt < LIVE_COOLDOWN_MS
        // Size from the REAL free USD, minus room for fee + slippage, and
        // never above the per-order cap or the capital the user set.
        const spendable = cash * (1 - LIVE_FUNDS_BUFFER)
        const notional = Math.min(cfg.budgetPerTradeUsd, LIVE_MAX_ORDER_USD, cfg.capitalUsd, spendable)
        if (!cooling && notional < LIVE_MIN_ORDER_USD) {
          halt(
            `saldo USD insuficiente para operar: ${cash.toFixed(2)} USD libres, capital ${cfg.capitalUsd.toFixed(2)} USD. ` +
              'Un ciclo de 3 patas necesita superar el mínimo de Kraken en cada par (≈10 USD o más).'
          )
          return
        }

        // Plan every route on the live books; keep only cycles that clear the
        // three taker fees with margin.
        const books: Record<string, TrianglePairBook> = {}
        for (const [sym, q] of Object.entries(liveTickers)) books[sym] = { bid: q.bid, ask: q.ask }
        const candidates: { plan: CyclePlan; route: KrakenTriangleRoute; inter: string }[] = []
        let best: CyclePlan | null = null
        for (const route of KRAKEN_TRIANGLES) {
          const inter = KRAKEN_ASSETS.find((a) => a.symbol === route.usdtSymbol)?.base ?? 'X'
          const plan = planTriangleCycle(route, inter, books, notional, LIVE_FEE_BPS_PER_LEG)
          if (!plan) continue
          if (!best || plan.netBps > best.netBps) best = plan
          if (plan.netBps >= LIVE_MIN_NET_PROFIT_BPS && plan.netProfitUsd > 0) {
            candidates.push({ plan, route, inter })
          }
        }
        candidates.sort((a, b) => b.plan.netBps - a.plan.netBps)

        if (candidates.length === 0) {
          if (best && s0.stats && s0.stats.scanCount % 6 === 0) {
            log(
              `3-leg: sin ciclo rentable — mejor ${best.routeName} ${best.netBps.toFixed(0)}bps netos ` +
                `(bruto ${best.grossBps.toFixed(0)}bps − 3×${LIVE_FEE_BPS_PER_LEG}bps comisión; necesita ≥ ${LIVE_MIN_NET_PROFIT_BPS})`,
              'info'
            )
          }
        } else if (!cooling) {
          // One cycle per tick: each leg re-reads its fill before the next one.
          const { plan, route, inter } = candidates[0]
          const path = cyclePathLabel(plan, inter)
          log(
            `3-leg ${path} en ${route.name}: plan +${plan.netBps.toFixed(1)}bps netos sobre ${fmtUsdKraken(plan.notionalUsd, 2)} USD — ejecutando`,
            'trade'
          )
          setState((s) => ({ ...s, status: 'executing' }))
          const outcome = await executeLiveTriangle(plan, route, {
            cred,
            tickers: liveTickers,
            maxBookSpreadBps: LIVE_MAX_BOOK_SPREAD_BPS,
          })
          if (outcome.kind === 'fatal') {
            halt(outcome.reason)
            return
          }
          if (outcome.kind === 'skip') {
            log(`⏭ ${route.name}: ${outcome.reason}`, 'warn')
          } else {
            const pnl = outcome.netProfitUsd
            const legs = outcome.kind === 'done' ? outcome.legs : [...outcome.legs, outcome.unwind]
            const legText = legs
              .map((l) => `${l.side === 'buy' ? 'B' : 'S'}:${l.pair}@${l.price.toPrecision(6)}`)
              .join(' → ')
            trades.unshift({
              id: `krt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'cycle',
              routeId: route.id,
              routeName: route.name,
              token: route.token,
              priceUsd: legs[0].price,
              notionalUsd: plan.notionalUsd,
              pnlUsd: pnl,
              profitBps: Math.round((pnl / plan.notionalUsd) * 10000),
              reason:
                outcome.kind === 'done'
                  ? `${path} [real] ${legText}`
                  : `${path} DESHECHO [real]: ${outcome.reason} — ${legText}`,
              status: 'filled',
              createdAt: now,
            })
            opps.unshift({
              id: `krp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              routeId: route.id,
              name: route.name,
              side: plan.direction,
              buyPrice: legs[0].price,
              sellPrice: legs[legs.length - 1].price,
              spreadBps: Math.round(plan.grossBps),
              notionalUsd: plan.notionalUsd,
              profitUsd: pnl,
              detectedAt: now,
              executed: true,
            })
            risk.realizedPnl += pnl
            risk.consecutiveLosses = pnl < 0 ? risk.consecutiveLosses + 1 : 0
            realTrades++
            log(
              outcome.kind === 'done'
                ? `LIVE 3-LEG ${path} ${pnl >= 0 ? '+' : ''}${fmtUsdKraken(pnl, 4)} USD (comisiones ${fmtUsdKraken(outcome.feeTotalUsd, 4)}) — ${legText}`
                : `LIVE 3-LEG DESHECHO ${path}: ${outcome.reason} → ${pnl >= 0 ? '+' : ''}${fmtUsdKraken(pnl, 4)} USD`,
              outcome.kind === 'done' ? 'trade' : 'warn'
            )
          }
          // Any attempt that reached Kraken starts the cooldown.
          risk.lastOrderAt = Date.now()
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

      // 3. DEMO — the SAME 3-leg planner, books and fees as LIVE above, so a
      // demo cycle is exactly what the live bot would have done. The cycle
      // settles at its planned USD result (3 Kraken taker fees included).
      const openBefore = holdings.filter((h) => h.status === 'open')
      const investedBefore = openBefore.reduce((a, h) => a + h.notionalUsd, 0)
      const equityBefore = cash + investedBefore
      // Compound interest: scale per-cycle budget with grown capital
      const compoundFactor = cfg.compound ? Math.max(equityBefore, 1) / Math.max(cfg.capitalUsd, 1) : 1
      if (!cfg.liveTrading) {
        const books: Record<string, TrianglePairBook> = {}
        if (liveTickers) {
          for (const [sym, q] of Object.entries(liveTickers)) books[sym] = { bid: q.bid, ask: q.ask }
        } else {
          // explicit simulation mode: synthetic prices, labelled as such
          for (const [sym, px] of Object.entries(raw)) books[sym] = { bid: px, ask: px }
        }
        const notional = Math.min(cfg.budgetPerTradeUsd * compoundFactor, cash)
        let best: CyclePlan | null = null
        let pick: { plan: CyclePlan; route: KrakenTriangleRoute; inter: string } | null = null
        if (notional >= 1) {
          for (const route of KRAKEN_TRIANGLES) {
            const inter = KRAKEN_ASSETS.find((a) => a.symbol === route.usdtSymbol)?.base ?? 'X'
            const plan = planTriangleCycle(route, inter, books, notional, LIVE_FEE_BPS_PER_LEG)
            if (!plan) continue
            if (!best || plan.netBps > best.netBps) best = plan
            if (plan.netBps >= LIVE_MIN_NET_PROFIT_BPS && plan.netProfitUsd > 0 && (!pick || plan.netBps > pick.plan.netBps)) {
              pick = { plan, route, inter }
            }
          }
        }
        if (pick) {
          const { plan, route, inter } = pick
          const path = cyclePathLabel(plan, inter)
          const label = liveTickers ? '[demo, precios reales]' : '[simulación]'
          const legText = plan.legs
            .map((l) => `${l.side === 'buy' ? 'B' : 'S'}:${l.pair}@${l.price.toPrecision(6)}`)
            .join(' → ')
          cash += plan.netProfitUsd
          trades.unshift({
            id: `krt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'cycle',
            routeId: route.id,
            routeName: route.name,
            token: route.token,
            priceUsd: plan.legs[0].price,
            notionalUsd: plan.notionalUsd,
            pnlUsd: plan.netProfitUsd,
            profitBps: Math.round(plan.netBps),
            reason: `${path} ${label} ${legText}`,
            status: 'filled',
            createdAt: now,
          })
          opps.unshift({
            id: `krp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            routeId: route.id,
            name: route.name,
            side: plan.direction,
            buyPrice: plan.legs[0].price,
            sellPrice: plan.legs[2].price,
            spreadBps: Math.round(plan.grossBps),
            notionalUsd: plan.notionalUsd,
            profitUsd: plan.netProfitUsd,
            detectedAt: now,
            executed: true,
          })
          log(
            `3-LEG ${path} ${label} +${fmtUsdKraken(plan.netProfitUsd, 4)} USD (+${plan.netBps.toFixed(1)}bps netos) — ${legText}`,
            'trade'
          )
        } else if (best && (s0.stats?.scanCount ?? 0) % 6 === 0) {
          log(
            `3-leg: sin ciclo rentable — mejor ${best.routeName} ${best.netBps.toFixed(0)}bps netos ` +
              `(bruto ${best.grossBps.toFixed(0)}bps − 3×${LIVE_FEE_BPS_PER_LEG}bps comisión; necesita ≥ ${LIVE_MIN_NET_PROFIT_BPS})`,
            'info'
          )
        }
      }

      // 3b. LIVE: re-read the real balance after trading so the displayed
      // cash/equity is the exchange truth, not an approximation of the fills.
      if (cfg.liveTrading && cred && realTrades > 0) {
        try {
          cash = krakenUsdFree(await krakenGetBalances(cred))
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
      // LIVE 3-leg cycles close in the same tick: they never become holdings.
      const cycles = trades.filter((t) => t.type === 'cycle')
      const realized =
        sold.reduce((a, h) => a + (h.pnlUsd ?? 0), 0) + cycles.reduce((a, t) => a + t.pnlUsd, 0)
      const wins =
        sold.filter((h) => (h.pnlUsd ?? 0) >= 0).length + cycles.filter((t) => t.pnlUsd >= 0).length
      const total = sold.length + cycles.length
      const prevStats = stateRef.current.stats
      const stats: KrakenStats = {
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
      const unrealized = open.reduce(
        (a, h) => a + (h.currentPrice - h.buyPrice) * (h.notionalUsd / h.buyPrice),
        0
      )
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
      const c = loadCreds('kraken')
      if (!c || !c.apiKey || !c.apiSecret) {
        halt('modo live sin credenciales de Kraken — configura la API key y el secret')
        return
      }
    }
    setState((s) => ({
      ...s,
      enabled: true,
      halted: false,
      haltReason: null,
      syncOffer: null,
      status: 'scanning',
      stats: s.stats ? { ...s.stats, running: true } : s.stats,
    }))
    log(
      cfg.liveTrading
        ? `KRAKEN BOT iniciado en MODO LIVE — triangle arb con órdenes reales en ${cfg.capitalUsd.toFixed(2)} USD`
        : `KRAKEN BOT iniciado — ${cfg.capitalUsd.toFixed(2)} USD ficticios, triangle arb`,
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
    log('Kraken bot detenido', 'info')
  }, [log])

  const resetAccount = useCallback(() => {
    const cfg = stateRef.current.config
    setState((s) => ({
      ...s,
      enabled: false,
      halted: false,
      haltReason: null,
      syncOffer: null,
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
   * Resolve a reconciliation stop: Kraken is read as the source of truth, the
   * positions it no longer holds are closed and the halt is lifted so the user
   * can start again. Never places an order.
   */
  const syncWithExchange = useCallback(async () => {
    const cfg = stateRef.current.config
    const cred = loadCreds('kraken')
    if (!cred) {
      setState((s) => ({ ...s, halted: true, haltReason: 'no hay credenciales de Kraken' }))
      return
    }
    setState((s) => ({ ...s, status: 'scanning' }))
    try {
      const bals = await krakenGetBalances(cred)
      const balances = new Map<string, number>()
      for (const b of bals) balances.set(b.symbol, b.free)
      const now = Date.now()
      const open = stateRef.current.holdings.filter((h) => h.status === 'open')
      const rec = reconcileLiveState<KrakenHolding>({
        bot: LIVE_BOT,
        persisted: open,
        balances,
        minQty: 0.00000001,
        view: (h) => ({
          liveAsset: krakenBaseAsset(h.token),
          liveQty: h.realBaseQty ?? 0,
          liveLabel: h.routeName,
        }),
        withQty: (h, qty) => ({ ...h, realBaseQty: qty }),
      })
      // Force: whatever is recorded but not on Kraken is closed, no stop.
      const missing = new Set(rec.missing.map((h) => h.id))
      const holdings = [
        ...open.filter((h) => !missing.has(h.id) && (h.realBaseQty ?? 0) > 0),
        ...open
          .filter((h) => missing.has(h.id))
          .map((h) => ({
            ...h,
            status: 'sold' as const,
            soldAt: now,
            sellPrice: h.currentPrice,
            pnlUsd: 0,
          })),
      ]
      const cash = krakenUsdFree(bals)
      setState((s) => ({
        ...s,
        holdings: [...s.holdings.filter((h) => h.status === 'sold'), ...holdings],
        cashUsd: cash,
        halted: false,
        haltReason: null,
        syncOffer: null,
        status: 'idle',
      }))
      saveLiveSnapshot(LIVE_BOT, holdings, { cashUsd: cash, wasRunning: false })
      log(
        `Sincronizado con Kraken: ${holdings.length} posición(es) abierta(s), ${rec.missing.length} cerrada(s), USD ${cash.toFixed(2)}`,
        'info'
      )
      for (const n of rec.notes) log(`Kraken: ${n}`, 'info')
      if (rec.untracked.length > 0) {
        log(`Kraken: saldo sin posición registrada: ${rec.untracked.join(', ')}`, 'warn')
      }
    } catch (e) {
      setState((s) => ({ ...s, status: 'idle' }))
      log(`no se pudo sincronizar con Kraken: ${(e as Error).message}`, 'error')
    }
  }, [log])

  const updateConfig = useCallback((patch: Partial<KrakenConfig>) => {
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

function fmtUsdKraken(n: number, d = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}
