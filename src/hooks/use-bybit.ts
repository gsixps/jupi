// BYBIT RWA basis-arbitrage bot — CLIENT-SIDE.
//
// Strategy: each xStock (1:1 tokenized US equity, Bybit spot) is paired with
// its TradFi linear perp on the same underlying. When the two quotes diverge,
// the bot opens a market-neutral basis trade —
//
//   perp rich  (basis > 0) → BUY  spot xStock + SELL (short) perp
//   perp cheap (basis < 0) → SELL spot xStock + BUY  (long)  perp
//
// Two modes, same scan loop:
//   • DEMO (default) — REAL prices from Bybit's public V5 tickers with
//     FICTIONAL USD capital. No orders are sent.
//   • REAL — the user pastes Bybit API keys; the bot then sends real spot +
//     linear market orders and the capital is the real USDT balance. Compound
//     interest scales the per-trade budget with the real equity.
//
// In REAL mode a rejected order (exchange minimum, margin, balance) never
// falls back to a simulated fill: the bot stops and reports the reason.

'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  BYBIT_RWA_PAIRS,
  buildRwaRows,
  basisBps,
  fetchBybitRwaPrices,
  type BybitRwaRow,
} from '@/lib/bybit'
import {
  bybitCoinFree,
  bybitGetBalances,
  bybitInstrumentFilters,
  bybitMarketOrder,
  bybitRoundQty,
  bybitRoundQuote,
  bybitUsdtFree,
  loadCreds,
  type ExchangeBalance,
  type ExchangeCredentials,
} from '@/lib/cex'
import type { EquityPoint } from '@/lib/trading-types'

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const LOG_CAP = 120

export interface BybitConfig {
  capitalUsd: number
  budgetPerTradeUsd: number
  maxHoldings: number
  /** Open a trade when |basis| ≥ this many bps. */
  entryBasisBps: number
  /** Close the hedge when the basis has compressed to this many bps. */
  exitBasisBps: number
  stopLossBps: number
  trailingBps: number
  tickIntervalMs: number
  dataMode: 'live' | 'mock'
  compound: boolean
  /** Place real orders with real capital (requires API keys). */
  liveTrading: boolean
}

export const DEFAULT_BYBIT_CONFIG: BybitConfig = {
  capitalUsd: 10000,
  budgetPerTradeUsd: 2000,
  maxHoldings: 5,
  entryBasisBps: 15,
  exitBasisBps: 3,
  stopLossBps: 40,
  trailingBps: 25,
  tickIntervalMs: 10000,
  dataMode: 'live',
  compound: true,
  liveTrading: false,
}

export type HedgeSide = 'perp_rich' | 'perp_cheap'

export interface BybitHolding {
  id: string
  pairId: string
  token: string
  underlying: string
  company: string
  spotSymbol: string
  perpSymbol: string
  /** Which leg is rich at entry — determines the direction of both legs. */
  side: HedgeSide
  spotSide: 'buy' | 'sell'
  perpSide: 'buy' | 'sell'
  /** Signed basis in bps at entry (perp vs spot). */
  entryBasisBps: number
  currentBasisBps: number
  peakBasisBps: number
  notionalUsd: number
  /** Token quantity held on spot (0 when the spot leg was a short). */
  spotQty: number
  /** Perp contract quantity, needed to size the closing (reduceOnly) order. */
  perpQty: number
  status: 'open' | 'closed'
  openedAt: number
  closedAt?: number
  pnlUsd?: number
  /** Order id of the real spot order, when live. */
  realOrderId?: string
  /** Order id of the real perp order, when live. */
  realPerpOrderId?: string
}

export interface BybitTrade {
  id: string
  type: 'open' | 'close'
  token: string
  company: string
  side: HedgeSide
  basisBps: number
  notionalUsd: number
  pnlUsd: number
  reason: string
  createdAt: number
}

export interface BybitStats {
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
  signalsDetected: number
  scanCount: number
  lastScanAt: number
  liveData: boolean
  compound: boolean
  compoundFactor: number
  liveTrading: boolean
}

export interface BybitLogEntry {
  time: number
  msg: string
  level: 'info' | 'warn' | 'error' | 'trade'
}

export interface BybitOpportunity {
  id: string
  pairId: string
  token: string
  company: string
  sector: string
  basisBps: number
  side: HedgeSide
  spotSymbol: string
  perpSymbol: string
  spotUsd: number
  perpUsd: number
  notionalUsd: number
  profitUsd: number
  detectedAt: number
  executed: boolean
}

export interface BybitState {
  enabled: boolean
  config: BybitConfig
  cashUsd: number
  rows: BybitRwaRow[]
  holdings: BybitHolding[]
  trades: BybitTrade[]
  stats: BybitStats | null
  equityCurve: EquityPoint[]
  logs: BybitLogEntry[]
  status: 'idle' | 'scanning' | 'executing' | 'paused'
  priceHistory: Record<string, number[]>
  opps: BybitOpportunity[]
  lastUpdatedAt: number | null
  dataSource: 'live' | 'mock'
  /** Set when the real path had to stop the bot. */
  haltedReason: string | null
}

function initialRows(): BybitRwaRow[] {
  return buildRwaRows(null, DEFAULT_BYBIT_CONFIG.entryBasisBps)
}

/** Expected profit if the basis converges to exitBasisBps on a notional. */
function expectedProfitUsd(notional: number, entryBasisBps: number, exitBasisBps: number): number {
  const converge = Math.abs(entryBasisBps) - exitBasisBps
  if (converge <= 0) return 0
  return (notional * converge) / 10000
}

export function useBybitBot() {
  const [state, setState] = useState<BybitState>(() => {
    const rows = initialRows()
    const priceHistory: Record<string, number[]> = {}
    for (const r of rows) {
      priceHistory[r.spotSymbol] = [r.spotUsd]
      priceHistory[r.perpSymbol] = [r.perpUsd]
    }
    return {
      enabled: false,
      config: { ...DEFAULT_BYBIT_CONFIG },
      cashUsd: DEFAULT_BYBIT_CONFIG.capitalUsd,
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
      haltedReason: null,
    }
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)

  const log = useCallback((msg: string, level: BybitLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[bybit] ${msg}`)
  }, [])

  const halt = useCallback(
    (reason: string) => {
      if (loopRef.current) {
        clearInterval(loopRef.current)
        loopRef.current = null
      }
      setState((s) => ({ ...s, enabled: false, status: 'paused', haltedReason: reason }))
      log(`⛔ Bot detenido: ${reason}`, 'error')
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

      // 1. Prices — real Bybit V5 tickers, deterministic mock as fallback
      let live: Record<string, number> | null = null
      if (cfg.dataMode === 'live') {
        try {
          live = await fetchBybitRwaPrices()
        } catch {
          live = null
        }
      }
      const rows = buildRwaRows(live, cfg.entryBasisBps, now)
      const liveData = !!live && rows.some((r) => r.dataLive)
      const rowByPair = new Map(rows.map((r) => [r.pairId, r]))

      // 2. Price history
      const priceHistory: Record<string, number[]> = {}
      for (const r of rows) {
        for (const sym of [r.spotSymbol, r.perpSymbol]) {
          const arr = [...(s0.priceHistory[sym] ?? []), sym === r.spotSymbol ? r.spotUsd : r.perpUsd]
          if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
          priceHistory[sym] = arr
        }
      }

      // ---- REAL mode: cash is the real USDT balance, and orders are real ----
      const realMode = cfg.liveTrading
      const cred: ExchangeCredentials | null = realMode ? loadCreds('bybit') : null
      if (realMode && !cred) {
        inFlightRef.current = false
        halt('modo real activo sin claves de Bybit válidas')
        return
      }

      let cash = s0.cashUsd
      /** Live wallet snapshot — also used to check spot inventory. */
      let bals: ExchangeBalance[] = []
      if (realMode && cred) {
        bals = await bybitGetBalances(cred)
        const usdtFree = bybitUsdtFree(bals)
        if (usdtFree <= 0) {
          inFlightRef.current = false
          halt('sin saldo USDT libre en la cuenta unificada de Bybit')
          return
        }
        cash = usdtFree
      }

      let holdings = s0.holdings.map((h) => ({ ...h }))
      const trades = [...s0.trades]
      const opps = [...s0.opps]

      // 3. CLOSE hedged positions whose basis converged (or stop / trail)
      for (const h of holdings) {
        if (h.status !== 'open') continue
        const row = rowByPair.get(h.pairId)
        if (!row) continue
        const cur = basisBps(row.spotUsd, row.perpUsd)
        h.currentBasisBps = cur
        h.peakBasisBps = Math.max(h.peakBasisBps, cur)

        let reason: string | null = null
        if (Math.abs(cur) <= cfg.exitBasisBps) {
          reason = `Basis comprimido a ${cur >= 0 ? '+' : ''}${cur}bps`
        } else if (Math.abs(cur) >= h.entryBasisBps + cfg.stopLossBps) {
          reason = `Stop-loss · basis ampliado a ${cur >= 0 ? '+' : ''}${cur}bps`
        } else if (
          cfg.trailingBps > 0 &&
          Math.abs(cur) <= h.peakBasisBps - cfg.trailingBps
        ) {
          reason = `Trailing ${cfg.trailingBps}bps desde pico ${h.peakBasisBps}bps`
        }
        if (!reason) continue

        // P&L: the hedge is market-neutral, so the convergence is the edge.
        // Closed notional × how much the basis moved toward zero.
        const pnl = (h.notionalUsd * (Math.abs(h.entryBasisBps) - Math.abs(cur))) / 10000

        if (realMode && cred) {
          const [spotF, perpF] = await Promise.all([
            bybitInstrumentFilters('spot', h.spotSymbol),
            bybitInstrumentFilters('linear', h.perpSymbol),
          ])
          // Close the hedge first: closing spot first would leave the perp naked
          // for a moment. reduceOnly makes sure it can never open a reverse leg.
          const perpQty = bybitRoundQty(Math.abs(h.perpQty), perpF)
          if (perpQty > 0) {
            const perpClose = await bybitMarketOrder({
              cred,
              category: 'linear',
              symbol: h.perpSymbol,
              side: h.perpSide === 'buy' ? 'Sell' : 'Buy',
              qty: perpQty,
              reduceOnly: true,
            })
            if (perpClose.executedQty <= 0) {
              halt(
                `cierre de ${h.token}: la pata perp ${perpClose.side} ${h.perpSymbol} no fills (orden ${perpClose.orderId})`
              )
              return
            }
          }
          if (h.spotSide === 'buy') {
            const spotClose = await bybitMarketOrder({
              cred,
              category: 'spot',
              symbol: h.spotSymbol,
              side: 'Sell',
              qty: bybitRoundQty(h.spotQty, spotF),
              marketUnit: 'baseCoin',
            })
            if (spotClose.executedQty <= 0) {
              halt(
                `cierre de ${h.token}: la pata spot SELL ${h.spotSymbol} no fills (orden ${spotClose.orderId})`
              )
              return
            }
          } else {
            // Re-buy the spot that was sold to open the hedge.
            const spotClose = await bybitMarketOrder({
              cred,
              category: 'spot',
              symbol: h.spotSymbol,
              side: 'Buy',
              qty: bybitRoundQuote(h.notionalUsd, spotF),
              marketUnit: 'quoteCoin',
            })
            if (spotClose.executedQty <= 0) {
              halt(
                `cierre de ${h.token}: la pata spot BUY ${h.spotSymbol} no fills (orden ${spotClose.orderId})`
              )
              return
            }
          }
          const bals2 = await bybitGetBalances(cred)
          cash = bybitUsdtFree(bals2)
        }

        h.status = 'closed'
        h.closedAt = now
        h.pnlUsd = pnl
        if (realMode) cash += pnl
        trades.unshift({
          id: `byt_${now}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'close',
          token: h.token,
          company: h.company,
          side: h.side,
          basisBps: cur,
          notionalUsd: h.notionalUsd,
          pnlUsd: pnl,
          reason,
          createdAt: now,
        })
        log(
          `CERRADO ${h.token} (${h.company}) · basis ${cur >= 0 ? '+' : ''}${cur}bps — P&L ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD · ${reason}`,
          'trade'
        )
        if (cfg.compound) {
          log(
            `⚡ Interés compuesto: capital disponible → ${fmtUsd(cash, 2)} USD`,
            'info'
          )
        }
      }

      // 4. OPEN hedged positions on wide bases (compound-scaled budget)
      const openBefore = holdings.filter((h) => h.status === 'open')
      const investedBefore = openBefore.reduce((a, h) => a + h.notionalUsd, 0)
      const equityBefore = cash + investedBefore
      const compoundFactor = cfg.compound
        ? Math.max(equityBefore, 1) / Math.max(cfg.capitalUsd, 1)
        : 1
      let opened = 0

      for (const r of rows) {
        if (openBefore.length + opened >= cfg.maxHoldings) break
        if (!r.tradable) continue
        if (holdings.some((h) => h.status === 'open' && h.pairId === r.pairId)) continue

        const notional = Math.min(cfg.budgetPerTradeUsd * compoundFactor, cash)
        if (notional < 0.01) continue
        // The real per-symbol minimum is checked further down, once the
        // instrument filters for this pair are known.

        const perpRich = r.basisBps > 0
        const spotSide: 'buy' | 'sell' = perpRich ? 'buy' : 'sell'
        const perpSide: 'buy' | 'sell' = perpRich ? 'sell' : 'buy'
        const spotQty = notional / r.spotUsd
        // Demo sizing; replaced by the real fill in live mode.
        let bookedSpotQty = spotQty
        let bookedPerpQty = notional / r.perpUsd
        let bookedOrderId: string | undefined
        let bookedPerpOrderId: string | undefined

        if (realMode && cred) {
          // Real exchange filters, not a hardcoded guess: xStocks spot and the
          // TradFi perps publish different lot/precision fields.
          const [spotF, perpF] = await Promise.all([
            bybitInstrumentFilters('spot', r.spotSymbol),
            bybitInstrumentFilters('linear', r.perpSymbol),
          ])

          const minNotional = Math.max(spotF.minOrderValueUsd, perpF.minOrderValueUsd)
          if (minNotional > 0 && notional < minNotional) {
            log(
              `Omitido ${r.token}: ${fmtUsd(notional, 2)} USD < mínimo real de Bybit (${fmtUsd(minNotional, 2)} USD)`,
              'warn'
            )
            continue
          }

          // A "sell spot / buy perp" leg needs spot inventory up front. Without
          // it the spot sell would be rejected, so verify the balance before
          // touching the market and skip the pair instead of getting naked.
          let spotInventory = Infinity
          if (spotSide === 'sell') {
            spotInventory = bybitCoinFree(bals, r.token)
            const needed = bybitRoundQty(spotQty, spotF)
            if (needed <= 0 || spotInventory < needed) {
              log(
                `Omitido ${r.token}: la pata spot necesita ${needed} ${r.token} y la cuenta tiene ${spotInventory.toFixed(4)} (basis negativo requiere inventario spot)`,
                'warn'
              )
              continue
            }
          }

          const perpQty = bybitRoundQty(notional / r.perpUsd, perpF)
          if (perpQty < (perpF.minOrderQty || 0)) {            log(
              `Omitido ${r.token}: ${perpQty} ${r.token} por debajo del mínimo de ${r.perpSymbol} (${perpF.minOrderQty})`,
              'warn'
            )
            continue
          }

          const spotOrder = await bybitMarketOrder({
            cred,
            category: 'spot',
            symbol: r.spotSymbol,
            side: spotSide === 'buy' ? 'Buy' : 'Sell',
            // `quoteCoin` means the qty is a USDT amount — a base quantity
            // there would buy a fraction of the intended size.
            qty:
              spotSide === 'buy'
                ? bybitRoundQuote(notional, spotF)
                : bybitRoundQty(spotQty, spotF),
            marketUnit: spotSide === 'buy' ? 'quoteCoin' : 'baseCoin',
          })
          if (spotOrder.executedQty <= 0) {
            halt(
              `la pata spot ${spotOrder.side} ${r.spotSymbol} no fills (orden ${spotOrder.orderId})`
            )
            return
          }
          // Every filled unit carries risk: the perp is the hedge, so it must
          // come in with a confirmed fill or the spot leg stays naked.
          const perpOrder = await bybitMarketOrder({
            cred,
            category: 'linear',
            symbol: r.perpSymbol,
            side: perpSide === 'buy' ? 'Buy' : 'Sell',
            qty: perpQty,
          })
          if (perpOrder.executedQty <= 0) {
            halt(
              `la pata perp ${perpOrder.side} ${r.perpSymbol} no fills (orden ${perpOrder.orderId}); la pata spot quedó sin cobertura`
            )
            return
          }
          const bals2 = await bybitGetBalances(cred)
          cash = bybitUsdtFree(bals2)
          // Book only what actually filled.
          bookedSpotQty =
            spotSide === 'buy' ? spotOrder.executedQty / (spotOrder.price || 1) : 0
          bookedPerpQty = perpOrder.executedQty
          bookedOrderId = spotOrder.orderId
          bookedPerpOrderId = perpOrder.orderId
          log(
            `REAL ${spotSide === 'buy' ? 'BUY' : 'SELL'} ${r.spotSymbol} ${spotOrder.executedQty} @ ${spotOrder.price.toFixed(4)} + ${perpSide === 'buy' ? 'BUY' : 'SELL'} ${r.perpSymbol} ${perpOrder.executedQty} @ ${perpOrder.price.toFixed(4)} · basis ${r.basisBps >= 0 ? '+' : ''}${r.basisBps}bps`,
            'trade'
          )
        } else {
          cash -= notional
          log(
            `ABIERTO ${r.token} (${r.company}) · ${spotSide === 'buy' ? 'COMPRA' : 'VENTA'} spot + ${perpSide === 'buy' ? 'COMPRA' : 'VENTA'} perp · basis ${r.basisBps >= 0 ? '+' : ''}${r.basisBps}bps · ${fmtUsd(notional, 2)} USD`,
            'trade'
          )
        }

        holdings.unshift({
          id: `byh_${now}_${Math.random().toString(36).slice(2, 6)}`,
          pairId: r.pairId,
          token: r.token,
          underlying: r.underlying,
          company: r.company,
          spotSymbol: r.spotSymbol,
          perpSymbol: r.perpSymbol,
          side: perpRich ? 'perp_rich' : 'perp_cheap',
          spotSide,
          perpSide,
          entryBasisBps: r.basisBps,
          currentBasisBps: r.basisBps,
          peakBasisBps: r.basisBps,
          notionalUsd: notional,
          spotQty: bookedSpotQty,
          perpQty: bookedPerpQty,
          status: 'open',
          openedAt: now,
          realOrderId: bookedOrderId,
          realPerpOrderId: bookedPerpOrderId,
        })
        trades.unshift({
          id: `byt_${now}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'open',
          token: r.token,
          company: r.company,
          side: perpRich ? 'perp_rich' : 'perp_cheap',
          basisBps: r.basisBps,
          notionalUsd: notional,
          pnlUsd: 0,
          reason:
            perpRich
              ? `Basis ${r.basisBps}bps · perp rico → compra spot + venta perp`
              : `Basis ${r.basisBps}bps · perp barato → venta spot + compra perp`,
          createdAt: now,
        })
        opps.unshift({
          id: `byo_${now}_${Math.random().toString(36).slice(2, 6)}`,
          pairId: r.pairId,
          token: r.token,
          company: r.company,
          sector: r.sector,
          basisBps: r.basisBps,
          side: perpRich ? 'perp_rich' : 'perp_cheap',
          spotSymbol: r.spotSymbol,
          perpSymbol: r.perpSymbol,
          spotUsd: r.spotUsd,
          perpUsd: r.perpUsd,
          notionalUsd: notional,
          profitUsd: expectedProfitUsd(notional, r.basisBps, cfg.exitBasisBps),
          detectedAt: now,
          executed: true,
        })
        opened++
      }

      // 5. Stats
      const open = holdings.filter((h) => h.status === 'open')
      const invested = open.reduce((a, h) => a + h.notionalUsd, 0)
      const equity = realMode ? cash + invested : cash + invested
      const closed = holdings.filter((h) => h.status === 'closed')
      const realized = closed.reduce((a, h) => a + (h.pnlUsd ?? 0), 0)
      const wins = closed.filter((h) => (h.pnlUsd ?? 0) >= 0).length
      const total = closed.length
      const prevStats = stateRef.current.stats
      const stats: BybitStats = {
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
        signalsDetected: opps.length,
        scanCount: (prevStats?.scanCount ?? 0) + 1,
        lastScanAt: now,
        liveData,
        compound: cfg.compound,
        compoundFactor,
        liveTrading: cfg.liveTrading,
      }
      const eqPoint: EquityPoint = {
        timestamp: now,
        equity,
        balance: cash,
        openPnl: 0,
      }

      setState((s) => ({
        ...s,
        cashUsd: cash,
        rows,
        holdings,
        trades: trades.slice(0, TRADE_CAP),
        opps: [...opps, ...s.opps].slice(0, TRADE_CAP),
        stats,
        equityCurve: [...s.equityCurve, eqPoint].slice(-200),
        status: 'scanning',
        dataSource: liveData ? 'live' : 'mock',
        priceHistory,
        lastUpdatedAt: now,
        haltedReason: null,
      }))
    } catch (e) {
      // A real-money failure must stop the bot rather than be retried blindly.
      if (stateRef.current.config.liveTrading) halt(`error de scan: ${(e as Error).message}`)
      else log(`error de scan: ${(e as Error).message}`, 'error')
    } finally {
      inFlightRef.current = false
    }
  }, [halt, log])

  const start = useCallback(() => {
    const cfg = stateRef.current.config
    if (cfg.liveTrading && !loadCreds('bybit')) {
      halt('modo live sin credenciales de Bybit — configura la API key y el secret')
      return
    }
    setState((s) => ({ ...s, enabled: true, status: 'scanning', haltedReason: null }))
    log(
      cfg.liveTrading
        ? 'BYBIT RWA BOT iniciado en MODO LIVE — basis arb spot+perp con órdenes reales'
        : 'BYBIT RWA BOT iniciado — basis arb spot+perp en modo demo',
      'trade'
    )
    if (loopRef.current) clearInterval(loopRef.current)
    const ms = Math.max(3000, cfg.tickIntervalMs)
    loopRef.current = setInterval(() => {
      void scan()
    }, ms)
    void scan()
  }, [scan, log, halt])

  const stop = useCallback(() => {
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    setState((s) => ({ ...s, enabled: false, status: 'idle' }))
  }, [])

  const updateConfig = useCallback((patch: Partial<BybitConfig>) => {
    setState((s) => {
      // Interest compounding is mandatory: the patch can never turn it off.
      const next = { ...s.config, ...patch, compound: true }
      if (patch.capitalUsd !== undefined && !s.enabled && !s.config.liveTrading) {
        return { ...s, config: next, cashUsd: patch.capitalUsd }
      }
      return { ...s, config: next }
    })
  }, [])

  const resetAccount = useCallback(() => {
    stop()
    setState((s) => ({
      ...s,
      cashUsd: s.config.capitalUsd,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      opps: [],
      status: 'idle',
      haltedReason: null,
    }))
    log('Cuenta reiniciada')
  }, [log, stop])

  useEffect(() => {
    return () => {
      if (loopRef.current) clearInterval(loopRef.current)
    }
  }, [])

  return {
    ...state,
    scanCount: state.stats?.scanCount ?? 0,
    pairs: BYBIT_RWA_PAIRS,
    start,
    stop,
    scan: () => scan(),
    updateConfig,
    resetAccount,
    log,
  }
}

function fmtUsd(n: number, d = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

export type BybitBot = ReturnType<typeof useBybitBot>
