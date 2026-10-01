// TREND bot — BTC/ETH trend following on 4h (or 1h) Binance candles.
//
// One tick (every minute):
//   1. Fetch the latest closed candles + the forming one (REAL Binance data;
//      if Binance is unreachable the tick is skipped — never simulated).
//   2. When a NEW candle has closed, evaluate the rules in src/lib/trend.ts
//      (Donchian breakout + EMA filter, Donchian/ATR-trailing exit).
//   3. DEMO books the fill at the current price with fee + slippage; LIVE
//      sends a Binance spot MARKET order and books the real fill/commission.
//
// The demo, the live bot and the backtest call the SAME decide() and
// positionSize(), so the backtest shows what the bot would have done.
// Compound interest: each trade risks riskPct of the CURRENT equity.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_TREND_PARAMS,
  backtest,
  buyFill,
  closedOnly,
  decide,
  fetchBinanceKlines,
  positionSize,
  sellFill,
  warmupBars,
  type BacktestResult,
  type Candle,
  type TrendParams,
  type TrendPosition,
  type TrendTrade,
} from '@/lib/trend'
import {
  binanceGetBalances,
  binanceMarketOrderBase,
  binanceSymbolFilters,
  loadCreds,
} from '@/lib/cex'
import type { EquityPoint } from '@/lib/trading-types'

export type TrendAsset = 'btc' | 'eth'

const SYMBOL: Record<TrendAsset, { symbol: string; base: string; name: string }> = {
  btc: { symbol: 'BTCUSDT', base: 'BTC', name: 'Bitcoin' },
  eth: { symbol: 'ETHUSDT', base: 'ETH', name: 'Ethereum' },
}

const LOG_CAP = 150
const TRADE_CAP = 200
const BACKTEST_BARS = 6000
const TICK_MS = 60_000

export interface TrendConfig {
  capitalUsd: number
  params: TrendParams
  /** each trade risks riskPct of CURRENT equity (true) or of the start capital */
  compound: boolean
  /** real Binance spot orders (requires Binance API keys) */
  liveTrading: boolean
}

export interface TrendLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

export interface TrendStats {
  equityUsd: number
  cashUsd: number
  positionUsd: number
  realizedPnlUsd: number
  totalTrades: number
  wins: number
  winRate: number
}

interface Persisted {
  cashUsd: number
  position: TrendPosition | null
  trades: TrendTrade[]
  lastDecidedT: number
  liveTrading: boolean
}

const storeKey = (a: TrendAsset) => `mb_trend_${a}_v1`
function loadPersisted(a: TrendAsset): Persisted | null {
  try {
    const raw = localStorage.getItem(storeKey(a))
    return raw ? (JSON.parse(raw) as Persisted) : null
  } catch {
    return null
  }
}
function savePersisted(a: TrendAsset, p: Persisted) {
  try {
    localStorage.setItem(storeKey(a), JSON.stringify(p))
  } catch {
    /* storage unavailable: state lives in memory only */
  }
}

export function useTrendBot(asset: TrendAsset) {
  const meta = SYMBOL[asset]
  const [enabled, setEnabled] = useState(false)
  const [config, setConfig] = useState<TrendConfig>({
    capitalUsd: 1000,
    params: { ...DEFAULT_TREND_PARAMS },
    compound: true,
    liveTrading: false,
  })
  const [cashUsd, setCashUsd] = useState(1000)
  const [position, setPosition] = useState<TrendPosition | null>(null)
  const [trades, setTrades] = useState<TrendTrade[]>([])
  const [logs, setLogs] = useState<TrendLogEntry[]>([])
  const [candles, setCandles] = useState<Candle[]>([])
  const [lastPrice, setLastPrice] = useState(0)
  const [lastDecision, setLastDecision] = useState<string>('—')
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([])
  const [bt, setBt] = useState<BacktestResult | null>(null)
  const [btBusy, setBtBusy] = useState(false)
  const [dataSource, setDataSource] = useState<'live' | 'offline'>('offline')
  const [halted, setHalted] = useState<string | null>(null)

  // Mutable mirror read by the async tick; tick writes it first, then the
  // state, and this effect keeps it aligned with whatever the UI changed.
  const ref = useRef({ enabled, config, cashUsd, position, trades, lastDecidedT: 0 })
  useEffect(() => {
    Object.assign(ref.current, { enabled, config, cashUsd, position, trades })
  }, [enabled, config, cashUsd, position, trades])
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)

  const log = useCallback((msg: string, level: TrendLogEntry['level'] = 'info') => {
    setLogs((l) => [{ time: Date.now(), msg, level }, ...l].slice(0, LOG_CAP))
  }, [])

  // restore after a refresh: a live position must never be forgotten
  useEffect(() => {
    const t = setTimeout(() => {
      const p = loadPersisted(asset)
      if (!p) return
      setCashUsd(p.cashUsd)
      setPosition(p.position)
      setTrades(p.trades ?? [])
      ref.current.lastDecidedT = p.lastDecidedT ?? 0
      setConfig((c) => ({ ...c, liveTrading: !!p.liveTrading && !!p.position }))
      if (p.position) {
        log(
          `Sesión restaurada: posición abierta de ${p.position.qty.toFixed(6)} ${meta.base} a ${p.position.entryPrice.toFixed(2)}${p.liveTrading ? ' (REAL)' : ''}`,
          'info'
        )
      }
    }, 0)
    return () => clearTimeout(t)
  }, [asset, log, meta.base])

  const persist = useCallback(
    (over: Partial<Persisted> = {}) => {
      const r = ref.current
      savePersisted(asset, {
        cashUsd: r.cashUsd,
        position: r.position,
        trades: r.trades.slice(0, TRADE_CAP),
        lastDecidedT: r.lastDecidedT,
        liveTrading: r.config.liveTrading,
        ...over,
      })
    },
    [asset]
  )

  const halt = useCallback(
    (reason: string) => {
      if (loopRef.current) {
        clearInterval(loopRef.current)
        loopRef.current = null
      }
      setEnabled(false)
      setHalted(reason)
      log(`⛔ BOT DETENIDO: ${reason}`, 'error')
    },
    [log]
  )

  const tick = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const { config: cfg } = ref.current
      const p = cfg.params
      let raw: Candle[]
      try {
        raw = await fetchBinanceKlines(meta.symbol, p.interval, warmupBars(p) + 10)
      } catch (e) {
        setDataSource('offline')
        log(`Binance no disponible (${(e as Error).message}) — ciclo omitido, sin precios simulados`, 'warn')
        return
      }
      setDataSource('live')
      const price = raw[raw.length - 1]?.c ?? 0
      setLastPrice(price)
      const closed = closedOnly(raw, p.interval)
      setCandles(closed)

      // mark to market every tick
      const pos = ref.current.position
      const posValue = pos ? pos.qty * sellFill(price, p) * (1 - p.feeRate) : 0
      const equity = ref.current.cashUsd + posValue
      setEquityCurve((c) =>
        [...c, { timestamp: Date.now(), equity, balance: ref.current.cashUsd, openPnl: pos ? posValue - pos.costUsd : 0 }].slice(-500)
      )

      const lastClosed = closed[closed.length - 1]
      if (!lastClosed || lastClosed.t <= ref.current.lastDecidedT) return
      // a NEW candle closed → evaluate the rules once on it
      const d = decide(closed, p, pos)
      ref.current.lastDecidedT = lastClosed.t
      setLastDecision(d.reason)
      if (d.action === 'none') return

      if (d.action === 'hold') {
        if (pos && d.stop !== undefined) {
          const next = { ...pos, stop: d.stop, peakClose: Math.max(pos.peakClose, d.snap.close) }
          ref.current.position = next
          setPosition(next)
        }
        persist()
        return
      }

      if (d.action === 'buy') {
        const sizingEquity = cfg.compound ? equity : Math.min(cfg.capitalUsd, equity)
        const fill = buyFill(price, p)
        let qty = positionSize(sizingEquity, ref.current.cashUsd, fill, d.stop, p)
        if (!(qty > 0)) {
          log(`Señal de compra, pero sin capital para dimensionar (${ref.current.cashUsd.toFixed(2)} USD)`, 'warn')
          return
        }
        let entryPrice = fill
        let costUsd = qty * fill * (1 + p.feeRate)
        let tag = '[demo]'
        if (cfg.liveTrading) {
          const cred = loadCreds('binance')
          if (!cred) return halt('modo real sin claves de Binance')
          const f = await binanceSymbolFilters(meta.symbol)
          if (!f) return halt(`no se pudieron leer los filtros de ${meta.symbol}`)
          qty = Math.floor(qty / f.lot) * f.lot
          if (qty < f.ordermin || qty * price < Math.max(f.costmin, 5)) {
            log(`Señal de compra omitida: ${qty} ${meta.base} (~${(qty * price).toFixed(2)} USD) por debajo del mínimo de Binance`, 'warn')
            return
          }
          try {
            const o = await binanceMarketOrderBase(cred, meta.symbol, 'BUY', qty)
            const feeBase = o.commissions[meta.base] ?? 0
            const feeUsdt = o.commissions.USDT ?? 0
            qty = o.executedQty - feeBase
            entryPrice = o.price
            costUsd = o.executedQuote + feeUsdt
            tag = `[real, orden ${o.orderId}]`
          } catch (e) {
            return halt(`orden BUY ${meta.symbol} rechazada: ${(e as Error).message}`)
          }
        }
        const next: TrendPosition = {
          entryTime: Date.now(),
          entryPrice,
          qty,
          costUsd,
          peakClose: d.snap.close,
          stop: d.stop,
        }
        ref.current.position = next
        ref.current.cashUsd -= costUsd
        setPosition(next)
        setCashUsd(ref.current.cashUsd)
        log(`COMPRA ${qty.toFixed(6)} ${meta.base} @ ${entryPrice.toFixed(2)} (${costUsd.toFixed(2)} USD, stop ${d.stop.toFixed(2)}) ${tag} — ${d.reason}`, 'trade')
        persist()
        return
      }

      // sell
      if (!pos) return
      let exitPrice = sellFill(price, p)
      let proceeds = pos.qty * exitPrice * (1 - p.feeRate)
      let tag = '[demo]'
      if (cfg.liveTrading) {
        const cred = loadCreds('binance')
        if (!cred) return halt('modo real sin claves de Binance')
        const f = await binanceSymbolFilters(meta.symbol)
        if (!f) return halt(`no se pudieron leer los filtros de ${meta.symbol}`)
        // sell what the account really holds, never more
        let held = pos.qty
        try {
          const bal = (await binanceGetBalances(cred)).find((b) => b.symbol === meta.base)
          held = Math.min(pos.qty, bal?.free ?? 0)
        } catch (e) {
          return halt(`no se pudo leer el saldo de ${meta.base}: ${(e as Error).message}`)
        }
        const qty = Math.floor(held / f.lot) * f.lot
        if (qty < f.ordermin) return halt(`saldo de ${meta.base} (${held}) por debajo del mínimo de venta`)
        try {
          const o = await binanceMarketOrderBase(cred, meta.symbol, 'SELL', qty)
          exitPrice = o.price
          proceeds = o.executedQuote - (o.commissions.USDT ?? 0)
          tag = `[real, orden ${o.orderId}]`
        } catch (e) {
          return halt(`orden SELL ${meta.symbol} rechazada: ${(e as Error).message}`)
        }
      }
      const trade: TrendTrade = {
        entryTime: pos.entryTime,
        exitTime: Date.now(),
        entryPrice: pos.entryPrice,
        exitPrice,
        qty: pos.qty,
        pnlUsd: proceeds - pos.costUsd,
        pnlPct: ((proceeds - pos.costUsd) / pos.costUsd) * 100,
        reason: d.reason,
      }
      ref.current.position = null
      ref.current.cashUsd += proceeds
      ref.current.trades = [trade, ...ref.current.trades].slice(0, TRADE_CAP)
      setPosition(null)
      setCashUsd(ref.current.cashUsd)
      setTrades(ref.current.trades)
      log(
        `VENTA ${pos.qty.toFixed(6)} ${meta.base} @ ${exitPrice.toFixed(2)} → ${trade.pnlUsd >= 0 ? '+' : ''}${trade.pnlUsd.toFixed(2)} USD (${trade.pnlPct.toFixed(2)}%) ${tag} — ${d.reason}`,
        trade.pnlUsd >= 0 ? 'trade' : 'warn'
      )
      persist()
    } finally {
      inFlight.current = false
    }
  }, [halt, log, meta.base, meta.symbol, persist])

  const start = useCallback(async () => {
    const cfg = ref.current.config
    if (cfg.liveTrading) {
      const cred = loadCreds('binance')
      if (!cred) {
        halt('modo real sin claves de Binance — guárdalas y verifícalas primero')
        return
      }
      try {
        const usdt = (await binanceGetBalances(cred)).find((b) => b.symbol === 'USDT')?.free ?? 0
        if (!ref.current.position) {
          // the real account is the ledger: cash = real free USDT, capped by
          // the capital the user assigned to this bot
          ref.current.cashUsd = Math.min(usdt, cfg.capitalUsd)
          setCashUsd(ref.current.cashUsd)
        }
        log(`Binance: ${usdt.toFixed(2)} USDT libres; el bot usa hasta ${cfg.capitalUsd.toFixed(2)} USD`, 'info')
      } catch (e) {
        halt(`no se pudo leer el saldo real: ${(e as Error).message}`)
        return
      }
    }
    setHalted(null)
    setEnabled(true)
    log(
      `TENDENCIA ${meta.name} iniciado ${cfg.liveTrading ? 'en MODO REAL' : 'en demo con precios reales'} — velas de ${cfg.params.interval}, ruptura ${cfg.params.entryBars}/${cfg.params.exitBars}, EMA${cfg.params.trendEma}, riesgo ${cfg.params.riskPct}% por operación`,
      'trade'
    )
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => void tick(), TICK_MS)
    void tick()
  }, [halt, log, meta.name, tick])

  const stop = useCallback(() => {
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    setEnabled(false)
    persist()
    log(`Bot detenido${ref.current.position ? ' — la posición abierta se mantiene (no se vende al detener)' : ''}`, 'info')
  }, [log, persist])

  const runBacktest = useCallback(async () => {
    setBtBusy(true)
    try {
      const p = ref.current.config.params
      const c = closedOnly(await fetchBinanceKlines(meta.symbol, p.interval, BACKTEST_BARS), p.interval)
      const r = backtest(c, p, ref.current.config.capitalUsd)
      setBt(r)
      log(
        `Backtest ${meta.symbol} ${p.interval} (${c.length} velas): ${r.returnPct.toFixed(1)}% vs comprar y mantener ${r.buyHoldPct.toFixed(1)}% · caída máx ${r.maxDrawdownPct.toFixed(1)}% · ${r.trades.length} operaciones`,
        'info'
      )
    } catch (e) {
      log(`Backtest fallido: ${(e as Error).message}`, 'error')
    } finally {
      setBtBusy(false)
    }
  }, [log, meta.symbol])

  const updateConfig = useCallback((patch: Partial<TrendConfig>) => {
    setConfig((c) => {
      const next = { ...c, ...patch, params: { ...c.params, ...(patch.params ?? {}) } }
      ref.current.config = next
      return next
    })
    if (patch.capitalUsd !== undefined && !ref.current.enabled && !ref.current.position) {
      ref.current.cashUsd = patch.capitalUsd
      setCashUsd(patch.capitalUsd)
    }
  }, [])

  const resetAccount = useCallback(() => {
    if (ref.current.config.liveTrading && ref.current.position) {
      log('Hay una posición REAL abierta: ciérrala en Binance antes de reiniciar la cuenta', 'error')
      return
    }
    stop()
    ref.current.position = null
    ref.current.trades = []
    ref.current.cashUsd = ref.current.config.capitalUsd
    ref.current.lastDecidedT = 0
    setPosition(null)
    setTrades([])
    setCashUsd(ref.current.config.capitalUsd)
    setEquityCurve([])
    persist({ position: null, trades: [], cashUsd: ref.current.config.capitalUsd, lastDecidedT: 0 })
    log(`Cuenta reiniciada a ${ref.current.config.capitalUsd.toFixed(2)} USD`, 'info')
  }, [log, persist, stop])

  useEffect(() => {
    return () => {
      if (loopRef.current) clearInterval(loopRef.current)
    }
  }, [])

  const posValue = position && lastPrice > 0 ? position.qty * sellFill(lastPrice, config.params) * (1 - config.params.feeRate) : 0
  const wins = trades.filter((t) => t.pnlUsd > 0).length
  const stats: TrendStats = {
    equityUsd: cashUsd + posValue,
    cashUsd,
    positionUsd: posValue,
    realizedPnlUsd: trades.reduce((a, t) => a + t.pnlUsd, 0),
    totalTrades: trades.length,
    wins,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
  }

  return {
    asset,
    meta,
    enabled,
    liveTrading: config.liveTrading,
    config,
    capitalUsd: config.capitalUsd,
    cashUsd,
    position,
    trades,
    logs,
    candles,
    lastPrice,
    lastDecision,
    equityCurve,
    stats,
    backtest: bt,
    backtestBusy: btBusy,
    dataSource,
    halted,
    start,
    stop,
    tick,
    runBacktest,
    updateConfig,
    resetAccount,
    log,
  }
}

export type TrendBot = ReturnType<typeof useTrendBot>
