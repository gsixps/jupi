// COIN paper-trading hook — CLIENT-SIDE, single-asset cross-pair accumulation.
//
// One tick = one strategy cycle (same skeleton as seabot / curve / binance):
//   1. Refresh USD quotes for each trailing pair of the coin (REAL Binance, or
//      the deterministic mock as fallback for sandbox).
//   2. Sell open lots when the dearest quote hits take-profit / stop-loss /
//      trailing levels — that is "sell expensive".
//   3. Buy when the cheapest vs dearest quote spread ≥ minSpreadBps and the
//      cheap quote is ≤ our maxBuy reference — "buy cheap". The lot is the
//      stored coin itself (qty of BTC/ETH).
//   4. Update stats + log everything.
//
// Capital is FICTIONAL (USD). The "stored" balance is the open lots. No real
// orders are placed.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { COIN_ASSETS, BINANCE_API_BASE, mockCoinUsdPrice } from '@/lib/coin'
import type {
  CoinArbSignal,
  CoinAssetDef,
  CoinPriceRow,
} from '@/lib/coin'
import type { EquityPoint } from '@/lib/trading-types'

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const LOG_CAP = 120

export interface CoinHolding {
  id: string
  qty: number // amount of BTC/ETH stored
  buyPriceUsd: number // per-unit price paid (cheapest quote)
  buyPair: string
  currentPriceUsd: number // dearest quote while open
  peakPriceUsd: number
  status: 'open' | 'sold'
  boughtAt: number
  soldAt?: number
  sellPriceUsd?: number
  sellPair?: string
  pnlUsd?: number
}

export interface CoinTrade {
  id: string
  type: 'buy' | 'sell'
  symbol: string
  qty: number
  priceUsd: number
  pair: string
  notionalUsd: number
  pnlUsd: number
  profitBps: number
  reason: string
  status: 'open' | 'filled'
  createdAt: number
}

export interface CoinStats {
  running: boolean
  startedAt: number | null
  uptimeMs: number
  capitalUsd: number
  cashUsd: number
  storedQty: number // coins accumulated in open lots
  investedUsd: number
  equityUsd: number
  realizedPnlUsd: number
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  scanCount: number
  lastScanAt: number
  liveData: boolean
  bestStoredUsd: number // market value of the stored coins
  compound: boolean
  compoundFactor: number
}

export interface CoinLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

export interface CoinState {
  enabled: boolean
  capitalUsd: number
  budgetPerTradeUsd: number
  maxHoldings: number
  minSpreadBps: number
  targetPct: number
  stopLossPct: number
  trailingPct: number
  tickIntervalMs: number
  cashUsd: number
  compound: boolean
  /** Place real orders on Binance with real capital (requires API keys). */
  liveTrading: boolean
  rows: CoinPriceRow[]
  holdings: CoinHolding[]
  trades: CoinTrade[]
  stats: CoinStats | null
  equityCurve: EquityPoint[]
  logs: CoinLogEntry[]
  status: 'idle' | 'scanning' | 'executing' | 'paused'
  priceHistory: Record<string, number[]>
  signals: CoinArbSignal[]
  lastUpdatedAt: number | null
  dataSource: 'live' | 'mock'
}

function buildRows(
  asset: CoinAssetDef,
  now: number,
  live?: Record<string, number>
): CoinPriceRow[] {
  return asset.pairs.map((p) => {
    let priceUsd = p.anchorUsd
    if (live) {
      const v = live[p.symbol]
      if (v && v > 0) priceUsd = v
    } else {
      priceUsd = mockCoinUsdPrice(p.symbol, p.anchorUsd, now)
    }
    return { symbol: p.symbol, quote: p.quote, priceUsd, anchorUsd: p.anchorUsd }
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

export function useCoinBot(assetKey: 'btc' | 'eth') {
  const asset = COIN_ASSETS[assetKey]
  const symbol = asset.symbol

  const [state, setState] = useState<CoinState>(() => {
    const now = Date.now()
    const rows = buildRows(asset, now)
    const priceHistory: Record<string, number[]> = {}
    for (const r of rows) {
      const h: number[] = []
      for (let i = 20; i >= 0; i--) {
        h.push(mockCoinUsdPrice(r.symbol, r.anchorUsd, now - i * 10000))
      }
      priceHistory[r.symbol] = h
    }
    return {
      enabled: false,
      capitalUsd: asset.capitalUsd,
      budgetPerTradeUsd: asset.budgetPerTradeUsd,
      maxHoldings: asset.maxHoldings,
      minSpreadBps: asset.minSpreadBps,
      targetPct: asset.targetPct,
      stopLossPct: asset.stopLossPct,
      trailingPct: asset.trailingPct,
      tickIntervalMs: asset.tickIntervalMs,
      cashUsd: asset.capitalUsd,
      compound: true,
      liveTrading: false,
      rows,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: [],
      status: 'idle',
      priceHistory,
      signals: [],
      lastUpdatedAt: null,
      dataSource: 'mock',
    }
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)

  const log = useCallback((msg: string, level: CoinLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[${symbol}] ${msg}`)
  }, [symbol])

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

      // 1. Refresh quotes
      let rows: CoinPriceRow[]
      let liveData = false
      let liveErr: unknown = null
      try {
        const live = await fetchBinancePrices()
        rows = buildRows(asset, now, live)
        liveData = true
      } catch (e) {
        liveErr = e
        rows = buildRows(asset, now)
      }

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

      if (liveErr) log(`${symbol} API no disponible — usando motor demo determinista`, 'warn')

      // 2. Compute prices
      let cheapest = rows[0]
      let dearest = rows[0]
      for (const r of rows) {
        if (r.priceUsd < cheapest.priceUsd) cheapest = r
        if (r.priceUsd > dearest.priceUsd) dearest = r
      }
      const spreadBps = Math.round(
        ((dearest.priceUsd - cheapest.priceUsd) / cheapest.priceUsd) * 10000
      )

      // 3. SELL open lots ("sell expensive")
      let cash = stateRef.current.cashUsd
      const holdings = stateRef.current.holdings.map((h) => ({ ...h }))
      const trades = [...stateRef.current.trades]
      const signals: CoinArbSignal[] = []

      for (const h of holdings) {
        if (h.status !== 'open') continue
        h.currentPriceUsd = dearest.priceUsd
        const target = h.buyPriceUsd * (1 + s0.targetPct / 100)
        const stop = h.buyPriceUsd * (1 - s0.stopLossPct / 100)

        let reason: string | null = null
        if (dearest.priceUsd >= target) {
          reason = `Take profit +${s0.targetPct}%`
        } else if (dearest.priceUsd <= stop) {
          reason = `Stop loss -${s0.stopLossPct}%`
        } else if (
          s0.trailingPct > 0 &&
          dearest.priceUsd <= h.peakPriceUsd * (1 - s0.trailingPct / 100)
        ) {
          reason = `Trailing stop -${s0.trailingPct}% from peak`
        }

        if (reason) {
          const sellPrice = dearest.priceUsd
          const pnl = (sellPrice - h.buyPriceUsd) * h.qty
          const pnlBps = Math.round(((sellPrice - h.buyPriceUsd) / h.buyPriceUsd) * 10000)
          h.status = 'sold'
          h.soldAt = now
          h.sellPriceUsd = sellPrice
          h.sellPair = dearest.symbol
          h.pnlUsd = pnl
          cash += sellPrice * h.qty
          trades.unshift({
            id: `cot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'sell',
            symbol,
            qty: h.qty,
            priceUsd: sellPrice,
            pair: dearest.symbol,
            notionalUsd: sellPrice * h.qty,
            pnlUsd: pnl,
            profitBps: pnlBps,
            reason,
            status: 'filled',
            createdAt: now,
          })
log(
            `VENDIDO ${h.qty.toFixed(6)} ${symbol} @ ${sellPrice.toFixed(2)} USD en ${dearest.symbol} (${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USD)`,
            'trade'
          )
          if (s0.compound) {
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdCoin(cash, 2)} USD (P&L ${pnl >= 0 ? '+' : ''}${fmtUsdCoin(pnl, 2)})`,
              'info'
            )
          }
        } else {
          h.peakPriceUsd = Math.max(h.peakPriceUsd, dearest.priceUsd)
        }
      }

      // 4. BUY cheap — accumulate the coin
      const openCount = holdings.filter((h) => h.status === 'open').length
      const investedBeforeCoin = holdings
        .filter((h) => h.status === 'open')
        .reduce((a, h) => a + h.buyPriceUsd * h.qty, 0)
      const equityBeforeCoin = cash + investedBeforeCoin
      // Compound interest: scale per-trade budget with grown capital
      const compoundFactor = s0.compound ? Math.max(equityBeforeCoin, 1) / Math.max(s0.capitalUsd, 1) : 1
      let buys = 0
      if (spreadBps >= s0.minSpreadBps && openCount < s0.maxHoldings) {
        const maxBuyRef = dearest.priceUsd // buy as close to the cheapest as allowed
        const afford = Math.min(s0.budgetPerTradeUsd * compoundFactor, cash)
        if (afford >= 0.01 && cheapest.priceUsd <= maxBuyRef) {
          const qty = afford / cheapest.priceUsd
          holdings.unshift({
            id: `coh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            qty,
            buyPriceUsd: cheapest.priceUsd,
            buyPair: cheapest.symbol,
            currentPriceUsd: cheapest.priceUsd,
            peakPriceUsd: cheapest.priceUsd,
            status: 'open',
            boughtAt: now,
          })
          trades.unshift({
            id: `cot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'buy',
            symbol,
            qty,
            priceUsd: cheapest.priceUsd,
            pair: cheapest.symbol,
            notionalUsd: afford,
            pnlUsd: 0,
            profitBps: spreadBps,
            reason: `Comprando barato en ${cheapest.symbol} @ ${cheapest.priceUsd.toFixed(2)} (spread ${spreadBps}bps)`,
            status: 'filled',
            createdAt: now,
          })
          signals.unshift({
            id: `cos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            cheapestSymbol: cheapest.symbol,
            dearestSymbol: dearest.symbol,
            cheapestUsd: cheapest.priceUsd,
            dearestUsd: dearest.priceUsd,
            spreadBps,
            detectedAt: now,
          })
          cash -= afford
          buys++
          log(
            `ALMACENANDO ${qty.toFixed(5)} ${symbol} desde ${cheapest.symbol} @ ${cheapest.priceUsd.toFixed(2)} USD (spread ${spreadBps}bps contra ${dearest.symbol})`,
            'trade'
          )
        }
      }

      // 5. Stats
      const open = holdings.filter((h) => h.status === 'open')
      const storedQty = open.reduce((a, h) => a + h.qty, 0)
      const invested = open.reduce((a, h) => a + h.buyPriceUsd * h.qty, 0)
      const storedUsd = open.reduce((a, h) => a + h.currentPriceUsd * h.qty, 0)
      const equity = cash + storedUsd
      const sold = holdings.filter((h) => h.status === 'sold')
      const realized = sold.reduce((a, h) => a + (h.pnlUsd ?? 0), 0)
      const wins = sold.filter((h) => (h.pnlUsd ?? 0) >= 0).length
      const total = sold.length
      const prevStats = stateRef.current.stats
      const stats: CoinStats = {
        running: s0.enabled,
        startedAt: s0.enabled ? (prevStats?.startedAt ?? now) : null,
        uptimeMs: s0.enabled ? now - (prevStats?.startedAt ?? now) : 0,
        capitalUsd: s0.capitalUsd,
        cashUsd: cash,
        storedQty,
        investedUsd: invested,
        equityUsd: equity,
        realizedPnlUsd: realized,
        totalTrades: total,
        wins,
        losses: total - wins,
        winRate: total > 0 ? (wins / total) * 100 : 0,
        scanCount: (prevStats?.scanCount ?? 0) + 1,
        lastScanAt: now,
        liveData: stateRef.current.dataSource === 'live',
        bestStoredUsd: storedUsd,
        compound: s0.compound,
        compoundFactor,
      }
      const unrealized = storedUsd - invested
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
        signals: [...signals, ...s.signals].slice(0, TRADE_CAP),
        stats,
        equityCurve: [...s.equityCurve, eqPoint].slice(-200),
        status: 'scanning',
        dataSource: liveData ? 'live' : 'mock',
      }))

      if (buys === 0) {
        log(
          `Sin spread ≥ ${s0.minSpreadBps}bps este ciclo — ${rows.length} pares rastreados (${symbol})`,
          'info'
        )
      }
    } finally {
      inFlightRef.current = false
    }
  }, [log, symbol, asset])

  const start = useCallback(() => {
    setState((s) => ({
      ...s,
      enabled: true,
      status: 'scanning',
      stats: s.stats ? { ...s.stats, running: true } : s.stats,
    }))
    log(
      `BOT ${symbol.toUpperCase()} iniciado — ${stateRef.current.capitalUsd.toFixed(2)} USD ficticios, cross-pair accumulation`,
      'trade'
    )
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => {
      scan().catch((e) => log(`Scan error: ${e.message}`, 'error'))
    }, stateRef.current.tickIntervalMs)
  }, [scan, log, symbol])

  const stop = useCallback(() => {
    setState((s) => ({ ...s, enabled: false, status: 'idle' }))
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log(`Bot ${symbol} detenido`, 'info')
  }, [log, symbol])

  const resetAccount = useCallback(() => {
    const s0 = stateRef.current
    setState((s) => ({
      ...s,
      enabled: false,
      status: 'idle',
      cashUsd: s0.capitalUsd,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: [],
      signals: [],
    }))
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log(`Cuenta reiniciada a ${s0.capitalUsd.toFixed(2)} USD`, 'info')
  }, [log])

  const updateConfig = useCallback((patch: Partial<CoinState>) => {
    setState((s) => {
      if (patch.capitalUsd !== undefined && !s.enabled) {
        return { ...s, capitalUsd: patch.capitalUsd, cashUsd: patch.capitalUsd }
      }
      const allowed: (keyof CoinState)[] = [
        'budgetPerTradeUsd',
        'maxHoldings',
        'minSpreadBps',
        'targetPct',
        'stopLossPct',
        'trailingPct',
        'tickIntervalMs',
        'compound',
      ]
      const next: Partial<CoinState> = {}
      for (const k of allowed) {
        if ((patch as Record<string, unknown>)[k] !== undefined) {
          ;(next as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k]
        }
      }
      return { ...s, ...next }
    })
  }, [])

  useEffect(() => {
    return () => {
      if (loopRef.current) clearInterval(loopRef.current)
    }
  }, [])

  return {
    ...state,
    asset: Object.freeze({ ...asset }),
    scanCount: state.stats?.scanCount ?? 0,
    start,
    stop,
    scan: () => scan(),
    updateConfig,
    resetAccount,
    log,
  }
}

function fmtUsdCoin(n: number, d = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

export type CoinBot = ReturnType<typeof useCoinBot>