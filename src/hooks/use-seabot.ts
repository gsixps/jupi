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
// Capital is FICTIONAL (ETH). Market data = REAL OpenSea floors and sales via
// /api/opensea (needs OPENSEA_API_KEY on the server). Buys pay gas; sales pay
// the OpenSea fee, the creator fee and gas, and only fill on collections with
// real recent sales. The synthetic floor engine runs only in the explicit
// simulation data mode. No real on-chain trades are executed.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  SEABOT_COLLECTIONS,
  mockFloorPrice,
  mockTokenId,
  DEFAULT_SEABOT_CONFIG,
  ETH_USD_PRICE,
  MIN_DAILY_SALES_TO_SELL,
  OPENSEA_MARKET_FEE_PCT,
  fetchEthUsd,
  fetchOpenSeaCollections,
  nftGasUsd,
  type OpenSeaCollectionData,
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
  /** live ETH/USD (falls back to the static ETH_USD_PRICE until fetched) */
  ethUsd: number
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
      ethUsd: ETH_USD_PRICE,
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

      // 1. Floors — REAL OpenSea data (server proxy) or the explicit
      // simulation. With real data an unreachable API skips the tick.
      let ethUsd = stateRef.current.ethUsd
      let market: Record<string, OpenSeaCollectionData> | null = null
      if (cfg.dataMode === 'live') {
        try {
          const watched = s0.collections.filter((c) => c.watch).map((c) => c.slug)
          const [m, px] = await Promise.all([
            fetchOpenSeaCollections(watched),
            fetchEthUsd().catch(() => 0),
          ])
          market = m
          if (px > 0) ethUsd = px
        } catch (e) {
          log(`OpenSea no disponible (${(e as Error).message}) — ciclo omitido, sin precios simulados`, 'warn')
          setState((s) => ({ ...s, status: 'paused' }))
          return
        }
      }
      const collections = s0.collections.map((c) => {
        if (!market) {
          return { ...c, floorPrice: mockFloorPrice(c.slug, c.baseFloor, now), live: false }
        }
        const d = market[c.slug]
        const ethFloor = !!d && d.ok && /^W?ETH$/i.test(d.floorSymbol)
        const avg7d = d && d.sevenDaySales > 0 ? d.sevenDayVolume / d.sevenDaySales : 0
        return {
          ...c,
          floorPrice: ethFloor ? d.floorEth : 0,
          oneDayVolume: d?.oneDayVolume ?? 0,
          oneDaySales: d?.oneDaySales ?? 0,
          avg7dEth: avg7d,
          chain: d?.chain ?? 'ethereum',
          creatorFeePct: d?.creatorFeePct ?? 0,
          // buy only on a real dip below the 7-day average sale price
          maxBuyPrice: avg7d > 0 ? avg7d * (1 - cfg.dipPct / 100) : 0,
          live: ethFloor,
          dataError: !d ? 'sin datos' : !d.ok ? d.error ?? 'sin floor' : !ethFloor ? `floor en ${d.floorSymbol}` : undefined,
        }
      })
      const priceHistory: Record<string, number[]> = {}
      for (const c of collections) {
        if (!(c.floorPrice > 0)) continue
        const arr = [...(s0.priceHistory[c.slug] ?? []), c.floorPrice]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        priceHistory[c.slug] = arr
      }
      setState((s) => ({ ...s, collections, priceHistory, ethUsd }))
      const gasEth = (chain?: string) => (ethUsd > 0 ? nftGasUsd(chain ?? 'ethereum') / ethUsd : 0)

      let cash = stateRef.current.cashEth
      const holdings = stateRef.current.holdings.map((h) => ({ ...h }))
      const trades = [...stateRef.current.trades]

      /** Proceeds of selling at `floor`: marketplace + creator fees and gas. */
      const netSale = (col: (typeof collections)[number], floor: number) =>
        floor * (1 - (OPENSEA_MARKET_FEE_PCT + (col.creatorFeePct ?? 0)) / 100) - gasEth(col.chain)

      const sellHolding = (
        h: SeabotHolding,
        col: (typeof collections)[number],
        floor: number,
        reason: string,
        level: SeabotLogEntry['level'],
        detail: string
      ) => {
        const proceeds = netSale(col, floor)
        const pnl = proceeds - h.buyPriceEth
        h.status = 'sold'
        h.soldAt = now
        h.sellPriceEth = proceeds
        h.pnlEth = pnl
        cash += proceeds
        trades.unshift({
          id: `sbt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'sell',
          collectionSlug: h.collectionSlug,
          collectionName: h.collectionName,
          tokenId: h.tokenId,
          priceEth: proceeds,
          pnlEth: pnl,
          reason: `${reason} · neto tras comisiones y gas`,
          status: 'filled',
          createdAt: now,
        })
        const prefix =
          detail === 'stop-loss' ? 'STOP-LOSS' : detail === 'trailing-stop' ? 'TRAILING' : 'VENDIDO'
        log(
          `${prefix} ${h.collectionName} ${h.tokenId} @ floor ${floor.toFixed(4)} → neto ${proceeds.toFixed(4)} ETH (${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ETH)`,
          level
        )
        if (cfg.compound) {
          log(
            `⚡ Interés compuesto: capital disponible → ${fmtEthSeabot(cash)} ETH (P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)})`,
            'info'
          )
        }
      }

      // 2. SELL logic — targets are measured on what a sale would NET.
      for (const h of holdings) {
        if (h.status !== 'open') continue
        const col = collections.find((c) => c.slug === h.collectionSlug)
        if (!col || !(col.floorPrice > 0)) continue
        const curFloor = col.floorPrice
        const net = netSale(col, curFloor)
        h.currentPriceEth = net
        const target = h.buyPriceEth * (1 + col.targetProfitPct / 100)
        const stop = h.buyPriceEth * (1 - col.stopLossPct / 100)
        let exit: { reason: string; level: SeabotLogEntry['level']; detail: string } | null = null
        if (net >= target) {
          exit = { reason: `Take profit +${col.targetProfitPct}%`, level: 'trade', detail: 'take-profit' }
        } else if (net <= stop) {
          exit = { reason: `Stop loss -${col.stopLossPct}%`, level: 'warn', detail: 'stop-loss' }
        } else if (
          cfg.trailingStopPct > 0 &&
          h.peakPriceEth > 0 &&
          net <= h.peakPriceEth * (1 - cfg.trailingStopPct / 100)
        ) {
          exit = { reason: `Trailing stop -${cfg.trailingStopPct}%`, level: 'trade', detail: 'trailing-stop' }
        }
        if (!exit) {
          h.peakPriceEth = Math.max(h.peakPriceEth || h.buyPriceEth, net)
          continue
        }
        // A listing only fills if the collection is actually trading.
        if (col.live && (col.oneDaySales ?? 0) < MIN_DAILY_SALES_TO_SELL) {
          log(
            `⏳ ${h.collectionName} ${h.tokenId}: ${exit.reason}, pero solo ${col.oneDaySales ?? 0} ventas en 24 h — sin compradores, se mantiene`,
            'warn'
          )
          continue
        }
        sellHolding(h, col, curFloor, exit.reason, exit.level, exit.detail)
      }

      // 3. BUY logic — floor at a real dip below the 7-day average sale,
      // on collections that trade enough to exit later.
      const openCount = holdings.filter((h) => h.status === 'open').length
      const investedEth = holdings
        .filter((h) => h.status === 'open')
        .reduce((a, h) => a + h.currentPriceEth, 0)
      const totalCapitalUsd = (cash + investedEth) * (ethUsd || ETH_USD_PRICE)
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
        if (holdings.some((h) => h.status === 'open' && h.collectionSlug === c.slug)) continue
        if (c.live && (c.oneDaySales ?? 0) < MIN_DAILY_SALES_TO_SELL) continue

        const cost = c.floorPrice + gasEth(c.chain)
        const spend = Math.min(cfg.budgetPerTradeEth * compoundFactor, cash)
        if (spend < cost) continue
        if (!(c.maxBuyPrice > 0) || c.floorPrice > c.maxBuyPrice) continue

        const tokenId = mockTokenId(c.slug, now)
        holdings.unshift({
          id: `sbh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          collectionSlug: c.slug,
          collectionName: c.name,
          tokenId,
          buyPriceEth: cost,
          currentPriceEth: netSale(c, c.floorPrice),
          peakPriceEth: netSale(c, c.floorPrice),
          status: 'open',
          boughtAt: now,
        })
        trades.unshift({
          id: `sbt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'buy',
          collectionSlug: c.slug,
          collectionName: c.name,
          tokenId,
          priceEth: cost,
          pnlEth: 0,
          reason: `Floor ${c.floorPrice.toFixed(4)} ≤ ${c.maxBuyPrice.toFixed(4)} ETH (−${cfg.dipPct}% vs media 7 d) + gas`,
          status: 'filled',
          createdAt: now,
        })
        cash -= cost
        buys++
        log(
          `COMPRADO ${c.name} ${tokenId} @ ${c.floorPrice.toFixed(4)} ETH + gas${c.live ? '' : ' [simulación]'}`,
          'trade'
        )
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
      `SEABOT iniciado — ${stateRef.current.config.capitalEth.toFixed(2)} ETH ficticios, ${stateRef.current.config.dataMode === 'live' ? 'floors reales de OpenSea' : 'SIMULACIÓN (floors sintéticos)'}`,
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
      const next = { ...s.config, ...patch }
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