// SEABOT paper-trading hook — CLIENT-SIDE, port of the seabot methodology.
//
// One tick = one strategy cycle (mirrors the seabot engine):
//   1. Refresh floor prices for every watched collection.
//   2. For each open holding, SELL if current floor ≥ buy*(1+target) (take
//      profit), ≤ buy*(1-stopLoss) (stop loss), or ≤ peak*(1-trailing) (trailing
//      stop). Otherwise mark-to-market + track peak.
//   3. For each watched collection, BUY if floor ≤ maxBuyPrice and budget /
//      capacity / capital-tier allows.
//   4. Update portfolio stats + log everything.
//
// Capital is FICTIONAL (ETH). Market data = deterministic mock floor engine
// (the seabot project's demo data layer, without an OpenSea API key). No real
// on-chain trades are executed.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  SEABOT_COLLECTIONS,
  mockFloorPrice,
  mockTokenId,
  DEFAULT_SEABOT_CONFIG,
  ETH_USD_PRICE,
} from '@/lib/seabot'
import type {
  SeabotCollection,
  SeabotConfig,
  SeabotHolding,
  SeabotLogEntry,
  SeabotStats,
  SeabotTrade,
} from '@/lib/seabot'
import type { EquityPoint } from '@/lib/trading-types'

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const LOG_CAP = 120

export interface SeabotState {
  enabled: boolean
  config: SeabotConfig
  cashEth: number
  collections: SeabotCollection[]
  holdings: SeabotHolding[]
  trades: SeabotTrade[]
  stats: SeabotStats | null
  equityCurve: EquityPoint[]
  logs: SeabotLogEntry[]
  status: 'idle' | 'scanning' | 'executing' | 'paused'
  priceHistory: Record<string, number[]>
}

export function useSeabot() {
  const [state, setState] = useState<SeabotState>(() => {
    const now = Date.now()
    const collections: SeabotCollection[] = SEABOT_COLLECTIONS.map((s) => ({
      slug: s.slug,
      name: s.name,
      baseFloor: s.baseFloor,
      tier: s.tier,
      minCapitalUsd: s.minCapitalUsd,
      floorPrice: mockFloorPrice(s.slug, s.baseFloor, now),
      oneDayChange: 0,
      oneDayVolume: 0,
      watch: true,
      maxBuyPrice: Math.round(s.baseFloor * 1.0 * 1000) / 1000,
      targetProfitPct: DEFAULT_SEABOT_CONFIG.globalTargetPct,
      stopLossPct: DEFAULT_SEABOT_CONFIG.globalStopLossPct,
    }))
    const priceHistory: Record<string, number[]> = {}
    for (const c of collections) {
      const h: number[] = []
      for (let i = 20; i >= 0; i--) {
        h.push(mockFloorPrice(c.slug, c.baseFloor, now - i * 8000))
      }
      priceHistory[c.slug] = h
    }
    return {
      enabled: false,
      config: { ...DEFAULT_SEABOT_CONFIG },
      cashEth: DEFAULT_SEABOT_CONFIG.capitalEth,
      collections,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: [],
      status: 'idle',
      priceHistory,
    }
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)

  const log = useCallback((msg: string, level: SeabotLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[seabot] ${msg}`)
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

      // 1. Refresh floor prices
      const collections = s0.collections.map((c) => ({
        ...c,
        floorPrice: mockFloorPrice(c.slug, c.baseFloor, now),
      }))
      const priceHistory: Record<string, number[]> = {}
      for (const c of collections) {
        const arr = [...(s0.priceHistory[c.slug] ?? []), c.floorPrice]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        priceHistory[c.slug] = arr
      }
      setState((s) => ({ ...s, collections, priceHistory }))

      let cash = stateRef.current.cashEth
      const holdings = stateRef.current.holdings.map((h) => ({ ...h }))
      const trades = [...stateRef.current.trades]

      const sellHolding = (
        h: SeabotHolding,
        sellPrice: number,
        reason: string,
        level: SeabotLogEntry['level'],
        detail: string
      ) => {
        const pnl = sellPrice - h.buyPriceEth
        h.status = 'sold'
        h.soldAt = now
        h.sellPriceEth = sellPrice
        h.pnlEth = pnl
        cash += sellPrice
        trades.unshift({
          id: `sbt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'sell',
          collectionSlug: h.collectionSlug,
          collectionName: h.collectionName,
          tokenId: h.tokenId,
          priceEth: sellPrice,
          pnlEth: pnl,
          reason,
          status: 'filled',
          createdAt: now,
        })
        const prefix =
          detail === 'stop-loss' ? 'STOP-LOSS' : detail === 'trailing-stop' ? 'TRAILING' : 'VENDIDO'
        log(
          `${prefix} ${h.collectionName} ${h.tokenId} @ ${sellPrice.toFixed(4)} ETH (${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ETH)`,
          level
        )
        if (cfg.compound) {
          log(
            `⚡ Interés compuesto: capital disponible → ${fmtEthSeabot(cash)} ETH (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)})`,
            'info'
          )
        }
      }

      // 2. SELL logic — iterate open holdings
      for (const h of holdings) {
        if (h.status !== 'open') continue
        const col = collections.find((c) => c.slug === h.collectionSlug)
        if (!col) continue
        const curFloor = col.floorPrice
        const target = h.buyPriceEth * (1 + col.targetProfitPct / 100)
        const stop = h.buyPriceEth * (1 - col.stopLossPct / 100)

        if (curFloor >= target) {
          sellHolding(
            h,
            curFloor,
            `Take profit +${col.targetProfitPct}% (target ${target.toFixed(4)} ETH)`,
            'trade',
            'take-profit'
          )
        } else if (curFloor <= stop) {
          sellHolding(
            h,
            curFloor,
            `Stop loss -${col.stopLossPct}% (stop ${stop.toFixed(4)} ETH)`,
            'warn',
            'stop-loss'
          )
        } else if (
          cfg.trailingStopPct > 0 &&
          h.peakPriceEth > 0 &&
          curFloor <= h.peakPriceEth * (1 - cfg.trailingStopPct / 100)
        ) {
          sellHolding(
            h,
            curFloor,
            `Trailing stop -${cfg.trailingStopPct}% from peak ${h.peakPriceEth.toFixed(4)} ETH`,
            'trade',
            'trailing-stop'
          )
        } else {
          h.currentPriceEth = curFloor
          h.peakPriceEth = Math.max(h.peakPriceEth || h.buyPriceEth, curFloor)
        }
      }

      // 3. BUY logic
      const openCount = holdings.filter((h) => h.status === 'open').length
      const investedEth = holdings
        .filter((h) => h.status === 'open')
        .reduce((a, h) => a + h.currentPriceEth, 0)
      const totalCapitalUsd = (cash + investedEth) * ETH_USD_PRICE
      // Compound interest: scale per-trade budget with grown capital
      const compoundFactor = cfg.compound
        ? Math.max(cash + investedEth, 0.001) / Math.max(cfg.capitalEth, 0.001)
        : 1

      let buys = 0
      for (const c of collections) {
        if (!c.watch) continue
        if (openCount + buys >= cfg.maxHoldings) break
        if (c.floorPrice <= 0) continue
        if (totalCapitalUsd < c.minCapitalUsd) continue

        const spend = Math.min(cfg.budgetPerTradeEth * compoundFactor, cash)
        if (spend < c.floorPrice) continue
        if (c.floorPrice > c.maxBuyPrice) continue

        const tokenId = mockTokenId(c.slug, now)
        const buyPrice = c.floorPrice
        holdings.unshift({
          id: `sbh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          collectionSlug: c.slug,
          collectionName: c.name,
          tokenId,
          buyPriceEth: buyPrice,
          currentPriceEth: buyPrice,
          peakPriceEth: buyPrice,
          status: 'open',
          boughtAt: now,
        })
        trades.unshift({
          id: `sbt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'buy',
          collectionSlug: c.slug,
          collectionName: c.name,
          tokenId,
          priceEth: buyPrice,
          pnlEth: 0,
          reason: `Floor ${buyPrice.toFixed(4)} ≤ max ${c.maxBuyPrice.toFixed(4)} ETH`,
          status: 'filled',
          createdAt: now,
        })
        cash -= buyPrice
        buys++
        log(`COMPRADO ${c.name} ${tokenId} @ ${buyPrice.toFixed(4)} ETH`, 'trade')
      }

      // 4. Stats
      const open = holdings.filter((h) => h.status === 'open')
      const investedNow = open.reduce((a, h) => a + h.currentPriceEth, 0)
      const equity = cash + investedNow
      const sold = holdings.filter((h) => h.status === 'sold')
      const realized = sold.reduce((a, h) => a + (h.pnlEth ?? 0), 0)
      const wins = sold.filter((h) => (h.pnlEth ?? 0) >= 0).length
      const total = sold.length
      const prevStats = stateRef.current.stats
      const stats: SeabotStats = {
        running: s0.enabled,
        startedAt: s0.enabled ? (prevStats?.startedAt ?? now) : null,
        uptimeMs: s0.enabled ? now - (prevStats?.startedAt ?? now) : 0,
        capitalEth: cfg.capitalEth,
        cashEth: cash,
        investedEth: investedNow,
        equityEth: equity,
        realizedPnlEth: realized,
        totalTrades: total,
        wins,
        losses: total - wins,
        winRate: total > 0 ? (wins / total) * 100 : 0,
        openHoldings: open.length,
        scanCount: (prevStats?.scanCount ?? 0) + 1,
        lastScanAt: now,
        compound: cfg.compound,
        compoundFactor,
      }
      const unrealized = open.reduce((a, h) => a + (h.currentPriceEth - h.buyPriceEth), 0)
      const eqPoint: EquityPoint = {
        timestamp: now,
        equity,
        balance: cash,
        openPnl: unrealized,
      }

      setState((s) => ({
        ...s,
        cashEth: cash,
        holdings,
        trades: trades.slice(0, TRADE_CAP),
        stats,
        equityCurve: [...s.equityCurve, eqPoint].slice(-200),
        status: 'scanning',
      }))

      if (buys === 0 && sold.length === 0) {
        log(`Sin oportunidades de operación este ciclo — ${collections.length} colecciones escaneadas`, 'info')
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
      `SEABOT iniciado — ${stateRef.current.config.capitalEth.toFixed(2)} ETH ficticios, motor de floors mock`,
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
    log('Seabot detenido', 'info')
  }, [log])

  const resetAccount = useCallback(() => {
    const cfg = stateRef.current.config
    setState((s) => ({
      ...s,
      enabled: false,
      status: 'idle',
      cashEth: cfg.capitalEth,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: [],
    }))
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log(`Cuenta reiniciada a ${cfg.capitalEth} ETH`, 'info')
  }, [log])

  const updateConfig = useCallback((patch: Partial<SeabotConfig>) => {
    setState((s) => {
      // Interest compounding is mandatory: the patch can never turn it off.
      const next = { ...s.config, ...patch, compound: true }
      if (patch.capitalEth !== undefined && !s.enabled) {
        return { ...s, config: next, cashEth: patch.capitalEth }
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

function fmtEthSeabot(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
}