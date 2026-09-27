// CURVE FINANCE paper-trading hook — CLIENT-SIDE, stablecoin arbitrage.
//
// One tick = one strategy cycle (same skeleton as seabot):
//   1. Refresh USD quotes for every watched Curve pool coin (LIVE Curve API,
//      with the deterministic mock engine as fallback for sandbox).
//   2. SELL each open holding when a pool quotes the coin dearer than
//      buy*(1+target) (take profit), ≤ buy*(1-stopLoss) (stop loss), or
//      ≤ peak*(1-trailing) (trailing stop).
//   3. BUY a coin when the spread between its cheapest and dearest pool quote
//      is ≥ minProfitBps: buy at the cheap pool, target the dearest pool.
//   4. Update stats + log everything.
//
// Capital is FICTIONAL (USD). No real on-chain trades are executed.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  CURVE_STABLE_POOLS,
  CURVE_API_BASE,
  mockStableUsdPrice,
  arbCoinSymbol,
} from '@/lib/curve'
import type {
  CurveArbOpportunity,
  CurvePool,
  CurvePoolRow,
} from '@/lib/curve'
import type { EquityPoint } from '@/lib/trading-types'

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const LOG_CAP = 120

export interface CurveConfig {
  capitalUsd: number
  budgetPerTradeUsd: number
  maxHoldings: number
  globalTargetBps: number // take-profit in basis points (spread >= this)
  stopLossBps: number
  trailingBps: number
  tickIntervalMs: number
  dataMode: 'live' | 'mock' // 'live'=real Curve API, 'mock'=deterministic demo
  compound: boolean // reinvest profits → per-trade budget scales with equity
  /** Trade on-chain with a connected EVM wallet and real capital. */
  liveTrading: boolean
}

export const DEFAULT_CURVE_CONFIG: CurveConfig = {
  capitalUsd: 10000,
  budgetPerTradeUsd: 2500,
  maxHoldings: 8,
  globalTargetBps: 25,
  stopLossBps: 8,
  trailingBps: 4,
  tickIntervalMs: 10000,
  dataMode: 'live',
  compound: true,
  liveTrading: false,
}

export interface CurveHolding {
  id: string
  coinSymbol: string // traded coin (underscore real coin)
  buyPool: string
  buyPrice: number // usd price paid (cheap pool)
  currentPrice: number // best sell quote right now (dearest pool)
  peakPrice: number
  status: 'open' | 'sold'
  boughtAt: number
  soldAt?: number
  sellPrice?: number
  pnlUsd?: number
}

export interface CurveTrade {
  id: string
  type: 'buy' | 'sell' | 'arb'
  coinSymbol: string
  buyPool: string
  sellPool: string
  priceUsd: number
  inputUsd: number
  outUsd: number
  pnlUsd: number
  profitBps: number
  reason: string
  status: 'open' | 'filled'
  createdAt: number
}

export interface CurveStats {
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

export interface CurveLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

export interface CurveState {
  enabled: boolean
  config: CurveConfig
  cashUsd: number
  pools: CurvePoolRow[]
  holdings: CurveHolding[]
  trades: CurveTrade[]
  stats: CurveStats | null
  equityCurve: EquityPoint[]
  logs: CurveLogEntry[]
  status: 'idle' | 'scanning' | 'executing' | 'paused'
  priceHistory: Record<string, number[]>
  opps: CurveArbOpportunity[]
  lastUpdatedAt: number | null
  dataSource: 'live' | 'mock'
}

/** Build runtime pool rows (fill live/mock usdPrice per coin). */
function buildPools(
  base: CurvePool[],
  now: number,
  mode: CurveConfig['dataMode'],
  live?: CurvePool[]
): CurvePoolRow[] {
  const pricesByPool: Record<string, CurvePool> = {}
  if (live) {
    for (const p of live) pricesByPool[p.address.toLowerCase()] = p
  }
  return base.map((b) => {
    const livePool = pricesByPool[b.address.toLowerCase()]
    const coins = b.coins.map((c) => {
      let usdPrice = c.usdPrice
      if (livePool) {
        const lc = livePool.coins.find(
          (x) => x.address.toLowerCase() === c.address.toLowerCase()
        )
        if (lc) usdPrice = lc.usdPrice
      } else if (mode === 'mock') {
        usdPrice = mockStableUsdPrice(b.address, c.symbol, now)
      }
      return { ...c, usdPrice }
    })
    const spread = coins
      .map((c) => Math.abs(c.usdPrice - 1))
      .reduce((a, x) => Math.max(a, x), 0)
    return {
      ...b,
      coins,
      quote: Math.round((1 + spread) * 1e8) / 1e8,
      deviationBps: Math.round(spread * 10000),
    }
  })
}

async function fetchCurvePools(): Promise<CurvePool[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(CURVE_API_BASE, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`curve api ${res.status}`)
    const j = await res.json()
    const data = (j.data || {}) as { poolData?: CurvePool[] }
    const pd = data.poolData || []
    return pd.filter((p) => p.isBroken !== true && !p.name.includes('yDAI') === p.coins.length > 0)
  } catch (e) {
    throw e
  } finally {
    clearTimeout(t)
  }
}

/** Collect all distinct coins across pools for a given tick scan. */
function collectCoins(pools: CurvePoolRow[]): {
  symbol: string
  quotes: { pool: string; price: number }[]
}[] {
  const map = new Map<
    string,
    { symbol: string; quotes: { pool: string; price: number }[] }
  >()
  for (const p of pools) {
    for (const c of p.coins) {
      const sym = arbCoinSymbol(c.symbol)
      if (!sym || sym.length > 10) continue
      if (!map.has(sym)) map.set(sym, { symbol: sym, quotes: [] })
      map.get(sym)!.quotes.push({ pool: p.name, price: c.usdPrice })
    }
  }
  return [...map.values()]
}

export function useCurveBot() {
  const [state, setState] = useState<CurveState>(() => {
    const now = Date.now()
    const pools = buildPools(CURVE_STABLE_POOLS, now, 'mock')
    const priceHistory: Record<string, number[]> = {}
    for (const p of pools) {
      const h: number[] = []
      for (let i = 20; i >= 0; i--) {
        h.push(mockStableUsdPrice(p.address, `${p.id}`, now - i * 10000))
      }
      priceHistory[p.address] = h
    }
    return {
      enabled: false,
      config: { ...DEFAULT_CURVE_CONFIG },
      cashUsd: DEFAULT_CURVE_CONFIG.capitalUsd,
      pools,
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
    }
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)

  const log = useCallback((msg: string, level: CurveLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[curve] ${msg}`)
  }, [])

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

      // 1. Refresh quotes — live Curve API or mock engine
      let pools: CurvePoolRow[]
      let liveData = false
      let liveErr: unknown = null
      if (cfg.dataMode === 'live') {
        try {
          const live = await fetchCurvePools()
          const filtered = live.filter((p) =>
            CURVE_STABLE_POOLS.some(
              (x) => x.address.toLowerCase() === p.address.toLowerCase()
            )
          )
          if (filtered.length > 0) {
            pools = buildPools(CURVE_STABLE_POOLS, now, 'live', filtered)
            liveData = true
          } else {
            pools = buildPools(CURVE_STABLE_POOLS, now, 'mock')
          }
        } catch (e) {
          liveErr = e
          pools = buildPools(CURVE_STABLE_POOLS, now, 'mock')
        }
      } else {
        pools = buildPools(CURVE_STABLE_POOLS, now, 'mock')
      }

      const priceHistory: Record<string, number[]> = {}
      for (const p of pools) {
        const latest =
          p.coins.length > 0
            ? p.coins.reduce((a, c) => a + c.usdPrice, 0) / p.coins.length
            : 1
        const arr = [...(s0.priceHistory[p.address] ?? []), latest]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        priceHistory[p.address] = arr
      }
      setState((s) => ({
        ...s,
        pools,
        priceHistory,
        dataSource: pools.length > 0 && liveData ? 'live' : 'mock',
        lastUpdatedAt: now,
      }))

      if (liveErr && liveData === false) {
        log(`Curve API no disponible — usando motor demo determinista`, 'warn')
      }

      // 2. SELL logic — scan open holdings
      const coinMap = new Map<string, string>()
      for (const p of pools)
        for (const c of p.coins) coinMap.set(arbCoinSymbol(c.symbol), c.symbol)

      // 3. Scan arbitrage opportunities
      const coins = collectCoins(pools)
      let cash = stateRef.current.cashUsd
      const holdings = stateRef.current.holdings.map((h) => ({ ...h }))
      const trades = [...stateRef.current.trades]
      const opps: CurveArbOpportunity[] = []

      // SYNC SELL phase
      for (const h of holdings) {
        if (h.status !== 'open') continue
        const quotes = coins.find((c) => c.symbol === h.coinSymbol)?.quotes ?? []
        if (quotes.length === 0) continue
        const bestSell = quotes.reduce((a, q) => (q.price > a.price ? q : a))
        h.currentPrice = bestSell.price
        const target = h.buyPrice * (1 + cfg.globalTargetBps / 10000)
        const stop = h.buyPrice * (1 - cfg.stopLossBps / 10000)

        let reason: string | null = null
        if (bestSell.price >= target) {
          reason = `Take profit ${cfg.globalTargetBps}bps`
        } else if (bestSell.price <= stop) {
          reason = `Stop loss -${cfg.stopLossBps}bps`
        } else if (
          cfg.trailingBps > 0 &&
          bestSell.price <= h.peakPrice * (1 - cfg.trailingBps / 10000)
        ) {
          reason = `Trailing stop -${cfg.trailingBps}bps from peak`
        }

        if (reason) {
          const sellPrice = bestSell.price
          const inputUsd = h.buyPrice
          const outUsd = sellPrice
          const pnl = outUsd - inputUsd
          const pnlBps = Math.round((pnl / inputUsd) * 10000)
          h.status = 'sold'
          h.soldAt = now
          h.sellPrice = sellPrice
          h.pnlUsd = pnl
          cash += outUsd
          trades.unshift({
            id: `cvt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'sell',
            coinSymbol: h.coinSymbol,
            buyPool: h.buyPool,
            sellPool: bestSell.pool,
            priceUsd: sellPrice,
            inputUsd,
            outUsd,
            pnlUsd: pnl,
            profitBps: pnlBps,
            reason,
            status: 'filled',
            createdAt: now,
          })
          opps.unshift({
            id: `cvp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            coinSymbol: h.coinSymbol,
            buyPool: h.buyPool,
            sellPool: bestSell.pool,
            buyPrice: h.buyPrice,
            sellPrice,
            profitBps: pnlBps,
            inputUsd,
            outUsd,
            detectedAt: now,
            executed: true,
          })
          log(
            `VENDIDO ${h.coinSymbol} ${bestSell.price.toFixed(6)} USD (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD, ${pnlBps >= 0 ? '+' : ''}${pnlBps}bps)`,
            'trade'
          )
          if (cfg.compound) {
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdCurve(cash, 2)} USD (P&L ${pnl >= 0 ? '+' : ''}${fmtUsdCurve(pnl, 2)})`,
              'info'
            )
          }
        } else {
          h.peakPrice = Math.max(h.peakPrice, bestSell.price)
        }
      }

      // 4. BUY logic — find spread ≥ target and open positions
      const openCountBefore = holdings.filter((h) => h.status === 'open').length
      const investedBefore = holdings
        .filter((h) => h.status === 'open')
        .reduce((a, h) => a + h.buyPrice, 0)
      const equityBefore = cash + investedBefore
      // Compound interest: scale per-trade budget with grown capital
      const compoundFactor = cfg.compound ? Math.max(equityBefore, 1) / Math.max(cfg.capitalUsd, 1) : 1
      let buys = 0
      for (const coin of coins) {
        if (coin.quotes.length < 2) continue
        if (openCountBefore + buys >= cfg.maxHoldings) break
        const quotes = coin.quotes
        const cheapest = quotes.reduce((a, q) => (q.price < a.price ? q : a))
        const dearest = quotes.reduce((a, q) => (q.price > a.price ? q : a))
        const spreadBps = Math.round(((dearest.price - cheapest.price) / cheapest.price) * 10000)
        if (spreadBps < cfg.globalTargetBps) continue
        if (dearest.price < 1) continue // sell leg below $1: no profit vs holding USD

        const alreadyOpen = holdings.some(
          (h) => h.status === 'open' && h.coinSymbol === coin.symbol
        )
        if (alreadyOpen) continue

        const spend = Math.min(cfg.budgetPerTradeUsd * compoundFactor, cash)
        if (spend < 0.01) continue

        holdings.unshift({
          id: `cvh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          coinSymbol: coin.symbol,
          buyPool: cheapest.pool,
          buyPrice: cheapest.price,
          currentPrice: cheapest.price,
          peakPrice: cheapest.price,
          status: 'open',
          boughtAt: now,
        })
        trades.unshift({
          id: `cvt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'buy',
          coinSymbol: coin.symbol,
          buyPool: cheapest.pool,
          sellPool: dearest.pool,
          priceUsd: cheapest.price,
          inputUsd: spend,
          outUsd: (spend / cheapest.price) * dearest.price,
          pnlUsd: 0,
          profitBps: spreadBps,
          reason: `Spread ${coin.symbol}: ${cheapest.price.toFixed(6)} → ${dearest.price.toFixed(6)} (+${spreadBps}bps)`,
          status: 'filled',
          createdAt: now,
        })
        opps.unshift({
          id: `cvp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          coinSymbol: coin.symbol,
          buyPool: cheapest.pool,
          sellPool: dearest.pool,
          buyPrice: cheapest.price,
          sellPrice: dearest.price,
          profitBps: spreadBps,
          inputUsd: spend,
          outUsd: (spend / cheapest.price) * dearest.price,
          detectedAt: now,
          executed: true,
        })
        cash -= spend
        buys++
        log(
          `ARBITRAJE ${coin.symbol}: compra ${cheapest.pool} @ ${cheapest.price.toFixed(6)} → venta ${dearest.pool} @ ${dearest.price.toFixed(6)} (+${spreadBps}bps)`,
          'trade'
        )
      }

      // 5. Stats
      const open = holdings.filter((h) => h.status === 'open')
      const invested = open.reduce((a, h) => a + h.buyPrice, 0)
      const equity = cash + invested
      const sold = holdings.filter((h) => h.status === 'sold')
      const realized = sold.reduce((a, h) => a + (h.pnlUsd ?? 0), 0)
      const wins = sold.filter((h) => (h.pnlUsd ?? 0) >= 0).length
      const total = sold.length
      const prevStats = stateRef.current.stats
      const stats: CurveStats = {
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
      const unrealized = open.reduce((a, h) => a + (h.currentPrice ?? h.buyPrice) - h.buyPrice, 0)
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
          `Sin spreads ≥ ${cfg.globalTargetBps}bps este ciclo — ${coins.length} stablecoins rastreadas`,
          'info'
        )
      }
    } finally {
      inFlightRef.current = false
    }
  }, [log])

  const start = useCallback(() => {
    setState((s) => ({
      ...s,
      enabled: true,
      status: 'scanning',
      stats: s.stats ? { ...s.stats, running: true } : s.stats,
    }))
    log(
      `CURVE BOT iniciado — ${stateRef.current.config.capitalUsd.toFixed(2)} USD ficticios, arbitraje de stablecoins`,
      'trade'
    )
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => {
      scan().catch((e) => log(`Scan error: ${e.message}`, 'error'))
    }, stateRef.current.config.tickIntervalMs)
  }, [scan, log])

  const stop = useCallback(() => {
    setState((s) => ({ ...s, enabled: false, status: 'idle' }))
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log('Curve bot detenido', 'info')
  }, [log])

  const resetAccount = useCallback(() => {
    const cfg = stateRef.current.config
    setState((s) => ({
      ...s,
      enabled: false,
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

  const updateConfig = useCallback((patch: Partial<CurveConfig>) => {
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
  }
}

function fmtUsdCurve(n: number, d = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}