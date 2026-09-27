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
  binanceMinNotional,
  loadCreds,
  type ExchangeCredentials,
} from '@/lib/cex'
import type { EquityPoint } from '@/lib/trading-types'

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
  type: 'buy' | 'sell'
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
    return {
      enabled: false,
      config: { ...DEFAULT_BINANCE_CONFIG },
      cashUsd: DEFAULT_BINANCE_CONFIG.capitalUsd,
      rows,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: [],
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
      let liveErr: unknown = null
      if (cfg.dataMode === 'live') {
        try {
          const live = await fetchBinancePrices()
          rows = buildRows(now, 'live', live)
          liveData = true
        } catch (e) {
          liveErr = e
          rows = buildRows(now, 'mock')
        }
      } else {
        rows = buildRows(now, 'mock')
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

      if (liveErr) {
        log(`Binance API no disponible — usando motor demo determinista`, 'warn')
      }

      // 2. SELL logic — scan open holdings (spread converged? stop? trail?)
      let cash = stateRef.current.cashUsd
      const holdings = stateRef.current.holdings.map((h) => ({ ...h }))
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
        try {
          const bals = await binanceGetBalances(cred)
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

          const pnl = (cur - h.buyPrice) * (h.notionalUsd / h.buyPrice)
          const pnlBps = Math.round(((cur - h.buyPrice) / h.buyPrice) * 10000)
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

      // 3. BUY logic — detect divergences ≥ minSpreadBps
      const openBefore = holdings.filter((h) => h.status === 'open')
      const investedBefore = openBefore.reduce((a, h) => a + h.notionalUsd, 0)
      const equityBefore = cash + investedBefore
      // Compound interest: scale per-trade budget with grown capital
      const compoundFactor = cfg.compound ? Math.max(equityBefore, 1) / Math.max(cfg.capitalUsd, 1) : 1
      const openCount = openBefore.length
      let buys = 0
      for (const route of BINANCE_TRIANGLES) {
        if (openCount + buys >= cfg.maxHoldings) break
        const s = routeSpread(route, priceBySym)
        if (!s) continue
        const spread = Math.abs(s.spreadBps)
        if (spread < cfg.minSpreadBps) continue

        const alreadyOpen = holdings.some(
          (h) => h.status === 'open' && h.routeId === route.id
        )
        if (alreadyOpen) continue

        const notional = Math.min(cfg.budgetPerTradeUsd * compoundFactor, cash)
        if (notional < 0.01) continue

        const crossCheap = s.impliedUsd < s.directUsd // token cheaper via cross
        const buyPrice = crossCheap ? s.impliedUsd : s.directUsd
        const sellPrice = crossCheap ? s.directUsd : s.impliedUsd
        const profitUsd = ((sellPrice - buyPrice) / buyPrice) * notional

        // LIVE: place the real BUY first — the simulated position below is
        // only created from the actual fill.
        if (cfg.liveTrading && cred) {
          const symbol = `${route.token}USDT`
          const minNotional = await binanceMinNotional(symbol).catch(() => 0)
          if (minNotional > 0 && notional < minNotional) {
            log(
              `⏭ ${route.name}: ${fmtUsdLocal(notional, 2)} USD < mínimo de Binance (${fmtUsdLocal(minNotional, 2)}) — se omite esta señal`,
              'warn'
            )
            continue
          }
          let order
          try {
            order = await binanceMarketOrder({ cred, symbol, side: 'BUY', buyQuoteUsd: notional })
          } catch (e) {
            halt(`orden BUY ${symbol} rechazada: ${(e as Error).message}`)
            return
          }
          if (order.executedQty <= 0) {
            halt(`orden BUY ${symbol} sin fills (${order.orderId})`)
            return
          }
          const spent = order.executedQuote
          const fillPrice = order.price
          holdings.unshift({
            id: `bnh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            routeId: route.id,
            routeName: route.name,
            token: route.token,
            side: crossCheap ? 'cross_cheap' : 'direct_cheap',
            buyPrice: fillPrice,
            currentPrice: fillPrice,
            peakPrice: fillPrice,
            notionalUsd: spent,
            status: 'open',
            boughtAt: now,
            realBaseQty: order.executedQty,
            realQuoteUsd: spent,
            realOrderId: order.orderId,
          })
          trades.unshift({
            id: `bnt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'buy',
            routeId: route.id,
            routeName: route.name,
            token: route.token,
            priceUsd: fillPrice,
            notionalUsd: spent,
            pnlUsd: 0,
            profitBps: s.spreadBps,
            reason: `Divergence ${route.token}: ${s.directUsd.toFixed(6)} vs ${s.impliedUsd.toFixed(6)} (${s.spreadBps >= 0 ? '+' : ''}${s.spreadBps}bps) [real]`,
            status: 'filled',
            createdAt: now,
          })
          opps.unshift({
            id: `bnp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            routeId: route.id,
            name: route.name,
            side: crossCheap ? 'cross_cheap' : 'direct_cheap',
            buyPrice: fillPrice,
            sellPrice,
            spreadBps: s.spreadBps,
            notionalUsd: spent,
            profitUsd,
            detectedAt: now,
            executed: true,
          })
          cash -= spent
          buys++
          log(
            `LIVE BUY ${symbol} ${order.executedQty} @ ${fillPrice.toFixed(6)} — ${fmtUsdLocal(spent, 2)} USD (${s.spreadBps >= 0 ? '+' : ''}${s.spreadBps}bps)`,
            'trade'
          )
          realTrades++
          continue
        }

        holdings.unshift({
          id: `bnh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          routeId: route.id,
          routeName: route.name,
          token: route.token,
          side: crossCheap ? 'cross_cheap' : 'direct_cheap',
          buyPrice,
          currentPrice: buyPrice,
          peakPrice: buyPrice,
          notionalUsd: notional,
          status: 'open',
          boughtAt: now,
        })
        trades.unshift({
          id: `bnt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'buy',
          routeId: route.id,
          routeName: route.name,
          token: route.token,
          priceUsd: buyPrice,
          notionalUsd: notional,
          pnlUsd: 0,
          profitBps: s.spreadBps,
          reason: `Divergence ${route.token}: ${s.directUsd.toFixed(6)} vs ${s.impliedUsd.toFixed(6)} (${s.spreadBps >= 0 ? '+' : ''}${s.spreadBps}bps)`,
          status: 'filled',
          createdAt: now,
        })
        opps.unshift({
          id: `bnp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          routeId: route.id,
          name: route.name,
          side: crossCheap ? 'cross_cheap' : 'direct_cheap',
          buyPrice,
          sellPrice,
          spreadBps: s.spreadBps,
          notionalUsd: notional,
          profitUsd,
          detectedAt: now,
          executed: true,
        })
        cash -= notional
        buys++
        log(
          `${crossCheap ? 'IMPLIED' : 'DIRECT'} CHEAP — ${route.name}: buy ${buyPrice.toFixed(6)} → sell ${sellPrice.toFixed(6)} USD (${s.spreadBps >= 0 ? '+' : ''}${s.spreadBps}bps)`,
          'trade'
        )
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
      const realized = sold.reduce((a, h) => a + (h.pnlUsd ?? 0), 0)
      const wins = sold.filter((h) => (h.pnlUsd ?? 0) >= 0).length
      const total = sold.length
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

      if (buys === 0) {
        log(
          `Sin divergencias ≥ ${cfg.minSpreadBps}bps este ciclo — ${BINANCE_TRIANGLES.length} rutas rastreadas`,
          'info'
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
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log(`Cuenta reiniciada a ${cfg.capitalUsd.toFixed(2)} USD`, 'info')
  }, [log])

  const updateConfig = useCallback((patch: Partial<BinanceConfig>) => {
    setState((s) => {
      // Interest compounding is mandatory: the patch can never turn it off.
      const next = { ...s.config, ...patch, compound: true }
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