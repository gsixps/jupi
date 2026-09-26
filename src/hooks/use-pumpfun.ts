// PUMPFUN paper-trading hook — CLIENT-SIDE, meme-coin buy-cheap/sell-expensive.
//
// One tick = one strategy cycle (same skeleton as seabot / curve / coin):
//   1. Refresh USD prices for every watched pump.fun meme coin (LIVE pump.fun
//      API, or the deterministic mock engine as fallback for sandbox).
//   2. Score each coin as an OPPORTUNITY (cheapness vs reference + momentum +
//      new-listing bonus + liquidity penalty) and record the best.
//   3. SELL open lots at take-profit / stop-loss / trailing-stop.
//   4. BUY coins that are cheap & scored above the threshold — "buy cheap".
//   5. Update stats + log everything.
//
// Capital is FICTIONAL (USD). No real on-chain trades are executed.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  PUMP_COIN_SEEDS,
  PUMPFUN_API_BASE,
  mockPumpUsdPrice,
  mockPumpRefUsd,
  scorePumpOpportunity,
  pumpVerdict,
  pumpOpportunityKind,
} from '@/lib/pumpfun'
import type {
  PumpCoinRow,
  PumpCoinSeed,
  PumpOpportunity,
} from '@/lib/pumpfun'
import type { EquityPoint } from '@/lib/trading-types'

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const LOG_CAP = 120

export interface PumpFunConfig {
  capitalUsd: number
  budgetPerTradeUsd: number
  maxHoldings: number
  minScore: number // opportunity score required to buy a coin
  targetPct: number // take-profit % above buy price
  stopLossPct: number
  trailingPct: number
  tickIntervalMs: number
  dataMode: 'live' | 'mock' // 'live'=real pump.fun API, 'mock'=deterministic demo
}

export const DEFAULT_PUMPFUN_CONFIG: PumpFunConfig = {
  capitalUsd: 10000,
  budgetPerTradeUsd: 500,
  maxHoldings: 12,
  minScore: 50,
  targetPct: 12,
  stopLossPct: 6,
  trailingPct: 3,
  tickIntervalMs: 10000,
  dataMode: 'live',
}

export interface PumpHolding {
  id: string
  coinId: string
  symbol: string
  name: string
  emoji: string
  qty: number // token units stored
  buyPriceUsd: number
  currentPriceUsd: number
  peakPriceUsd: number
  buyPair: string // 'pump.fun'
  status: 'open' | 'sold'
  boughtAt: number
  soldAt?: number
  sellPriceUsd?: number
  pnlUsd?: number
}

export interface PumpTrade {
  id: string
  type: 'buy' | 'sell'
  symbol: string
  name: string
  emoji: string
  qty: number
  priceUsd: number
  inputUsd: number
  outUsd: number
  pnlUsd: number
  profitBps: number
  reason: string
  status: 'open' | 'filled'
  createdAt: number
}

export interface PumpFunStats {
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
  newDetections: number // opportunities flagged as new listings
  scanCount: number
  lastScanAt: number
  liveData: boolean
  bestMcapUsd: number // market cap of the top-score opportunity this scan
}

export interface PumpFunLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

export interface PumpFunState {
  enabled: boolean
  config: PumpFunConfig
  cashUsd: number
  coins: PumpCoinRow[]
  holdings: PumpHolding[]
  trades: PumpTrade[]
  stats: PumpFunStats | null
  equityCurve: EquityPoint[]
  logs: PumpFunLogEntry[]
  status: 'idle' | 'scanning' | 'executing' | 'paused'
  priceHistory: Record<string, number[]>
  opps: PumpOpportunity[]
  lastUpdatedAt: number | null
  dataSource: 'live' | 'mock'
}

/** Build coin rows for the watched universe. */
function buildCoins(
  seeds: PumpCoinSeed[],
  now: number,
  mode: PumpFunConfig['dataMode'],
  live?: Record<string, { priceUsd: number; mcapUsd: number }>
): PumpCoinRow[] {
  return seeds.map((s) => {
    let priceUsd: number
    let mcapUsd: number
    let refUsd = mockPumpRefUsd(s.id, s.baseUsd, now)
    if (live && live[s.id]) {
      const lv = live[s.id]
      if (lv.priceUsd > 0) {
        priceUsd = lv.priceUsd
        mcapUsd = lv.mcapUsd > 0 ? lv.mcapUsd : s.baseMcapUsd
        refUsd = s.baseMcapUsd > 0 ? (mcapUsd / s.baseMcapUsd) * s.baseUsd : s.baseUsd
      } else {
        priceUsd = mockPumpUsdPrice(s.id, s.baseUsd, now, { isNew: s.isNew })
        mcapUsd = s.baseMcapUsd
      }
    } else if (mode === 'mock') {
      priceUsd = mockPumpUsdPrice(s.id, s.baseUsd, now, { isNew: s.isNew })
      mcapUsd = (priceUsd / s.baseUsd) * s.baseMcapUsd
    } else {
      priceUsd = mockPumpUsdPrice(s.id, s.baseUsd, now, { isNew: s.isNew })
      mcapUsd = (priceUsd / s.baseUsd) * s.baseMcapUsd
    }
    return {
      id: s.id,
      symbol: s.symbol,
      name: s.name,
      emoji: s.emoji,
      priceUsd,
      refUsd,
      mcapUsd,
      ageMs: s.createdAgoMs + (now % 3600000),
      liquidityUsd: s.liquidityUsd,
      volumeUsd: s.volumeUsd,
      isNew: s.isNew,
      momentumPct: 0,
      score: 0,
      verdict: 'neutral' as PumpCoinRow['verdict'],
    }
  })
}

async function fetchPumpCoins(): Promise<Record<string, { priceUsd: number; mcapUsd: number }>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(PUMPFUN_API_BASE, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`pump.fun api ${res.status}`)
    const j = await res.json()
    const arr = (Array.isArray(j) ? j : ((j as { coins?: unknown[] }).coins ?? [])) as {
      symbol?: string
      name?: string
      price?: number
      usd_price?: number
      usd_market_cap?: number
      market_cap_usd?: number
    }[]
    const out: Record<string, { priceUsd: number; mcapUsd: number }> = {}
    for (const c of arr) {
      if (!c.symbol) continue
      const ext = c.usd_market_cap ?? c.market_cap_usd
      const key = PUMP_COIN_SEEDS.find(
        (s) => s.symbol.toLowerCase() === c.symbol!.toLowerCase()
      )?.id
      if (!key) continue
      out[key] = {
        priceUsd: c.usd_price ?? c.price ?? NaN,
        mcapUsd: ext ?? NaN,
      }
    }
    return out
  } catch (e) {
    throw e
  } finally {
    clearTimeout(t)
  }
}

export function usePumpFunBot() {
  const [state, setState] = useState<PumpFunState>(() => {
    const now = Date.now()
    const coins = buildCoins(PUMP_COIN_SEEDS, now, 'mock')
    const priceHistory: Record<string, number[]> = {}
    for (const c of coins) {
      const h: number[] = []
      for (let i = 20; i >= 0; i--) {
        h.push(mockPumpUsdPrice(c.id, c.refUsd, now - i * 10000, { isNew: c.isNew }))
      }
      priceHistory[c.id] = h
    }
    return {
      enabled: false,
      config: { ...DEFAULT_PUMPFUN_CONFIG },
      cashUsd: DEFAULT_PUMPFUN_CONFIG.capitalUsd,
      coins,
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

  const log = useCallback((msg: string, level: PumpFunLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[pumpfun] ${msg}`)
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

      // 1. Refresh quotes — live pump.fun API or mock engine
      let coins: PumpCoinRow[]
      let liveData = false
      let liveErr: unknown = null
      if (cfg.dataMode === 'live') {
        try {
          const live = await fetchPumpCoins()
          if (Object.keys(live).length > 0) {
            coins = buildCoins(PUMP_COIN_SEEDS, now, 'live', live)
            liveData = true
          } else {
            coins = buildCoins(PUMP_COIN_SEEDS, now, 'mock')
          }
        } catch (e) {
          liveErr = e
          coins = buildCoins(PUMP_COIN_SEEDS, now, 'mock')
        }
      } else {
        coins = buildCoins(PUMP_COIN_SEEDS, now, 'mock')
      }

      // momentum + score + verdict per coin (from previous tick price)
      const prevPrices = s0.priceHistory
      const scored = coins.map((c) => {
        const prev = prevPrices[c.id]
        const momentumPct =
          prev && prev.length > 0 && prev[prev.length - 1] > 0
            ? ((c.priceUsd - prev[prev.length - 1]) / prev[prev.length - 1]) * 100
            : 0
        const score = scorePumpOpportunity({
          priceUsd: c.priceUsd,
          refUsd: c.refUsd,
          momentumPct,
          ageMs: c.ageMs,
          liquidityUsd: c.liquidityUsd,
          isNew: c.isNew,
        })
        return {
          ...c,
          momentumPct,
          score,
          verdict: pumpVerdict(c.priceUsd, c.refUsd, score),
        }
      })

      const priceHistory: Record<string, number[]> = {}
      for (const c of scored) {
        const arr = [...(s0.priceHistory[c.id] ?? []), c.priceUsd]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        priceHistory[c.id] = arr
      }
      setState((s) => ({
        ...s,
        coins: scored,
        priceHistory,
        dataSource: liveData ? 'live' : 'mock',
        lastUpdatedAt: now,
      }))

      if (liveErr && !liveData) {
        log(`PumpFun API no disponible — usando motor demo determinista`, 'warn')
      }

      // 2. Build opportunity list (best candidates this scan)
      const opps: PumpOpportunity[] = []
      const byScore = [...scored].sort((a, b) => b.score - a.score)
      for (const c of byScore.slice(0, 8)) {
        const kind = pumpOpportunityKind(c.score, c.priceUsd, c.refUsd, c.ageMs, c.isNew)
        const relPct =
          c.refUsd > 0 ? ((c.priceUsd - c.refUsd) / c.refUsd) * 100 : 0
        const reason =
          kind === 'new-listing'
            ? `Nuevo listado · ${fmtAge(c.ageMs)} de vida · score ${c.score}`
            : kind === 'dip'
              ? `Dip ${relPct.toFixed(1)}% vs referencia · score ${c.score}`
              : kind === 'momentum'
                ? `Momentum +${c.momentumPct.toFixed(1)}% · score ${c.score}`
                : `Oportunidad score ${c.score} · mcap ${fmtMcap(c.mcapUsd)}`
        opps.unshift({
          id: `ppp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          symbol: c.symbol,
          name: c.name,
          emoji: c.emoji,
          priceUsd: c.priceUsd,
          refUsd: c.refUsd,
          mcapUsd: c.mcapUsd,
          score: c.score,
          momentumPct: c.momentumPct,
          ageMs: c.ageMs,
          kind,
          reason,
          detectedAt: now,
          executed: false,
        })
        if (kind === 'new-listing') {
          log(`NUEVA OPORTUNIDAD ${c.symbol}: ${kind} · ${reason} @ ${c.priceUsd.toFixed(6)} USD`, 'trade')
        }
      }

      // 3. SELL open lots ("sell expensive")
      const priceByCoin = new Map(scored.map((c) => [c.id, c.priceUsd]))
      let cash = stateRef.current.cashUsd
      const holdings = stateRef.current.holdings.map((h) => ({ ...h }))
      const trades = [...stateRef.current.trades]
      let executedOpp: PumpOpportunity | null = null

      for (const h of holdings) {
        if (h.status !== 'open') continue
        const current = priceByCoin.get(h.coinId)
        if (!current) continue
        h.currentPriceUsd = current
        const target = h.buyPriceUsd * (1 + cfg.targetPct / 100)
        const stop = h.buyPriceUsd * (1 - cfg.stopLossPct / 100)

        let reason: string | null = null
        if (current >= target) {
          reason = `Take profit +${cfg.targetPct}% (${h.symbol} subió)`
        } else if (current <= stop) {
          reason = `Stop loss -${cfg.stopLossPct}%`
        } else if (
          cfg.trailingPct > 0 &&
          current <= h.peakPriceUsd * (1 - cfg.trailingPct / 100)
        ) {
          reason = `Trailing stop -${cfg.trailingPct}% desde peak`
        }

        if (reason) {
          const sellPrice = current
          const outUsd = sellPrice * h.qty
          const inputUsd = h.buyPriceUsd * h.qty
          const pnl = outUsd - inputUsd
          const pnlBps = Math.round((pnl / inputUsd) * 10000)
          h.status = 'sold'
          h.soldAt = now
          h.sellPriceUsd = sellPrice
          h.pnlUsd = pnl
          cash += outUsd
          trades.unshift({
            id: `ppt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'sell',
            symbol: h.symbol,
            name: h.name,
            emoji: h.emoji,
            qty: h.qty,
            priceUsd: sellPrice,
            inputUsd,
            outUsd,
            pnlUsd: pnl,
            profitBps: pnlBps,
            reason,
            status: 'filled',
            createdAt: now,
          })
          executedOpp = {
            id: `ppp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            symbol: h.symbol,
            name: h.name,
            emoji: h.emoji,
            priceUsd: sellPrice,
            refUsd: h.buyPriceUsd,
            mcapUsd: 0,
            score: 0,
            momentumPct: 0,
            ageMs: 0,
            kind: 'pump',
            reason: `Vendido +${pnl >= 0 ? '' : ''}${pnl.toFixed(2)} USD`,
            detectedAt: now,
            executed: true,
          }
          log(
            `VENDIDO ${h.symbol} ${sellPrice.toFixed(6)} USD (${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD, ${pnlBps >= 0 ? '+' : ''}${pnlBps}bps) — ${reason}`,
            'trade'
          )
        } else {
          h.peakPriceUsd = Math.max(h.peakPriceUsd, current)
        }
      }

      // 4. BUY cheap coins — scored opportunities
      const openCount = holdings.filter((h) => h.status === 'open').length
      let buys = 0
      const openSymbols = new Set(
        holdings.filter((h) => h.status === 'open').map((h) => h.symbol)
      )
      for (const c of byScore) {
        if (openCount + buys >= cfg.maxHoldings) break
        if (c.score < cfg.minScore) continue
        if (c.verdict === 'sell') continue
        if (openSymbols.has(c.symbol)) continue
        if (c.refUsd > 0 && c.priceUsd > c.refUsd * 1.02) continue // not a cheap entry
        const spend = Math.min(cfg.budgetPerTradeUsd, cash)
        if (spend < 25) break
        const qty = spend / c.priceUsd
        holdings.unshift({
          id: `pph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          coinId: c.id,
          symbol: c.symbol,
          name: c.name,
          emoji: c.emoji,
          qty,
          buyPriceUsd: c.priceUsd,
          currentPriceUsd: c.priceUsd,
          peakPriceUsd: c.priceUsd,
          buyPair: 'pump.fun',
          status: 'open',
          boughtAt: now,
        })
        trades.unshift({
          id: `ppt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'buy',
          symbol: c.symbol,
          name: c.name,
          emoji: c.emoji,
          qty,
          priceUsd: c.priceUsd,
          inputUsd: spend,
          outUsd: spend,
          pnlUsd: 0,
          profitBps: 0,
          reason: `Op. score ${c.score} · ${c.symbol} barato (${fmtMcap(c.mcapUsd)} mcap)`,
          status: 'filled',
          createdAt: now,
        })
        cash -= spend
        buys++
        openSymbols.add(c.symbol)
        log(
          `COMPRANDO ${c.symbol} @ ${c.priceUsd.toFixed(8)} USD (${spend.toFixed(2)} USD, score ${c.score}) — ${c.name}`,
          'trade'
        )
      }

      if (executedOpp) opps.unshift(executedOpp)

      // 5. Stats
      const open = holdings.filter((h) => h.status === 'open')
      const investedUsd = open.reduce((a, h) => a + h.buyPriceUsd * h.qty, 0)
      const openValue = open.reduce((a, h) => a + h.currentPriceUsd * h.qty, 0)
      const equity = cash + openValue
      const sold = holdings.filter((h) => h.status === 'sold')
      const realized = sold.reduce((a, h) => a + (h.pnlUsd ?? 0), 0)
      const wins = sold.filter((h) => (h.pnlUsd ?? 0) >= 0).length
      const total = sold.length
      const prevStats = stateRef.current.stats
      const newCount = opps.filter((o) => o.kind === 'new-listing' || o.kind === 'pump').length
      const stats: PumpFunStats = {
        running: s0.enabled,
        startedAt: s0.enabled ? (prevStats?.startedAt ?? now) : null,
        uptimeMs: s0.enabled ? now - (prevStats?.startedAt ?? now) : 0,
        capitalUsd: cfg.capitalUsd,
        cashUsd: cash,
        investedUsd,
        equityUsd: equity,
        realizedPnlUsd: realized,
        totalTrades: total,
        wins,
        losses: total - wins,
        winRate: total > 0 ? (wins / total) * 100 : 0,
        openHoldings: open.length,
        newDetections: (prevStats?.newDetections ?? 0) + newCount,
        scanCount: (prevStats?.scanCount ?? 0) + 1,
        lastScanAt: now,
        liveData: stateRef.current.dataSource === 'live',
        bestMcapUsd: byScore[0]?.mcapUsd ?? 0,
      }
      const unrealized = openValue - investedUsd
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

      if (buys === 0 && opps.length === 0) {
        log(
          `Sin oportunidades ≥ score ${cfg.minScore} este ciclo — ${scored.length} memes rastreados`,
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
      `PUMPFUN BOT iniciado — ${stateRef.current.config.capitalUsd.toFixed(2)} USD ficticios, hunting meme dips & pumps`,
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
    log('PumpFun bot detenido', 'info')
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

  const updateConfig = useCallback((patch: Partial<PumpFunConfig>) => {
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
    log,
  }
}

function fmtAge(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function fmtMcap(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

export type PumpFunBot = ReturnType<typeof usePumpFunBot>