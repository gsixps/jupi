// YIELD bot — Aave USDC + Bybit funding carry, with rotation and compounding.
//
// DEMO with REAL data only (Aave rate from DefiLlama, Bybit books, funding
// and settlement times). One tick every 5 minutes:
//   1. Accrue Aave interest on the idle USDC (compounded every tick).
//   2. Credit funding to an open carry at every real settlement time
//      (qty × mark × the rate in force), and mark both legs to the book.
//   3. Compound: reinvest the collected funding into the carry once it
//      reaches the minimum order size, at the chosen cadence.
//   4. Decide: open / rotate / close (back to Aave) by evaluateCandidate().
//
// LIVE is not wired: it needs the USDC on Aave (an EVM wallet) AND the carry
// on Bybit (API keys) plus moving funds between them. Validate the demo first.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CARRY_CANDIDATES,
  DEFAULT_CARRY_RULES,
  MIN_ORDER_USD,
  PERP_FEE,
  SPOT_FEE,
  accrue,
  evaluateCandidate,
  fetchAaveApy,
  fetchCarryQuotes,
  fetchFundingStats,
  type CandidateView,
  type CarryQuote,
  type CarryRules,
  type FundingStats,
} from '@/lib/carry'
import type { EquityPoint } from '@/lib/trading-types'

const TICK_MS = 5 * 60_000
const FUNDING_REFRESH_MS = 30 * 60_000
const LOG_CAP = 150

export type CompoundEvery = 'hour' | 'day' | 'week'
const COMPOUND_MS: Record<CompoundEvery, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 }

export interface CarryConfig {
  capitalUsd: number
  /** share of equity allowed into the carry (rest stays on Aave) */
  carryPct: number
  compoundEvery: CompoundEvery
  rules: CarryRules
}

export interface CarryPosition {
  candidateId: string
  label: string
  qty: number
  spotEntry: number
  perpEntry: number
  openedAt: number
  /** USD spent including fees (the capital moved out of Aave) */
  costUsd: number
  /** funding collected and not yet reinvested */
  fundingCashUsd: number
  fundingTotalUsd: number
  lastSettlementSeen: number
  lastCompoundAt: number
}

export interface CarryLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

interface Persisted {
  aaveUsd: number
  position: CarryPosition | null
  realizedUsd: number
  aaveInterestUsd: number
  lastTick: number
}
const KEY = 'mb_carry_v1'
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

/** Value of the hedged position if closed now at the books (fees included). */
function positionValue(p: CarryPosition, q: CarryQuote | undefined): number {
  if (!q) return p.costUsd + p.fundingCashUsd
  const spot = p.qty * q.spotBid * (1 - SPOT_FEE)
  const perpPnl = p.qty * (p.perpEntry - q.perpAsk) - p.qty * q.perpAsk * PERP_FEE
  return spot + perpPnl + p.fundingCashUsd
}

export function useCarryBot() {
  const [enabled, setEnabled] = useState(false)
  const [config, setConfig] = useState<CarryConfig>({
    capitalUsd: 1000,
    carryPct: 50,
    compoundEvery: 'day',
    rules: { ...DEFAULT_CARRY_RULES },
  })
  const [aaveUsd, setAaveUsd] = useState(1000)
  const [aaveApy, setAaveApy] = useState(0)
  const [position, setPosition] = useState<CarryPosition | null>(null)
  const [candidates, setCandidates] = useState<CandidateView[]>([])
  const [quotes, setQuotes] = useState<Record<string, CarryQuote>>({})
  const [logs, setLogs] = useState<CarryLogEntry[]>([])
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([])
  const [realizedUsd, setRealizedUsd] = useState(0)
  const [aaveInterestUsd, setAaveInterestUsd] = useState(0)
  const [dataOk, setDataOk] = useState(false)

  const ref = useRef({
    config,
    aaveUsd: 1000,
    position: null as CarryPosition | null,
    realizedUsd: 0,
    aaveInterestUsd: 0,
    lastTick: 0,
    funding: {} as Record<string, FundingStats>,
    fundingAt: 0,
  })
  useEffect(() => {
    ref.current.config = config
  }, [config])
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)
  const tickCount = useRef(0)

  const log = useCallback((msg: string, level: CarryLogEntry['level'] = 'info') => {
    setLogs((l) => [{ time: Date.now(), msg, level }, ...l].slice(0, LOG_CAP))
  }, [])

  const sync = useCallback(() => {
    const r = ref.current
    setAaveUsd(r.aaveUsd)
    setPosition(r.position ? { ...r.position } : null)
    setRealizedUsd(r.realizedUsd)
    setAaveInterestUsd(r.aaveInterestUsd)
    save({ aaveUsd: r.aaveUsd, position: r.position, realizedUsd: r.realizedUsd, aaveInterestUsd: r.aaveInterestUsd, lastTick: r.lastTick })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      const p = load()
      if (!p) return
      Object.assign(ref.current, p)
      sync()
      log(`Sesión restaurada: ${p.aaveUsd.toFixed(2)} USD en Aave${p.position ? ` + carry ${p.position.label}` : ''}`)
    }, 0)
    return () => clearTimeout(t)
  }, [log, sync])

  const closeCarry = useCallback(
    (q: CarryQuote | undefined, reason: string) => {
      const r = ref.current
      const p = r.position
      if (!p) return
      const value = positionValue(p, q)
      const pnl = value - p.costUsd
      r.aaveUsd += value
      r.realizedUsd += pnl
      r.position = null
      log(
        `CIERRE carry ${p.label}: ${value.toFixed(2)} USD vuelven a Aave (funding cobrado ${p.fundingTotalUsd.toFixed(4)} USD, resultado ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USD) — ${reason}`,
        pnl >= 0 ? 'trade' : 'warn'
      )
    },
    [log]
  )

  const tick = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const r = ref.current
      const cfg = r.config
      let apy: number
      let qs: Record<string, CarryQuote>
      try {
        ;[apy, qs] = await Promise.all([fetchAaveApy(), fetchCarryQuotes()])
      } catch (e) {
        setDataOk(false)
        log(`Datos no disponibles (${(e as Error).message}) — ciclo omitido, sin datos simulados`, 'warn')
        return
      }
      setDataOk(true)
      setAaveApy(apy)
      setQuotes(qs)
      const now = Date.now()
      tickCount.current += 1

      // 1. Aave interest since the last tick
      if (r.lastTick > 0) {
        const before = r.aaveUsd
        r.aaveUsd = accrue(r.aaveUsd, apy, now - r.lastTick)
        r.aaveInterestUsd += r.aaveUsd - before
      }
      r.lastTick = now

      // funding history (refreshed every 30 min — 18 small requests)
      if (now - r.fundingAt > FUNDING_REFRESH_MS) {
        const next: Record<string, FundingStats> = {}
        for (const c of CARRY_CANDIDATES) {
          const q = qs[c.id]
          if (!q) continue
          try {
            next[c.id] = await fetchFundingStats(c.perp, q.fundingIntervalH)
          } catch {
            /* keep the candidate ineligible this round */
          }
        }
        r.funding = next
        r.fundingAt = now
      }

      // 2. funding at every REAL settlement crossed since the last tick
      const p = r.position
      if (p) {
        const q = qs[p.candidateId]
        if (q) {
          const intervalMs = q.fundingIntervalH * 3_600_000
          const lastSettlement = q.nextFundingTime - intervalMs
          if (lastSettlement > p.lastSettlementSeen && lastSettlement <= now) {
            const mark = (q.perpBid + q.perpAsk) / 2
            const paid = p.qty * mark * q.fundingRate
            p.fundingCashUsd += paid
            p.fundingTotalUsd += paid
            p.lastSettlementSeen = lastSettlement
            log(`Funding ${p.label}: ${paid >= 0 ? '+' : ''}${paid.toFixed(4)} USD (tasa ${(q.fundingRate * 100).toFixed(4)}%)`, paid >= 0 ? 'trade' : 'warn')
          }
          // 3. compound the collected funding into the position
          if (now - p.lastCompoundAt >= COMPOUND_MS[cfg.compoundEvery] && p.fundingCashUsd >= MIN_ORDER_USD) {
            const add = p.fundingCashUsd
            const addQty = (add * (1 - SPOT_FEE - PERP_FEE)) / q.spotAsk
            const newQty = p.qty + addQty
            p.perpEntry = (p.perpEntry * p.qty + q.perpBid * addQty) / newQty
            p.spotEntry = (p.spotEntry * p.qty + q.spotAsk * addQty) / newQty
            p.qty = newQty
            p.costUsd += add
            p.fundingCashUsd = 0
            p.lastCompoundAt = now
            log(`⚡ Interés compuesto: ${add.toFixed(2)} USD de funding reinvertidos en ${p.label}`, 'info')
          }
        }
      }

      // 4. decide
      const views = CARRY_CANDIDATES.map((c) => evaluateCandidate(c, qs[c.id], r.funding[c.id], apy, cfg.rules)).sort(
        (a, b) => b.edgeApr - a.edgeApr
      )
      setCandidates(views)
      const best = views.find((v) => v.eligible)
      const equity = r.aaveUsd + (r.position ? positionValue(r.position, qs[r.position.candidateId]) : 0)

      if (r.position) {
        const cur = views.find((v) => v.id === r.position!.candidateId)
        const f24 = cur?.funding?.avg24hApr ?? 0
        if (!cur?.quote) {
          // no book: hold, never close blind
        } else if (cur.currentApr <= 0 || f24 < apy) {
          closeCarry(cur.quote, `el funding (${(cur.currentApr * 100).toFixed(1)}% actual, ${(f24 * 100).toFixed(1)}% 24 h) ya no supera a Aave (${(apy * 100).toFixed(1)}%)`)
        } else if (best && best.id !== cur.id) {
          const gain = ((best.edgeApr - cur.edgeApr) * cfg.rules.horizonDays) / 365
          const switchCost = cur.roundTripCost / 2 + best.roundTripCost / 2
          if (gain > switchCost * cfg.rules.costCover) {
            closeCarry(cur.quote, `rotación a ${best.label}`)
          }
        }
      }

      if (!r.position && best?.quote) {
        const target = (equity * cfg.carryPct) / 100
        const notional = Math.min(target, r.aaveUsd)
        if (notional >= MIN_ORDER_USD * 2) {
          const q = best.quote
          const qty = (notional * (1 - SPOT_FEE)) / q.spotAsk
          r.aaveUsd -= notional
          r.position = {
            candidateId: best.id,
            label: best.label,
            qty,
            spotEntry: q.spotAsk,
            perpEntry: q.perpBid * (1 - PERP_FEE),
            openedAt: now,
            costUsd: notional,
            fundingCashUsd: 0,
            fundingTotalUsd: 0,
            lastSettlementSeen: q.nextFundingTime - q.fundingIntervalH * 3_600_000,
            lastCompoundAt: now,
          }
          log(
            `CARRY ${best.label}: compra ${qty.toFixed(6)} spot @ ${q.spotAsk} + corto perp @ ${q.perpBid} (${notional.toFixed(2)} USD) — funding 7 d ${((best.funding?.avgApr ?? 0) * 100).toFixed(1)}% vs Aave ${(apy * 100).toFixed(1)}%`,
            'trade'
          )
        }
      } else if (!r.position && (r.fundingAt === now || tickCount.current % 12 === 0)) {
        const top = views[0]
        log(
          `Todo en Aave (${(apy * 100).toFixed(2)}%): ningún carry compensa los costes${top ? ` — mejor ${top.label}: ${top.why}` : ''}`,
          'info'
        )
      }

      const eqNow = r.aaveUsd + (r.position ? positionValue(r.position, qs[r.position.candidateId]) : 0)
      setEquityCurve((c) => [...c, { timestamp: now, equity: eqNow, balance: r.aaveUsd, openPnl: eqNow - r.config.capitalUsd }].slice(-600))
      sync()
    } finally {
      inFlight.current = false
    }
  }, [closeCarry, log, sync])

  const start = useCallback(() => {
    setEnabled(true)
    log(`BOT DE RENDIMIENTO iniciado (demo, datos reales) — hasta ${ref.current.config.carryPct}% en carry, compuesto cada ${ref.current.config.compoundEvery === 'hour' ? 'hora' : ref.current.config.compoundEvery === 'day' ? 'día' : 'semana'}`, 'trade')
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => void tick(), TICK_MS)
    void tick()
  }, [log, tick])

  const stop = useCallback(() => {
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = null
    setEnabled(false)
    log('Bot detenido (el saldo y la posición se conservan)')
  }, [log])

  const reset = useCallback(() => {
    stop()
    Object.assign(ref.current, {
      aaveUsd: ref.current.config.capitalUsd,
      position: null,
      realizedUsd: 0,
      aaveInterestUsd: 0,
      lastTick: 0,
    })
    setEquityCurve([])
    sync()
    log(`Cuenta reiniciada: ${ref.current.config.capitalUsd.toFixed(2)} USD en Aave`)
  }, [log, stop, sync])

  const updateConfig = useCallback(
    (patch: Partial<CarryConfig>) => {
      setConfig((c) => ({ ...c, ...patch, rules: { ...c.rules, ...(patch.rules ?? {}) } }))
      if (patch.capitalUsd !== undefined && !loopRef.current && !ref.current.position) {
        ref.current.aaveUsd = patch.capitalUsd
        sync()
      }
    },
    [sync]
  )

  useEffect(() => () => {
    if (loopRef.current) clearInterval(loopRef.current)
  }, [])

  const posValue = position ? positionValue(position, quotes[position.candidateId]) : 0
  return {
    enabled,
    liveTrading: false,
    config,
    aaveUsd,
    aaveApy,
    position,
    positionValueUsd: posValue,
    equityUsd: aaveUsd + posValue,
    realizedUsd,
    aaveInterestUsd,
    candidates,
    logs,
    equityCurve,
    dataOk,
    start,
    stop,
    reset,
    updateConfig,
  }
}

export type CarryBot = ReturnType<typeof useCarryBot>
