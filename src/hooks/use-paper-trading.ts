// PAPER trading bot — CLIENT-SIDE, REAL market data.
//
// The capital is FICTIONAL (default $1000, configurable), but every price
// quote, every swap rate, and every P&L calculation comes from REAL Jupiter
// API data fetched directly in the browser (which CAN reach api.jup.ag).
// No on-chain swaps are executed — we record what WOULD have happened at the
// real market price. This is honest paper trading: the win rate and P&L
// reflect real market conditions.
//
// The bot runs entirely in the browser (no socket, no engine dependency).
// The Start button works locally.

"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import "../lib/polyfills"
import { useWallet } from "./use-wallet"
import { VERIFIED_TOKENS, USDC_MINT, SOL_MINT } from "@/lib/tokens"
import { fetchRealQuote } from "@/lib/jupiter-swap"
import type { TokenInfo, Trade, Position, BotStats, EquityPoint, BotConfig, ArbitrageOpportunity } from "@/lib/trading-types"
import { DEFAULT_CONFIG } from "@/lib/trading-types"
import { computeSMA, meanReversionSignal, shouldClosePosition, buildArbCycles } from "@/lib/strategy"
import { fromBaseAmount, toBaseAmount } from "@/lib/tokens"

const PRICE_HISTORY_CAP = 60
const TRADE_CAP = 200
const ARB_CAP = 50

interface PaperTrade extends Trade {
  realQuote?: boolean
  // Compatible with LiveTrade so LiveTradeFeed can render paper trades.
  status: "confirmed" | "failed" | "pending"
  signature?: string
}

export interface PaperTradingState {
  enabled: boolean
  config: BotConfig
  prices: Record<string, number>
  change24h: Record<string, number>
  priceHistory: Record<string, number[]>
  positions: Position[]
  trades: PaperTrade[]
  arbitrage: ArbitrageOpportunity[]
  stats: BotStats | null
  equityCurve: EquityPoint[]
  logs: { time: number; msg: string; level: "info" | "warn" | "error" | "trade" }[]
  status: "idle" | "scanning" | "executing" | "paused"
  error: string | null
  balance: number
  capital: number
}

export function usePaperTrading() {
  const [state, setState] = useState<PaperTradingState>({
    enabled: false,
    config: {
      ...DEFAULT_CONFIG,
      capital: 1000,
      maxPositions: 6,
      tradeSizePct: 15,
      // Same thresholds as the live bot: a demo result is what live would do.
      buyThreshold: 0.7,
      sellThreshold: 1.0,
      stopLossPct: 2.5,
      arbMinProfitBps: 20,
      slippageBps: 100,
      scanIntervalMs: 4000,
      tokens: VERIFIED_TOKENS.filter((t) => !t.stable).map((t) => t.mint),
    },
    prices: {},
    change24h: {},
    priceHistory: {},
    positions: [],
    trades: [],
    arbitrage: [],
    stats: null,
    equityCurve: [],
    logs: [],
    status: "idle",
    error: null,
    balance: 1000,
    capital: 1000,
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tokensRef = useRef<TokenInfo[]>(VERIFIED_TOKENS)
  const lastScanRef = useRef(0)
  const inFlightRef = useRef(false)

  const log = useCallback((msg: string, level: "info" | "warn" | "error" | "trade" = "info") => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, 100),
    }))
    console[level === "trade" ? "log" : level](`[paper-bot] ${msg}`)
  }, [])

  // track price-fetch failure state so we only log the transition (not every
  // failed scan, which would spam the console during transient outages).
  const priceFetchFailedRef = useRef(false)

  // ---- fetch REAL prices: Jupiter direct first, then the /api/prices proxy ----
  // Jupiter direct (from the browser) works on the user's machine and gives
  // real DEX prices that MOVE (frequent updates) → the bot trades on real
  // market movements. If the browser can't reach Jupiter (sandbox), fall back
  // to the /api/prices server-side proxy which fetches CoinGecko (real prices,
  // slower cache). NO perturbation — these are exact real market prices.
  const fetchRealPrices = useCallback(
    async (mints: string[]): Promise<{ prices: Record<string, number>; change: Record<string, number> }> => {
      const prices: Record<string, number> = { [USDC_MINT]: 1 }
      const change: Record<string, number> = {}
      if (mints.length === 0) return { prices, change }
      const ids = mints.filter((m) => m !== USDC_MINT).join(",")

      // 1) Try Jupiter direct (browser → api.jup.ag/price/v3). Works on user's machine.
      if (ids) {
        try {
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), 3000)
          const res = await fetch(
            `https://api.jup.ag/price/v3?ids=${encodeURIComponent(ids)}&vsToken=USDC`,
            { cache: "no-store" as any, signal: ctrl.signal }
          )
          clearTimeout(t)
          if (res.ok) {
            const j = (await res.json()) as Record<
              string,
              { usdPrice?: number; priceChange24h?: number }
            >
            for (const [mint, entry] of Object.entries(j)) {
              if (typeof entry.usdPrice === "number" && entry.usdPrice > 0) prices[mint] = entry.usdPrice
              if (typeof entry.priceChange24h === "number") change[mint] = entry.priceChange24h
            }
          }
        } catch {
          // browser can't reach Jupiter — fall through to proxy (expected in sandbox)
        }
      }

      // 2) Fallback: server-side /api/prices proxy (Jupiter → CoinGecko), with retry.
      const missing = mints.filter((m) => m !== USDC_MINT && !prices[m])
      if (missing.length > 0) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const ctrl = new AbortController()
            const t = setTimeout(() => ctrl.abort(), 6000)
            const res = await fetch(
              `/api/prices?mints=${encodeURIComponent(missing.join(","))}`,
              { cache: "no-store" as any, signal: ctrl.signal }
            )
            clearTimeout(t)
            if (res.ok) {
              const j = (await res.json()) as {
                prices: Record<string, number>
                change?: Record<string, number>
              }
              if (j.prices) {
                for (const [mint, p] of Object.entries(j.prices)) {
                  if (typeof p === "number" && p > 0 && !prices[mint]) prices[mint] = p
                }
              }
              if (j.change) {
                for (const [mint, c] of Object.entries(j.change)) {
                  if (typeof c === "number" && !change[mint]) change[mint] = c
                }
              }
              break // success
            }
          } catch {
            // retry once
            if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          }
        }
      }

      // only log the TRANSITION to/from failure (not every scan)
      const realPrices = Object.keys(prices).filter((m) => prices[m] !== 1).length
      if (realPrices === 0) {
        if (!priceFetchFailedRef.current) {
          priceFetchFailedRef.current = true
          log("Price fetch failed — retrying (transient outage or compiling)", "warn")
        }
      } else {
        if (priceFetchFailedRef.current) {
          priceFetchFailedRef.current = false
          log("Price fetch recovered", "info")
        }
      }
      return { prices, change }
    },
    [log]
  )

  // ---- fetch a REAL swap quote (Jupiter), with a computed fallback ----
  // If Jupiter Quote API is unreachable (sandbox DNS), compute a quote from
  // the real price map + realistic slippage so the bot can still paper-trade.
  // On the user's machine, Jupiter is used directly (fully real).
  const fetchQuoteReal = useCallback(
    async (
      inputMint: string,
      outputMint: string,
      uiAmount: number,
      slippageBps: number,
      tokens: TokenInfo[]
    ): Promise<{ outAmount: number; outHuman: number; labels: string[]; outPerIn: number } | null> => {
      // Try real Jupiter quote first.
      const q = await fetchRealQuote(inputMint, outputMint, uiAmount, slippageBps, tokens)
      if (q && q.outAmount > 0) {
        const inTok = tokens.find((t) => t.mint === inputMint)
        const outTok = tokens.find((t) => t.mint === outputMint)
        const outHuman = outTok ? q.outAmount / Math.pow(10, outTok.decimals) : q.outAmount
        const inHuman = inTok ? (q.inAmount || 0) / Math.pow(10, inTok.decimals) : uiAmount
        return {
          outAmount: q.outAmount,
          outHuman,
          labels: q.labels.length ? q.labels : ["Jupiter"],
          outPerIn: q.outPerIn,
        }
      }
      // Fallback: compute from the real price map (caller passes prices).
      return null
    },
    []
  )

  // Helper: try real Jupiter quote; if unreachable, compute from the REAL price
  // ratio + slippage. The computed fallback is "real price, estimated execution"
  // — used only when Jupiter Quote API is unreachable (sandbox DNS). On the
  // user's machine, real Jupiter quotes are used.
  const getQuote = useCallback(
    async (
      inputMint: string,
      outputMint: string,
      uiAmount: number,
      slippageBps: number,
      tokens: TokenInfo[],
      prices: Record<string, number>
    ): Promise<{ outAmount: number; outHuman: number; labels: string[]; outPerIn: number } | null> => {
      const real = await fetchQuoteReal(inputMint, outputMint, uiAmount, slippageBps, tokens)
      if (real) return real
      // No computed fallback: a fill the market did not quote is not a fill.
      void tokens
      void prices
      return null
    },
    [fetchQuoteReal]
  )

  // ---- the bot scan (REAL data, paper execution) ----
  const scan = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const s0 = stateRef.current
      if (!s0.enabled) {
        inFlightRef.current = false
        return
      }
      setState((s) => ({ ...s, status: "scanning" }))
      lastScanRef.current = Date.now()

      const tokens = tokensRef.current
      const mints = s0.config.tokens

      // 1. fetch REAL prices
      const { prices, change } = await fetchRealPrices(mints)
      const newPriceHistory = { ...s0.priceHistory }
      // REAL prices only. The old "intraday tick perturbation" added random
      // noise (±2.5%) to every price so the mean-reversion strategy had dips
      // to buy — trading on invented moves. Signals now see the market as is.
      const tickPrices: Record<string, number> = { ...prices }
      for (const m of mints) {
        const p = prices[m]
        if (typeof p !== "number" || p <= 0) continue
        const arr = [...(newPriceHistory[m] ?? []), p]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        newPriceHistory[m] = arr
      }
      setState((s) => ({ ...s, prices: tickPrices, change24h: change, priceHistory: newPriceHistory }))

      const balance = stateRef.current.balance

      // 2. mean reversion per token (paper execution at REAL price)
      for (const mint of mints) {
        const hist = newPriceHistory[mint]
        if (!hist || hist.length < 3) continue
        const tok = tokens.find((t) => t.mint === mint)
        if (!tok) continue
        const currentPrice = hist[hist.length - 1]
        const existingPos = stateRef.current.positions.find((p) => p.mint === mint)

        if (existingPos) {
          // check close
          const closeCheck = shouldClosePosition(existingPos, currentPrice, {
            sellThreshold: s0.config.sellThreshold,
            stopLossPct: s0.config.stopLossPct,
          })
          if (closeCheck.action) {
            // PAPER SELL at REAL Jupiter quote
            const q = await getQuote(mint, USDC_MINT, existingPos.amount, s0.config.slippageBps, tokens, tickPrices)
            if (!q) {
              log(`SELL quote failed for ${tok.symbol}`, "error")
              continue
            }
            setState((s) => ({ ...s, status: "executing" }))
            // REAL outAmount from Jupiter → real USD received
            const realOutUsd = q.outAmount / Math.pow(10, 6) // USDC 6 decimals
            const pnl = realOutUsd - existingPos.costUsd
            const pnlPct = (pnl / existingPos.costUsd) * 100
            const trade: PaperTrade = {
              id: `pt_${Date.now()}`,
              strategy: "mean_reversion",
              side: "SELL",
              inputMint: mint,
              outputMint: USDC_MINT,
              inputSymbol: tok.symbol,
              outputSymbol: "USDC",
              inputAmount: existingPos.amount,
              outputAmount: realOutUsd,
              entryPrice: existingPos.entryPrice,
              exitPrice: currentPrice,
              pnl,
              pnlPct,
              win: pnl > 0,
              route: q.labels.length ? q.labels : [`${tok.symbol}->USDC`],
              reason: closeCheck.reason,
              openedAt: existingPos.openedAt,
              closedAt: Date.now(),
              realQuote: true,
              status: "confirmed",
            }
            setState((s) => ({
              ...s,
              balance: s.balance + realOutUsd,
              positions: s.positions.filter((p) => p.mint !== mint),
              trades: [trade, ...s.trades].slice(0, TRADE_CAP),
            }))
            log(`${pnl >= 0 ? "✅" : "❌"} PAPER-SELL ${tok.symbol} @ real $${currentPrice.toFixed(4)} → $${realOutUsd.toFixed(2)} USDC. PnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(3)} (${pnlPct.toFixed(2)}%)`, "trade")
            break // one trade per scan
          }
        } else {
          // check buy
          const signal = meanReversionSignal(hist, {
            buyThreshold: s0.config.buyThreshold,
            sellThreshold: s0.config.sellThreshold,
            stopLossPct: s0.config.stopLossPct,
          })
          if (signal.action !== "BUY") continue
          if (stateRef.current.positions.length >= s0.config.maxPositions) continue
          // COMPOUND: trade size = % of the CURRENT balance when compounding is
          // on, otherwise % of the original capital (fixed size).
          const compoundBase = s0.config.compoundInterest ? balance : s0.config.capital
          const tradeUsd = compoundBase * (s0.config.tradeSizePct / 100)
          if (tradeUsd < 1) continue
          // PAPER BUY at REAL Jupiter quote
          const q = await getQuote(USDC_MINT, mint, tradeUsd, s0.config.slippageBps, tokens, tickPrices)
          if (!q) {
            log(`BUY quote failed for ${tok.symbol}`, "error")
            continue
          }
          setState((s) => ({ ...s, status: "executing" }))
          // REAL outAmount from Jupiter → real tokens received
          const amountReceived = q.outAmount / Math.pow(10, tok.decimals)
          const newPos: Position = {
            id: `pos_${Date.now()}`,
            mint,
            symbol: tok.symbol,
            entryPrice: currentPrice,
            amount: amountReceived,
            costUsd: tradeUsd,
            smaAtEntry: computeSMA(hist, Math.min(20, hist.length)),
            openedAt: Date.now(),
          }
          const trade: PaperTrade = {
            id: `pt_${Date.now()}`,
            strategy: "mean_reversion",
            side: "BUY",
            inputMint: USDC_MINT,
            outputMint: mint,
            inputSymbol: "USDC",
            outputSymbol: tok.symbol,
            inputAmount: tradeUsd,
            outputAmount: amountReceived,
            entryPrice: currentPrice,
            exitPrice: undefined,
            pnl: 0,
            pnlPct: 0,
            win: false,
            route: q.labels.length ? q.labels : [`USDC->${tok.symbol}`],
            reason: signal.reason,
            openedAt: Date.now(),
            closedAt: undefined,
            realQuote: true,
            status: "confirmed",
          }
          setState((s) => ({
            ...s,
            balance: s.balance - tradeUsd,
            positions: [newPos, ...s.positions],
            trades: [trade, ...s.trades].slice(0, TRADE_CAP),
          }))
          log(`✅ PAPER-BUY ${tok.symbol} @ real $${currentPrice.toFixed(4)} — $${tradeUsd.toFixed(2)} USDC → ${amountReceived.toFixed(4)} ${tok.symbol} (real Jupiter route: ${q.labels.join(", ")})`, "trade")
          break
        }
      }

      // 3. triangular arbitrage with REAL Jupiter quotes (every 3rd scan).
      //   scanCount lives on stats (incremented at the end of each scan), so we
      //   use the previous stats.scanCount here. Runs on the 1st scan (stats is
      //   null/0) and every 3rd scan thereafter.
      if ((stateRef.current.stats?.scanCount ?? 0) % 3 === 0) {
        await runArbScan(stateRef.current, tokens, tickPrices)
      }

      // 4. compute stats
      const s1 = stateRef.current
      const openPosValue = s1.positions.reduce((acc, p) => acc + (s1.prices[p.mint] ?? p.entryPrice) * p.amount, 0)
      const openPnl = s1.positions.reduce(
        (acc, p) => acc + ((s1.prices[p.mint] ?? p.entryPrice) - p.entryPrice) * p.amount,
        0
      )
      const equity = s1.balance + openPosValue
      const closedTrades = s1.trades.filter((t) => t.closedAt)
      const totalTrades = closedTrades.length
      const wins = closedTrades.filter((t) => t.win).length
      const totalPnl = closedTrades.reduce((acc, t) => acc + t.pnl, 0)
      const stats: BotStats = {
        running: s1.enabled,
        startedAt: s1.enabled ? (s1.stats?.startedAt ?? Date.now()) : null,
        uptimeMs: s1.enabled ? Date.now() - (s1.stats?.startedAt ?? Date.now()) : 0,
        capital: s1.config.capital,
        balance: s1.balance,
        equity,
        openPnl,
        openPositions: s1.positions.length,
        totalTrades,
        wins,
        losses: totalTrades - wins,
        winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
        totalPnl,
        totalPnlPct: s1.config.capital > 0 ? (totalPnl / s1.config.capital) * 100 : 0,
        bestTrade: totalTrades > 0 ? Math.max(...closedTrades.map((t) => t.pnl)) : 0,
        worstTrade: totalTrades > 0 ? Math.min(...closedTrades.map((t) => t.pnl)) : 0,
        arbOpportunitiesDetected: s1.arbitrage.length,
        arbTradesExecuted: s1.trades.filter((t) => t.strategy === "arbitrage").length,
        lastScanAt: lastScanRef.current,
        scanCount: (s1.stats?.scanCount ?? 0) + 1,
      }
      const eqPoint: EquityPoint = {
        timestamp: Date.now(),
        equity,
        balance: s1.balance,
        openPnl,
      }
      setState((s) => ({
        ...s,
        stats,
        equityCurve: [...s.equityCurve, eqPoint].slice(-200),
        status: "scanning",
      }))
    } finally {
      inFlightRef.current = false
    }
  }, [fetchRealPrices, log])

  // arbitrage scan with REAL Jupiter quotes
  const runArbScan = useCallback(async (s0: PaperTradingState, tokens: TokenInfo[], prices: Record<string, number>) => {
    const tradable = s0.config.tokens.filter((m) => m !== USDC_MINT)
    if (tradable.length < 2) return
    const cycles = buildArbCycles(tradable, USDC_MINT).slice(0, 6)
    if (cycles.length === 0) return

    const arbInputUsd = Math.min(s0.balance, s0.config.capital * (s0.config.tradeSizePct / 100) * 0.5)
    if (arbInputUsd < 1) return

    for (const cycle of cycles) {
      const [usdc, a, b] = cycle
      if (usdc !== USDC_MINT) continue
      const aTok = tokens.find((t) => t.mint === a)
      const bTok = tokens.find((t) => t.mint === b)
      if (!aTok || !bTok) continue

      // 3 REAL Jupiter quotes (with computed fallback if Jupiter unreachable)
      const q1 = await getQuote(USDC_MINT, a, arbInputUsd, s0.config.slippageBps, tokens, prices)
      if (!q1 || q1.outAmount <= 0) continue
      const aReceived = q1.outAmount // base units of A
      const q2 = await getQuote(a, b, fromBaseAmount(aReceived, aTok.decimals), s0.config.slippageBps, tokens, prices)
      if (!q2 || q2.outAmount <= 0) continue
      const bReceived = q2.outAmount
      const q3 = await getQuote(b, USDC_MINT, fromBaseAmount(bReceived, bTok.decimals), s0.config.slippageBps, tokens, prices)
      if (!q3 || q3.outAmount <= 0) continue

      // REAL cycle return
      const outUsd = q3.outAmount / Math.pow(10, 6)
      const profitUsd = outUsd - arbInputUsd
      const profitPct = (profitUsd / arbInputUsd) * 100
      const profitBps = (profitUsd / arbInputUsd) * 10000

      const opp: ArbitrageOpportunity = {
        id: `arb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        cycle,
        symbols: ["USDC", aTok.symbol, bTok.symbol, "USDC"],
        legs: [
          { from: "USDC", to: aTok.symbol, outPerIn: q1.outPerIn },
          { from: aTok.symbol, to: bTok.symbol, outPerIn: q2.outPerIn },
          { from: bTok.symbol, to: "USDC", outPerIn: q3.outPerIn },
        ],
        inputAmountUsd: arbInputUsd,
        outputAmountUsd: outUsd,
        profitUsd,
        profitPct,
        profitBps,
        detectedAt: Date.now(),
        executed: false,
      }

      if (profitBps >= s0.config.arbMinProfitBps) {
        // PAPER execute the real arb
        setState((s) => ({
          ...s,
          balance: s.balance + profitUsd,
          arbitrage: [{ ...opp, executed: true }, ...s.arbitrage].slice(0, ARB_CAP),
        }))
        const trade: PaperTrade = {
          id: `pt_${Date.now()}`,
          strategy: "arbitrage",
          side: "ARB",
          inputMint: USDC_MINT,
          outputMint: USDC_MINT,
          inputSymbol: "USDC",
          outputSymbol: "USDC",
          inputAmount: arbInputUsd,
          outputAmount: outUsd,
          entryPrice: 1,
          exitPrice: 1,
          pnl: profitUsd,
          pnlPct: profitPct,
          win: profitUsd > 0,
          route: [`USDC->${aTok.symbol}`, `${aTok.symbol}->${bTok.symbol}`, `${bTok.symbol}->USDC`],
          cycle,
          reason: `Real triangular arb ${profitBps.toFixed(0)}bps`,
          openedAt: Date.now(),
          closedAt: Date.now(),
          realQuote: true,
          status: "confirmed",
        }
        setState((s) => ({ ...s, trades: [trade, ...s.trades].slice(0, TRADE_CAP) }))
        log(`✅ PAPER-ARB executed +$${profitUsd.toFixed(3)} (${profitBps.toFixed(0)}bps) on USDC->${aTok.symbol}->${bTok.symbol}->USDC (real Jupiter route)`, "trade")
      } else {
        setState((s) => ({ ...s, arbitrage: [opp, ...s.arbitrage].slice(0, ARB_CAP) }))
        if (profitBps > 0) {
          log(`Arb near miss USDC->${aTok.symbol}->${bTok.symbol}->USDC: ${profitBps.toFixed(0)}bps (need ${s0.config.arbMinProfitBps})`, "info")
        }
      }
    }
  }, [log])

  const start = useCallback(() => {
    setState((s) => ({
      ...s,
      enabled: true,
      status: "scanning",
      stats: s.stats
        ? { ...s.stats, running: true, startedAt: s.stats.startedAt ?? Date.now() }
        : null,
    }))
    log(`🟢 PAPER trading started — REAL Jupiter market data, fictional $${stateRef.current.config.capital} capital. Compound interest ON.`, "trade")
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => {
      scan().catch((e) => log(`Scan error: ${e.message}`, "error"))
    }, stateRef.current.config.scanIntervalMs)
  }, [scan, log])

  const stop = useCallback(() => {
    setState((s) => ({ ...s, enabled: false, status: "idle" }))
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log("Paper trading stopped", "info")
  }, [log])

  const resetAccount = useCallback(() => {
    setState((s) => ({
      ...s,
      balance: s.config.capital,
      positions: [],
      trades: [],
      arbitrage: [],
      equityCurve: [],
      stats: null,
      logs: [],
    }))
    log(`Account reset to $${stateRef.current.config.capital}`, "info")
  }, [log])

  useEffect(() => {
    return () => {
      if (loopRef.current) clearInterval(loopRef.current)
    }
  }, [])

  const updateConfig = useCallback((patch: Partial<BotConfig>) => {
    setState((s) => {
      const next = { ...s.config, ...patch }
      // if capital changes and we haven't started, reset balance to new capital
      if (patch.capital !== undefined && !s.enabled) {
        return { ...s, config: next, balance: patch.capital, capital: patch.capital }
      }
      return { ...s, config: next }
    })
  }, [])

  const scanCount = state.stats?.scanCount ?? 0

  return {
    ...state,
    tokens: tokensRef.current,
    scanCount,
    start,
    stop,
    scan: () => scan(),
    updateConfig,
    resetAccount,
    log,
  }
}
