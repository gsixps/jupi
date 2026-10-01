// POLYMARKET copy-trading — DEMO (paper) with real public data only.
//
//   ANALYZE  leaderboards (week / month / all) → wallets present in ≥2 →
//            analyzeWallet(): constancy, frequency, size, hit rate on recent
//            closed positions (unredeemed losses included), concentration.
//   FOLLOW   the best `followCount` copyable wallets (or the ones you pick).
//   COPY     every 30 s, new BUYs of the followed wallets are copied at the
//            price REALLY available now (best ask of the order book), only if
//            it moved ≤ maxSlippage from theirs; their SELL closes our copy at
//            the best bid; a resolved market pays 1 or 0 per share.
//            Fees: the market's taker fee (feeUsd) on every fill.
//
// Nothing is sent to Polymarket: no wallet, no orders.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_ANALYSIS_RULES,
  analyzeWallet,
  feeUsd,
  fetchBaseFee,
  fetchBook,
  fetchLeaderboard,
  fetchResolution,
  fetchTrades,
  type PmTrade,
  type WalletAnalysis,
} from '@/lib/polymarket'
import type { EquityPoint } from '@/lib/trading-types'

const TICK_MS = 30_000
const LOG_CAP = 200

export interface PolyConfig {
  capitalUsd: number
  /** % of current equity per copied buy (compounding) */
  perTradePct: number
  maxPerTradeUsd: number
  /** max price move since the wallet's fill, in price units (0.02 = 2 cents) */
  maxSlippage: number
  /** never buy outcomes priced above this (little upside, all downside) */
  maxEntryPrice: number
  maxOpenPositions: number
  followCount: number
}

export interface PolyPosition {
  asset: string
  conditionId: string
  title: string
  outcome: string
  wallet: string
  walletName: string
  shares: number
  costUsd: number
  avgPrice: number
  openedAt: number
  markPrice: number
}

export interface PolyClosed {
  title: string
  outcome: string
  walletName: string
  costUsd: number
  proceedsUsd: number
  pnlUsd: number
  reason: string
  closedAt: number
}

export interface PolyLog {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

interface Persisted {
  cashUsd: number
  positions: PolyPosition[]
  closed: PolyClosed[]
  followed: { wallet: string; name: string }[]
  seen: Record<string, number>
}
const KEY = 'mb_polycopy_v1'
const load = (): Persisted | null => {
  try {
    const r = localStorage.getItem(KEY)
    return r ? (JSON.parse(r) as Persisted) : null
  } catch {
    return null
  }
}
const save = (p: Persisted) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* memory only */
  }
}

export function usePolyCopyBot() {
  const [enabled, setEnabled] = useState(false)
  const [config, setConfig] = useState<PolyConfig>({
    capitalUsd: 1000,
    perTradePct: 5,
    maxPerTradeUsd: 100,
    maxSlippage: 0.02,
    maxEntryPrice: 0.95,
    maxOpenPositions: 15,
    followCount: 5,
  })
  const [analysis, setAnalysis] = useState<WalletAnalysis[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [followed, setFollowed] = useState<{ wallet: string; name: string }[]>([])
  const [cashUsd, setCashUsd] = useState(1000)
  const [positions, setPositions] = useState<PolyPosition[]>([])
  const [closed, setClosed] = useState<PolyClosed[]>([])
  const [logs, setLogs] = useState<PolyLog[]>([])
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([])
  const [stats, setStats] = useState({ copied: 0, skippedSlippage: 0, skippedOther: 0 })

  const ref = useRef({
    config,
    cashUsd: 1000,
    positions: [] as PolyPosition[],
    closed: [] as PolyClosed[],
    followed: [] as { wallet: string; name: string }[],
    /** last copied trade timestamp per wallet (seconds) */
    seen: {} as Record<string, number>,
    stats: { copied: 0, skippedSlippage: 0, skippedOther: 0 },
    resolveAt: 0,
  })
  useEffect(() => {
    ref.current.config = config
  }, [config])
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)

  const log = useCallback((msg: string, level: PolyLog['level'] = 'info') => {
    setLogs((l) => [{ time: Date.now(), msg, level }, ...l].slice(0, LOG_CAP))
  }, [])

  const sync = useCallback(() => {
    const r = ref.current
    setCashUsd(r.cashUsd)
    setPositions([...r.positions])
    setClosed([...r.closed])
    setFollowed([...r.followed])
    setStats({ ...r.stats })
    save({ cashUsd: r.cashUsd, positions: r.positions, closed: r.closed.slice(0, 300), followed: r.followed, seen: r.seen })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      const p = load()
      if (!p) return
      Object.assign(ref.current, { cashUsd: p.cashUsd, positions: p.positions, closed: p.closed, followed: p.followed, seen: p.seen })
      sync()
      log(`Sesión restaurada: ${p.positions.length} posiciones, siguiendo ${p.followed.length} wallets`)
    }, 0)
    return () => clearTimeout(t)
  }, [log, sync])

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true)
    try {
      const [w, m, a] = await Promise.all([fetchLeaderboard('WEEK'), fetchLeaderboard('MONTH'), fetchLeaderboard('ALL')])
      const map = new Map<string, { name: string; week: number | null; month: number | null; all: number | null }>()
      const add = (rows: typeof w, k: 'week' | 'month' | 'all') => {
        for (const r of rows) {
          const e = map.get(r.proxyWallet) ?? { name: r.userName || r.proxyWallet.slice(0, 10), week: null, month: null, all: null }
          e[k] = r.pnl
          map.set(r.proxyWallet, e)
        }
      }
      add(w, 'week')
      add(m, 'month')
      add(a, 'all')
      const cands = [...map.entries()].filter(([, e]) => [e.week, e.month, e.all].filter((x) => x !== null).length >= 2)
      log(`Analizando ${cands.length} wallets que aparecen en ≥2 rankings (de ${map.size})…`)
      const out: WalletAnalysis[] = []
      for (const [wallet, e] of cands) {
        out.push(await analyzeWallet(wallet, e.name, e, DEFAULT_ANALYSIS_RULES))
        setAnalysis([...out].sort((x, y) => Number(y.copyable) - Number(x.copyable) || y.score - x.score))
      }
      const best = out.filter((x) => x.copyable).sort((x, y) => y.score - x.score).slice(0, ref.current.config.followCount)
      if (ref.current.followed.length === 0) {
        ref.current.followed = best.map((b) => ({ wallet: b.wallet, name: b.name }))
        sync()
      }
      log(`Análisis listo: ${out.filter((x) => x.copyable).length} copiables de ${out.length}`, 'trade')
    } catch (e) {
      log(`Análisis fallido: ${(e as Error).message}`, 'error')
    } finally {
      setAnalyzing(false)
    }
  }, [log, sync])

  const toggleFollow = useCallback(
    (wallet: string, name: string) => {
      const r = ref.current
      r.followed = r.followed.some((f) => f.wallet === wallet)
        ? r.followed.filter((f) => f.wallet !== wallet)
        : [...r.followed, { wallet, name }]
      sync()
    },
    [sync]
  )

  const equityNow = () => ref.current.cashUsd + ref.current.positions.reduce((a, p) => a + p.shares * p.markPrice, 0)

  const closePosition = useCallback(
    (p: PolyPosition, price: number, reason: string, withFee: boolean, fee = 0) => {
      const r = ref.current
      const gross = p.shares * price
      const proceeds = gross - (withFee ? fee : 0)
      r.cashUsd += proceeds
      r.positions = r.positions.filter((x) => x !== p)
      const pnl = proceeds - p.costUsd
      r.closed = [
        { title: p.title, outcome: p.outcome, walletName: p.walletName, costUsd: p.costUsd, proceedsUsd: proceeds, pnlUsd: pnl, reason, closedAt: Date.now() },
        ...r.closed,
      ]
      log(`CIERRE ${p.title} · ${p.outcome}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD — ${reason}`, pnl >= 0 ? 'trade' : 'warn')
    },
    [log]
  )

  const tick = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const r = ref.current
      const cfg = r.config
      const nowS = Math.floor(Date.now() / 1000)

      // 1. new trades of every followed wallet
      for (const f of r.followed) {
        let trades: PmTrade[]
        try {
          trades = await fetchTrades(f.wallet, 50)
        } catch {
          continue
        }
        const last = r.seen[f.wallet]
        if (last === undefined) {
          // first look: remember where we start, never copy the past
          r.seen[f.wallet] = trades[0]?.timestamp ?? nowS
          continue
        }
        const fresh = trades.filter((t) => t.timestamp > last).sort((a, b) => a.timestamp - b.timestamp)
        if (fresh.length) r.seen[f.wallet] = fresh[fresh.length - 1].timestamp
        for (const t of fresh) {
          const held = r.positions.find((p) => p.asset === t.asset)
          if (t.side === 'SELL') {
            if (held && held.wallet === f.wallet) {
              const b = await fetchBook(t.asset)
              if (!b || !(b.bestBid > 0)) continue
              const fee = feeUsd(await fetchBaseFee(t.asset), b.bestBid, held.shares)
              closePosition(held, b.bestBid, `${f.name} vendió a ${t.price.toFixed(3)}; copia vendida al bid ${b.bestBid.toFixed(3)}`, true, fee)
            }
            continue
          }
          // BUY
          if (held) continue
          if (r.positions.length >= cfg.maxOpenPositions) {
            r.stats.skippedOther++
            continue
          }
          const b = await fetchBook(t.asset)
          if (!b || !(b.bestAsk > 0) || b.bestAsk >= 1) {
            r.stats.skippedOther++
            continue
          }
          const ask = b.bestAsk
          if (ask - t.price > cfg.maxSlippage) {
            r.stats.skippedSlippage++
            log(`⏭ ${t.title} · ${t.outcome}: ${f.name} compró a ${t.price.toFixed(3)}, ahora ${ask.toFixed(3)} (+${((ask - t.price) * 100).toFixed(1)} ¢) — demasiado tarde`, 'warn')
            continue
          }
          if (ask > cfg.maxEntryPrice) {
            r.stats.skippedOther++
            continue
          }
          const budget = Math.min((equityNow() * cfg.perTradePct) / 100, cfg.maxPerTradeUsd, r.cashUsd)
          if (budget < 1) continue
          const baseFee = await fetchBaseFee(t.asset)
          const sharesGross = budget / ask
          const fee = feeUsd(baseFee, ask, sharesGross)
          const shares = (budget - fee) / ask
          if (!(shares > 0)) continue
          r.cashUsd -= budget
          r.positions.push({
            asset: t.asset,
            conditionId: t.conditionId,
            title: t.title,
            outcome: t.outcome,
            wallet: f.wallet,
            walletName: f.name,
            shares,
            costUsd: budget,
            avgPrice: ask,
            openedAt: Date.now(),
            markPrice: b.bestBid || ask,
          })
          r.stats.copied++
          log(
            `COPIA ${f.name}: ${t.title} · ${t.outcome} @ ${ask.toFixed(3)} (ellos ${t.price.toFixed(3)}) · ${budget.toFixed(2)} USD${fee > 0 ? ` · comisión ${fee.toFixed(3)}` : ''}`,
            'trade'
          )
        }
      }

      // 2. mark open positions to the bid; settle resolved markets (every 5 min)
      const doResolve = Date.now() - r.resolveAt > 5 * 60_000
      if (doResolve) r.resolveAt = Date.now()
      for (const p of [...r.positions]) {
        const b = await fetchBook(p.asset)
        if (b && b.bestBid > 0) p.markPrice = b.bestBid
        if (doResolve || !b) {
          const res = await fetchResolution(p.conditionId)
          if (res?.closed && res.winner) {
            closePosition(p, res.winner === p.asset ? 1 : 0, res.winner === p.asset ? 'mercado resuelto: GANA (1 USD por acción)' : 'mercado resuelto: pierde (0)', false)
          }
        }
      }

      const eq = equityNow()
      setEquityCurve((c) => [...c, { timestamp: Date.now(), equity: eq, balance: r.cashUsd, openPnl: eq - r.config.capitalUsd }].slice(-1000))
      sync()
    } finally {
      inFlight.current = false
    }
  }, [closePosition, log, sync])

  const start = useCallback(async () => {
    if (ref.current.followed.length === 0) {
      log('Primero analiza las wallets (o elige alguna) para tener a quién copiar', 'warn')
      return
    }
    setEnabled(true)
    log(`COPY TRADING iniciado (demo) — siguiendo ${ref.current.followed.map((f) => f.name).join(', ')}. Solo se copian operaciones NUEVAS desde ahora.`, 'trade')
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => void tick(), TICK_MS)
    void tick()
  }, [log, tick])

  const stop = useCallback(() => {
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = null
    setEnabled(false)
    log('Copy trading detenido (las posiciones demo se mantienen)')
  }, [log])

  const reset = useCallback(() => {
    stop()
    Object.assign(ref.current, {
      cashUsd: ref.current.config.capitalUsd,
      positions: [],
      closed: [],
      seen: {},
      stats: { copied: 0, skippedSlippage: 0, skippedOther: 0 },
    })
    setEquityCurve([])
    sync()
    log(`Cuenta demo reiniciada a ${ref.current.config.capitalUsd} USD`)
  }, [log, stop, sync])

  const updateConfig = useCallback(
    (patch: Partial<PolyConfig>) => {
      setConfig((c) => ({ ...c, ...patch }))
      if (patch.capitalUsd !== undefined && !loopRef.current && ref.current.positions.length === 0) {
        ref.current.cashUsd = patch.capitalUsd
        sync()
      }
    },
    [sync]
  )

  useEffect(() => () => {
    if (loopRef.current) clearInterval(loopRef.current)
  }, [])

  const openValue = positions.reduce((a, p) => a + p.shares * p.markPrice, 0)
  const realized = closed.reduce((a, c) => a + c.pnlUsd, 0)
  return {
    enabled,
    liveTrading: false,
    config,
    analysis,
    analyzing,
    followed,
    cashUsd,
    positions,
    closed,
    logs,
    equityCurve,
    stats,
    equityUsd: cashUsd + openValue,
    openValueUsd: openValue,
    realizedUsd: realized,
    wins: closed.filter((c) => c.pnlUsd > 0).length,
    runAnalysis,
    toggleFollow,
    start,
    stop,
    reset,
    updateConfig,
  }
}

export type PolyCopyBot = ReturnType<typeof usePolyCopyBot>
