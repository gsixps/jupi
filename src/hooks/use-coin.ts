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
import {
  binanceGetBalances,
  binanceMarketOrder,
  binanceMinNotional,
  loadCreds,
  type ExchangeCredentials,
} from '@/lib/cex'

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
  /** LIVE only: base quantity actually filled on Binance. */
  realQty?: number
  /** LIVE only: quote amount actually paid (BUY) or received (SELL). */
  realQuoteUsd?: number
  /** LIVE only: real Binance order ids, for reconciliation. */
  realOrderId?: string
  realExitOrderId?: string
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
  /**
   * LIVE safety latch. A rejected real order (no funds, below the symbol
   * minimum, API error) stops the bot and records why. It never falls back to
   * the simulated engine while real money is at stake.
   */
  halted: boolean
  haltReason: string | null
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
      halted: false,
      haltReason: null,
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

  /**
   * Stop the bot and surface why. Triggered whenever a REAL order path fails:
   * with real money we halt and warn rather than keep simulating.
   */
  const halt = useCallback(
    (reason: string) => {
      if (loopRef.current) {
        clearInterval(loopRef.current)
        loopRef.current = null
      }
      setState((s) => ({
        ...s,
        enabled: false,
        halted: true,
        haltReason: reason,
        status: 'paused',
        stats: s.stats ? { ...s.stats, running: false } : s.stats,
      }))
      log(`⛔ BOT DETENIDO (live): ${reason}`, 'error')
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
      // LIVE: only USDT-quoted pairs are tradable. The bot mirrors the real
      // USDT balance, so buying on a FDUSD/USDC pair would spend an asset whose
      // inventory was never checked, and selling on one would credit cash the
      // account may not hold.
      const tradable = s0.liveTrading ? rows.filter((r) => r.quote === 'USDT') : rows
      let cheapest = tradable[0]
      let dearest = tradable[0]
      if (!cheapest || !dearest) {
        log(`${symbol}: sin pares cotizados en USDT — se omite el trading en live`, 'warn')
        return
      }
      for (const r of tradable) {
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

      // LIVE: mirror the real USDT balance so `cash` matches the exchange.
      let cred: ExchangeCredentials | null = null
      let realTrades = 0
      if (s0.liveTrading) {
        cred = loadCreds('binance')
        if (!cred || !cred.apiKey || !cred.apiSecret) {
          halt('faltan credenciales de Binance (API key + secret)')
          return
        }
        try {
          const bals = await binanceGetBalances(cred)
          const usdt = bals.find((b) => b.symbol === 'USDT')
          if (!usdt) {
            halt('la cuenta de Binance no tiene saldo en USDT')
            return
          }
          cash = usdt.free
        } catch (e) {
          halt(`no se pudo leer el saldo real: ${(e as Error).message}`)
          return
        }
      }

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
          // LIVE: sell the base quantity actually filled, on the dearest pair
          // (the exit leg of the real cross-pair arb).
          if (s0.liveTrading && cred) {
            const qty = h.realQty ?? 0
            if (!(qty > 0)) {
              halt(`posición ${symbol} sin cantidad real registrada; no se puede cerrar`)
              return
            }
            // Inventory check: never send a sell for coins the account does not
            // actually hold (manual withdrawals, previous page reload, etc).
            let freeBase = 0
            try {
              const bals = await binanceGetBalances(cred)
              freeBase = bals.find((b) => b.symbol === symbol)?.free ?? 0
            } catch (e) {
              halt(`no se pudo verificar el inventario de ${symbol}: ${(e as Error).message}`)
              return
            }
            if (freeBase + 1e-12 < qty) {
              halt(
                `inventario insuficiente de ${symbol}: la cuenta tiene ${freeBase} y la posición necesita ${qty}`
              )
              return
            }
            let order
            try {
              order = await binanceMarketOrder({
                cred,
                symbol: dearest.symbol,
                side: 'SELL',
                sellBaseQty: qty,
              })
            } catch (e) {
              halt(`orden SELL ${dearest.symbol} rechazada: ${(e as Error).message}`)
              return
            }
            if (order.executedQty <= 0) {
              halt(`orden SELL ${dearest.symbol} sin fills (${order.orderId})`)
              return
            }
            const proceeds = order.executedQuote
            const sellPrice = order.price
            const pnl = proceeds - (h.realQuoteUsd ?? h.buyPriceUsd * h.qty)
            const pnlBps = Math.round((pnl / Math.max(h.realQuoteUsd ?? 1, 1e-9)) * 10000)
            h.status = 'sold'
            h.soldAt = now
            h.sellPriceUsd = sellPrice
            h.sellPair = dearest.symbol
            h.pnlUsd = pnl
            h.realExitOrderId = order.orderId
            h.realQuoteUsd = proceeds
            cash += proceeds
            realTrades++
            trades.unshift({
              id: `cot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'sell',
              symbol,
              qty: order.executedQty,
              priceUsd: sellPrice,
              pair: dearest.symbol,
              notionalUsd: proceeds,
              pnlUsd: pnl,
              profitBps: pnlBps,
              reason: `${reason} (real)`,
              status: 'filled',
              createdAt: now,
            })
            log(
              `LIVE SELL ${order.executedQty} ${symbol} @ ${sellPrice.toFixed(2)} USD en ${dearest.symbol} → ${fmtUsdCoin(proceeds, 2)} USD (${pnl >= 0 ? '+' : ''}${fmtUsdCoin(pnl, 2)})`,
              'trade'
            )
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdCoin(cash, 2)} USD (P&L real ${pnl >= 0 ? '+' : ''}${fmtUsdCoin(pnl, 2)})`,
              'info'
            )
            continue
          }

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
          // LIVE: buy on the cheapest real pair first; the simulated lot below
          // is only created from the actual fill.
          if (s0.liveTrading && cred) {
            const pair = cheapest.symbol
            const minNotional = await binanceMinNotional(pair).catch(() => 0)
            if (minNotional > 0 && afford < minNotional) {
              log(
                `⏭ ${symbol}: ${fmtUsdCoin(afford, 2)} USD < mínimo de Binance (${fmtUsdCoin(minNotional, 2)}) en ${pair} — se omite esta señal`,
                'warn'
              )
            } else {
              let order
              try {
                order = await binanceMarketOrder({
                  cred,
                  symbol: pair,
                  side: 'BUY',
                  buyQuoteUsd: afford,
                })
              } catch (e) {
                halt(`orden BUY ${pair} rechazada: ${(e as Error).message}`)
                return
              }
              if (order.executedQty <= 0) {
                halt(`orden BUY ${pair} sin fills (${order.orderId})`)
                return
              }
              const spent = order.executedQuote
              holdings.unshift({
                id: `coh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                qty: order.executedQty,
                buyPriceUsd: order.price,
                buyPair: pair,
                currentPriceUsd: order.price,
                peakPriceUsd: order.price,
                status: 'open',
                boughtAt: now,
                realQty: order.executedQty,
                realQuoteUsd: spent,
                realOrderId: order.orderId,
              })
              trades.unshift({
                id: `cot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: 'buy',
                symbol,
                qty: order.executedQty,
                priceUsd: order.price,
                pair,
                notionalUsd: spent,
                pnlUsd: 0,
                profitBps: spreadBps,
                reason: `Comprando barato en ${pair} @ ${order.price.toFixed(2)} (spread ${spreadBps}bps) [real]`,
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
              cash -= spent
              buys++
              realTrades++
              log(
                `LIVE BUY ${order.executedQty} ${symbol} en ${pair} @ ${order.price.toFixed(2)} USD — ${fmtUsdCoin(spent, 2)} USD (spread ${spreadBps}bps)`,
                'trade'
              )
            }
          } else {
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
      }

      // 4b. LIVE: re-read the real balance after trading so the displayed
      // cash/equity is the exchange truth, not an approximation of the fills.
      if (s0.liveTrading && cred && realTrades > 0) {
        try {
          const bals = await binanceGetBalances(cred)
          const usdt = bals.find((b) => b.symbol === 'USDT')
          if (usdt) cash = usdt.free
        } catch (e) {
          halt(`no se pudo reconciliar el saldo tras operar: ${(e as Error).message}`)
          return
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
    const s0 = stateRef.current
    if (s0.liveTrading) {
      const c = loadCreds('binance')
      if (!c || !c.apiKey || !c.apiSecret) {
        halt('modo live sin credenciales de Binance — configura la API key y el secret')
        return
      }
    }
    setState((s) => ({
      ...s,
      enabled: true,
      halted: false,
      haltReason: null,
      status: 'scanning',
      stats: s.stats ? { ...s.stats, running: true } : s.stats,
    }))
    log(
      s0.liveTrading
        ? `BOT ${symbol.toUpperCase()} iniciado en MODO LIVE — cross-pair accumulation con órdenes reales en ${s0.capitalUsd.toFixed(2)} USD`
        : `BOT ${symbol.toUpperCase()} iniciado — ${s0.capitalUsd.toFixed(2)} USD ficticios, cross-pair accumulation`,
      'trade'
    )
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => {
      scan().catch((e) => {
        if (stateRef.current.liveTrading) halt(`error inesperado: ${e.message}`)
        else log(`Scan error: ${e.message}`, 'error')
      })
    }, s0.tickIntervalMs)
  }, [scan, log, symbol, halt])

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
      halted: false,
      haltReason: null,
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
        'liveTrading',
      ]
      const next: Partial<CoinState> = {}
      for (const k of allowed) {
        if ((patch as Record<string, unknown>)[k] !== undefined) {
          ;(next as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k]
        }
      }
      // Interest compounding is mandatory: the patch can never turn it off.
      return { ...s, ...next, compound: true }
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
    halt,
  }
}

function fmtUsdCoin(n: number, d = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

export type CoinBot = ReturnType<typeof useCoinBot>