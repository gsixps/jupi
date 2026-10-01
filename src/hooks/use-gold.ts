// GOLD bot — trend following on XAU/USD, executed on OANDA (v20 API).
//
// Same rules as the BTC/ETH trend bot (src/lib/trend.ts): long when the close
// breaks the N-candle high above the EMA filter; exit on the M-candle low or
// the ATR trailing stop; each trade risks riskPct of equity.
//
// Gold on OANDA is a CFD: a position only locks MARGIN (marginRate × value);
// its result is units × (exit − entry), minus the spread (paid through the
// bid/ask) and the daily FINANCING of holding it. Both are modelled in demo
// and come from OANDA in live.
//
// Data: with OANDA connected, real XAU_USD candles and bid/ask; without it,
// the public PAXG/USDT market (1 PAXG = 1 oz of physical gold) as a proxy.
// LIVE: market buy with the stop placed AT THE BROKER (it protects the trade
// even with the browser closed); the trailing stop is moved at the broker.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_TREND_PARAMS,
  INTERVAL_MS,
  backtest,
  closedOnly,
  decide,
  fetchBinanceKlines,
  warmupBars,
  type BacktestResult,
  type Candle,
  type TrendParams,
  type TrendPosition,
  type TrendTrade,
} from '@/lib/trend'
import {
  OandaUnconfirmedError,
  loadOandaCreds,
  oandaBuyGold,
  oandaCloseTrade,
  oandaGoldCandles,
  oandaGoldPrice,
  oandaGoldSpec,
  oandaMoveStop,
  oandaOpenGoldTrades,
  oandaSummary,
  type OandaGoldSpec,
} from '@/lib/oanda'
import type { EquityPoint } from '@/lib/trading-types'

const TICK_MS = 60_000
const LOG_CAP = 150
const TRADE_CAP = 200
const YEAR_MS = 365 * 86_400_000

/** Demo assumptions until an OANDA account tells us the real ones. */
const DEFAULT_SPEC: OandaGoldSpec = { minimumTradeSize: 1, tradeUnitsPrecision: 0, marginRate: 0.05, longRate: -0.06 }
/** Half of a typical XAU/USD spread (~0.4 USD on ~4000 USD). */
const DEFAULT_HALF_SPREAD = 0.00005

export const GOLD_DEFAULT_PARAMS: TrendParams = {
  ...DEFAULT_TREND_PARAMS,
  feeRate: 0, // OANDA charges no commission on XAU/USD: the cost is the spread
  slippage: 0.0002,
  holdCostPerYear: 0.06,
}

export interface GoldConfig {
  capitalUsd: number
  params: TrendParams
  compound: boolean
  liveTrading: boolean
}

export interface GoldPosition extends TrendPosition {
  /** OANDA trade id when live */
  tradeId?: string
  units: number
  financingUsd: number
  lastAccrualAt: number
}

export interface GoldLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

interface Persisted {
  cashUsd: number
  position: GoldPosition | null
  trades: TrendTrade[]
  lastDecidedT: number
  liveTrading: boolean
}
const KEY = 'mb_gold_v1'
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

function roundUnits(u: number, spec: OandaGoldSpec): number {
  const f = Math.pow(10, spec.tradeUnitsPrecision)
  return Math.floor(u * f) / f
}

export function useGoldBot() {
  const [enabled, setEnabled] = useState(false)
  const [config, setConfig] = useState<GoldConfig>({
    capitalUsd: 1000,
    params: { ...GOLD_DEFAULT_PARAMS },
    compound: true,
    liveTrading: false,
  })
  const [cashUsd, setCashUsd] = useState(1000)
  const [position, setPosition] = useState<GoldPosition | null>(null)
  const [trades, setTrades] = useState<TrendTrade[]>([])
  const [logs, setLogs] = useState<GoldLogEntry[]>([])
  const [price, setPrice] = useState<{ bid: number; ask: number } | null>(null)
  const [source, setSource] = useState<'oanda' | 'paxg' | 'offline'>('offline')
  const [spec, setSpec] = useState<OandaGoldSpec>(DEFAULT_SPEC)
  const [lastDecision, setLastDecision] = useState('—')
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([])
  const [bt, setBt] = useState<BacktestResult | null>(null)
  const [btBusy, setBtBusy] = useState(false)
  const [halted, setHalted] = useState<string | null>(null)

  const ref = useRef({
    config,
    cashUsd: 1000,
    position: null as GoldPosition | null,
    trades: [] as TrendTrade[],
    lastDecidedT: 0,
    spec: DEFAULT_SPEC,
  })
  useEffect(() => {
    ref.current.config = config
  }, [config])
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)

  const log = useCallback((msg: string, level: GoldLogEntry['level'] = 'info') => {
    setLogs((l) => [{ time: Date.now(), msg, level }, ...l].slice(0, LOG_CAP))
  }, [])

  const sync = useCallback(() => {
    const r = ref.current
    setCashUsd(r.cashUsd)
    setPosition(r.position ? { ...r.position } : null)
    setTrades(r.trades)
    save({ cashUsd: r.cashUsd, position: r.position, trades: r.trades, lastDecidedT: r.lastDecidedT, liveTrading: r.config.liveTrading })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      const p = load()
      if (!p) return
      ref.current.cashUsd = p.cashUsd
      ref.current.position = p.position
      ref.current.trades = p.trades ?? []
      ref.current.lastDecidedT = p.lastDecidedT ?? 0
      if (p.liveTrading && p.position) setConfig((c) => ({ ...c, liveTrading: true }))
      sync()
      if (p.position) log(`Sesión restaurada: ${p.position.units} oz de oro desde ${p.position.entryPrice.toFixed(2)}${p.position.tradeId ? ` (OANDA trade ${p.position.tradeId})` : ''}`)
    }, 0)
    return () => clearTimeout(t)
  }, [log, sync])

  const halt = useCallback(
    (reason: string) => {
      if (loopRef.current) clearInterval(loopRef.current)
      loopRef.current = null
      setEnabled(false)
      setHalted(reason)
      log(`⛔ BOT DETENIDO: ${reason}`, 'error')
    },
    [log]
  )

  /** Candles + bid/ask from OANDA when connected, PAXG/USDT otherwise. */
  const getMarket = useCallback(
    async (bars: number): Promise<{ candles: Candle[]; bid: number; ask: number; src: 'oanda' | 'paxg' }> => {
      const p = ref.current.config.params
      const creds = loadOandaCreds()
      if (creds) {
        const [candles, px] = await Promise.all([oandaGoldCandles(creds, p.interval, bars), oandaGoldPrice(creds)])
        return { candles, bid: px.bid, ask: px.ask, src: 'oanda' }
      }
      if (ref.current.config.liveTrading) throw new Error('modo real sin cuenta de OANDA conectada')
      const raw = await fetchBinanceKlines('PAXGUSDT', p.interval, bars)
      const last = raw[raw.length - 1]?.c ?? 0
      return {
        candles: closedOnly(raw, p.interval),
        bid: last * (1 - DEFAULT_HALF_SPREAD),
        ask: last * (1 + DEFAULT_HALF_SPREAD),
        src: 'paxg',
      }
    },
    []
  )

  const tick = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const r = ref.current
      const cfg = r.config
      const p = cfg.params
      let m: Awaited<ReturnType<typeof getMarket>>
      try {
        m = await getMarket(warmupBars(p) + 10)
      } catch (e) {
        setSource('offline')
        if (cfg.liveTrading) return halt(`sin datos de OANDA: ${(e as Error).message}`)
        log(`Sin datos (${(e as Error).message}) — ciclo omitido, sin precios simulados`, 'warn')
        return
      }
      setSource(m.src)
      setPrice({ bid: m.bid, ask: m.ask })
      const now = Date.now()
      const creds = loadOandaCreds()

      // financing of the open position (demo; live: OANDA books it itself)
      const pos = r.position
      if (pos && !cfg.liveTrading) {
        const dt = now - pos.lastAccrualAt
        const fin = pos.units * m.bid * r.spec.longRate * (dt / YEAR_MS)
        pos.financingUsd += fin
        r.cashUsd += fin
        pos.lastAccrualAt = now
      }
      // live: the broker-side stop may have closed the trade
      if (pos && cfg.liveTrading && pos.tradeId && creds) {
        try {
          const open = await oandaOpenGoldTrades(creds)
          if (!open.some((t) => t.id === pos.tradeId)) {
            const exit = pos.stop
            const pnl = pos.units * (exit - pos.entryPrice) + pos.financingUsd
            r.trades = [
              { entryTime: pos.entryTime, exitTime: now, entryPrice: pos.entryPrice, exitPrice: exit, qty: pos.units, pnlUsd: pnl, pnlPct: (pnl / pos.costUsd) * 100, reason: 'stop ejecutado en OANDA' },
              ...r.trades,
            ].slice(0, TRADE_CAP)
            r.position = null
            const s = await oandaSummary(creds).catch(() => null)
            if (s) r.cashUsd = s.nav
            log(`El stop de OANDA cerró el trade ${pos.tradeId} (~${exit.toFixed(2)}). Saldo real: ${r.cashUsd.toFixed(2)} ${s?.currency ?? ''}`, 'warn')
            sync()
            return
          }
        } catch (e) {
          log(`No se pudieron leer los trades de OANDA: ${(e as Error).message}`, 'warn')
        }
      }

      const posNow = r.position
      const unreal = posNow ? posNow.units * (m.bid - posNow.entryPrice) : 0
      const equity = r.cashUsd + unreal
      setEquityCurve((c) => [...c, { timestamp: now, equity, balance: r.cashUsd, openPnl: unreal }].slice(-500))

      const last = m.candles[m.candles.length - 1]
      if (!last || last.t <= r.lastDecidedT) {
        sync()
        return
      }
      const d = decide(m.candles, p, posNow)
      r.lastDecidedT = last.t
      setLastDecision(d.reason)
      if (d.action === 'none') return sync()

      if (d.action === 'hold') {
        if (posNow && d.stop !== undefined && d.stop > posNow.stop) {
          posNow.stop = d.stop
          posNow.peakClose = Math.max(posNow.peakClose, d.snap.close)
          if (cfg.liveTrading && posNow.tradeId && creds) {
            try {
              await oandaMoveStop(creds, posNow.tradeId, d.stop)
              log(`Stop movido en OANDA a ${d.stop.toFixed(2)}`)
            } catch (e) {
              log(`No se pudo mover el stop en OANDA: ${(e as Error).message}`, 'warn')
            }
          }
        }
        return sync()
      }

      if (d.action === 'buy') {
        const spec = r.spec
        const sizingEquity = cfg.compound ? equity : Math.min(cfg.capitalUsd, equity)
        const entry = m.ask * (1 + p.slippage)
        const perUnitRisk = entry - d.stop
        if (!(perUnitRisk > 0)) return sync()
        const byRisk = (sizingEquity * p.riskPct) / 100 / perUnitRisk
        const byMargin = (equity * 0.8) / (entry * spec.marginRate)
        let units = roundUnits(Math.min(byRisk, byMargin), spec)
        if (units < spec.minimumTradeSize) {
          const minRiskPct = ((spec.minimumTradeSize * perUnitRisk) / sizingEquity) * 100
          log(
            `Señal de compra omitida: el mínimo de OANDA (${spec.minimumTradeSize} oz) arriesgaría ${minRiskPct.toFixed(1)}% del capital (límite ${p.riskPct}%). Más capital o un stop más cercano.`,
            'warn'
          )
          return sync()
        }
        let fillPrice = entry
        let tradeId: string | undefined
        if (cfg.liveTrading) {
          if (!creds) return halt('modo real sin cuenta de OANDA')
          try {
            const f = await oandaBuyGold(creds, units, d.stop, spec.tradeUnitsPrecision)
            fillPrice = f.price
            units = f.units
            tradeId = f.tradeId
          } catch (e) {
            if (e instanceof OandaUnconfirmedError) return halt(e.message)
            return halt(`compra de oro rechazada: ${(e as Error).message}`)
          }
        }
        r.position = {
          entryTime: now,
          entryPrice: fillPrice,
          qty: units,
          units,
          costUsd: units * fillPrice * spec.marginRate, // margin locked
          peakClose: d.snap.close,
          stop: d.stop,
          tradeId,
          financingUsd: 0,
          lastAccrualAt: now,
        }
        log(
          `COMPRA ${units} oz XAU/USD @ ${fillPrice.toFixed(2)} · stop ${d.stop.toFixed(2)} · margen ${(units * fillPrice * spec.marginRate).toFixed(2)} USD ${cfg.liveTrading ? `[OANDA trade ${tradeId}]` : `[demo · ${m.src === 'oanda' ? 'precios OANDA' : 'precios PAXG'}]`} — ${d.reason}`,
          'trade'
        )
        return sync()
      }

      // sell
      if (!posNow) return sync()
      let exit = m.bid * (1 - p.slippage)
      let pnl = posNow.units * (exit - posNow.entryPrice) + posNow.financingUsd
      let liveNav: number | null = null
      if (cfg.liveTrading) {
        if (!creds || !posNow.tradeId) return halt('posición real sin trade de OANDA asociado')
        try {
          const f = await oandaCloseTrade(creds, posNow.tradeId)
          exit = f.price
          pnl = f.pl + f.financing
          liveNav = (await oandaSummary(creds).catch(() => null))?.nav ?? null
        } catch (e) {
          if (e instanceof OandaUnconfirmedError) return halt(e.message)
          return halt(`cierre en OANDA rechazado: ${(e as Error).message}`)
        }
      }
      // live: the account NAV after the close is the truth; demo: price move
      // (financing was already taken from cash while the position was open)
      if (cfg.liveTrading) r.cashUsd = liveNav ?? r.cashUsd + pnl
      else r.cashUsd += posNow.units * (exit - posNow.entryPrice)
      r.trades = [
        {
          entryTime: posNow.entryTime,
          exitTime: now,
          entryPrice: posNow.entryPrice,
          exitPrice: exit,
          qty: posNow.units,
          pnlUsd: pnl,
          pnlPct: (pnl / Math.max(posNow.costUsd, 1e-9)) * 100,
          reason: d.reason,
        },
        ...r.trades,
      ].slice(0, TRADE_CAP)
      r.position = null
      log(
        `VENTA ${posNow.units} oz @ ${exit.toFixed(2)} → ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD (financiación ${posNow.financingUsd.toFixed(2)}) ${cfg.liveTrading ? '[OANDA]' : '[demo]'} — ${d.reason}`,
        pnl >= 0 ? 'trade' : 'warn'
      )
      sync()
    } finally {
      inFlight.current = false
    }
  }, [getMarket, halt, log, sync])

  const start = useCallback(async () => {
    const cfg = ref.current.config
    const creds = loadOandaCreds()
    if (creds) {
      try {
        const [s, spec] = await Promise.all([oandaSummary(creds), oandaGoldSpec(creds)])
        ref.current.spec = spec
        setSpec(spec)
        log(
          `OANDA ${creds.env === 'live' ? 'REAL' : 'práctica'}: saldo ${s.balance.toFixed(2)} ${s.currency} · XAU/USD mínimo ${spec.minimumTradeSize} oz, margen ${(spec.marginRate * 100).toFixed(1)}%, financiación largo ${(spec.longRate * 100).toFixed(2)}%/año`
        )
        ref.current.config.params = { ...ref.current.config.params, holdCostPerYear: -spec.longRate }
        if (cfg.liveTrading && !ref.current.position) {
          ref.current.cashUsd = Math.min(s.nav, cfg.capitalUsd)
        }
      } catch (e) {
        if (cfg.liveTrading) return halt(`no se pudo leer la cuenta de OANDA: ${(e as Error).message}`)
        log(`OANDA no disponible (${(e as Error).message}); demo con precios PAXG`, 'warn')
      }
    } else if (cfg.liveTrading) {
      return halt('modo real sin cuenta de OANDA conectada')
    }
    setHalted(null)
    setEnabled(true)
    log(
      `ORO iniciado ${cfg.liveTrading ? `en MODO REAL (${creds?.env === 'live' ? 'cuenta real' : 'cuenta de práctica'})` : 'en demo'} — velas de ${cfg.params.interval}, ruptura ${cfg.params.entryBars}/${cfg.params.exitBars}, EMA${cfg.params.trendEma}, riesgo ${cfg.params.riskPct}%`,
      'trade'
    )
    sync()
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => void tick(), TICK_MS)
    void tick()
  }, [halt, log, sync, tick])

  const stop = useCallback(() => {
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = null
    setEnabled(false)
    log(`Bot detenido${ref.current.position ? (ref.current.position.tradeId ? ' — el trade sigue abierto en OANDA con su stop' : ' — la posición demo se mantiene') : ''}`)
  }, [log])

  const runBacktest = useCallback(async () => {
    setBtBusy(true)
    try {
      const p = ref.current.config.params
      const creds = loadOandaCreds()
      let c: Candle[]
      let src = 'PAXG/USDT (Binance)'
      if (creds) {
        c = await oandaGoldCandles(creds, p.interval, 5000)
        src = 'XAU/USD (OANDA)'
      } else {
        c = closedOnly(await fetchBinanceKlines('PAXGUSDT', p.interval, 6000), p.interval)
      }
      const res = backtest(c, p, ref.current.config.capitalUsd)
      setBt(res)
      log(
        `Backtest ${src} ${p.interval} (${c.length} velas): ${res.returnPct.toFixed(1)}% vs mantener ${res.buyHoldPct.toFixed(1)}% · caída máx ${res.maxDrawdownPct.toFixed(1)}% · ${res.trades.length} operaciones · ${(INTERVAL_MS[p.interval] / 3_600_000).toFixed(0)} h por vela`
      )
    } catch (e) {
      log(`Backtest fallido: ${(e as Error).message}`, 'error')
    } finally {
      setBtBusy(false)
    }
  }, [log])

  const updateConfig = useCallback(
    (patch: Partial<GoldConfig>) => {
      setConfig((c) => {
        const next = { ...c, ...patch, params: { ...c.params, ...(patch.params ?? {}) } }
        ref.current.config = next
        return next
      })
      if (patch.capitalUsd !== undefined && !loopRef.current && !ref.current.position) {
        ref.current.cashUsd = patch.capitalUsd
        sync()
      }
    },
    [sync]
  )

  const resetAccount = useCallback(() => {
    if (ref.current.position?.tradeId) {
      log('Hay un trade REAL abierto en OANDA: ciérralo allí antes de reiniciar', 'error')
      return
    }
    stop()
    Object.assign(ref.current, { cashUsd: ref.current.config.capitalUsd, position: null, trades: [], lastDecidedT: 0 })
    setEquityCurve([])
    sync()
    log(`Cuenta reiniciada a ${ref.current.config.capitalUsd.toFixed(2)} USD`)
  }, [log, stop, sync])

  useEffect(() => () => {
    if (loopRef.current) clearInterval(loopRef.current)
  }, [])

  const unreal = position && price ? position.units * (price.bid - position.entryPrice) : 0
  const wins = trades.filter((t) => t.pnlUsd > 0).length
  return {
    enabled,
    liveTrading: config.liveTrading,
    config,
    cashUsd,
    position,
    trades,
    logs,
    price,
    source,
    spec,
    lastDecision,
    equityCurve,
    equityUsd: cashUsd + unreal,
    unrealizedUsd: unreal,
    realizedUsd: trades.reduce((a, t) => a + t.pnlUsd, 0),
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    backtest: bt,
    backtestBusy: btBusy,
    halted,
    start,
    stop,
    runBacktest,
    updateConfig,
    resetAccount,
    log,
  }
}

export type GoldBot = ReturnType<typeof useGoldBot>
