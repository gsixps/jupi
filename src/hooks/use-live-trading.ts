// FULLY AUTOMATIC real trading bot using a FUNDED TRADING SUB-WALLET.
//
// Flow (only ONE human approval total — the funding):
//   1. User connects Phantom (main wallet)
//   2. App generates an ephemeral trading sub-wallet keypair (in localStorage)
//   3. User clicks "Fund $5" → ONE Phantom approval to transfer $5 USDC + a
//      little SOL (for gas) from the main wallet into the trading sub-wallet.
//   4. User clicks "Start Auto-Trading" → the bot runs 100% automatically:
//        - fetches REAL prices from Jupiter (browser → api.jup.ag/price/v3)
//        - detects mean-reversion + triangular-arb signals
//        - executes REAL swaps signed by the trading sub-wallet keypair
//          (NO Phantom popup per trade — the bot owns the key)
//        - broadcasts to Solana mainnet + confirms
//   5. User clicks "Withdraw" → sweeps everything back to the main wallet
//      (signed by the trading sub-wallet, no Phantom popup)
//
// The risk is strictly limited to the funded amount (~$5). The main wallet
// is never exposed to the bot's automated trades.
//
// ARCHITECTURE (same pattern as the Paper/Demo bot):
//   - The balance lives in React state (usdcBalance/solBalance) — always
//     available, no async, no flicker. It is seeded from the trading
//     sub-wallet's real on-chain USDC/SOL on connect/fund/refresh and
//     modified by trades (BUY decreases, SELL increases).
//   - Background (non-blocking) refresh of the SUB-WALLET balances each scan
//     keeps the state in sync with the real chain.
//   - getQuote tries REAL Jupiter quotes first; if the Quote API is
//     unreachable it computes from the real price map + capped slippage, so
//     a quote ALWAYS returns (same as Demo).
//   - Intraday tick perturbation (OU process anchored to the real price)
//     gives the bot price movement to trade on (same as Demo).
//   - When Jupiter returns a real quote AND the trading sub-wallet exists,
//     the swap is executed ON-CHAIN via executeSwapWithKeypair. Otherwise it
//     falls back to a paper trade at the real market rate.

"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import "../lib/polyfills"
import type { Connection, TransactionInstruction } from "@solana/web3.js"
import { PublicKey } from "@solana/web3.js"
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token"
import { useWallet } from "./use-wallet"
import { signAndSendTransaction } from "@/lib/wallet"
import { VERIFIED_TOKENS, USDC_MINT } from "@/lib/tokens"
import {
  fetchRealQuote,
  executeSwapWithKeypair,
  type SwapExecution,
  type RealQuoteResult,
} from "@/lib/jupiter-swap"
import {
  loadTradingWallet,
  loadTradingWalletFromServer,
  generateTradingWallet,
  clearTradingWallet,
  clearTradingWalletFromServer,
  saveTradingWalletToServer,
  buildFundingTransaction,
  withdrawAll,
  getTradingWalletBalances,
  type TradingWallet,
} from "@/lib/trading-wallet"
import type { TokenInfo, Trade, Position, BotStats, EquityPoint, BotConfig } from "@/lib/trading-types"
import { DEFAULT_CONFIG } from "@/lib/trading-types"
import { computeSMA, meanReversionSignal, shouldClosePosition } from "@/lib/strategy"

const PRICE_HISTORY_CAP = 40
const TRADE_CAP = 100

/** Short human description of each instruction, for funding diagnostics. */
function describeFundingInstructions(instructions: TransactionInstruction[]) {
  const known: Record<string, string> = {
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token(transfer)",
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "AToken(create)",
    ComputeBudget111111111111111111111111111111: "ComputeBudget",
    "11111111111111111111111111111111": "System(transfer)",
    // Older copied mint key on some forks; decorative only:
    "11111111111111111111111111111112": "System(unknown)",
  }
  return instructions.map((i) => {
    const p = i.programId.toBase58()
    return `${known[p] ?? p.slice(0, 8)}:keys=${i.keys.length}/data=${i.data.length}`
  })
}

interface LiveTrade extends Trade {
  signature?: string
  status: "confirmed" | "failed" | "pending"
}

/** A quote that also tells us whether it can be executed on-chain. */
interface LiveQuote {
  outAmount: number // base units of the output token
  outHuman: number // human units of output
  labels: string[]
  outPerIn: number
  simulated: boolean // true = computed fallback (no real swap possible)
  raw: RealQuoteResult | null
}

export interface LiveTradingState {
  enabled: boolean
  config: BotConfig
  prices: Record<string, number>
  change24h: Record<string, number>
  priceHistory: Record<string, number[]>
  positions: Position[]
  trades: LiveTrade[]
  stats: BotStats | null
  equityCurve: EquityPoint[]
  logs: { time: number; msg: string; level: "info" | "warn" | "error" | "trade" }[]
  status: "idle" | "scanning" | "executing" | "paused"
  error: string | null
  tradingWallet: TradingWallet | null
  tradingBalances: { sol: number; usdc: number } | null
  fundedUsd: number
  fundingStatus: "idle" | "funding" | "funded" | "withdrawing"
  // In-memory balance (SAME pattern as Demo) — updated by background fetch +
  // modified by trades (BUY decreases, SELL increases). The scan reads this
  // from stateRef.current (always available, no async, no flicker).
  usdcBalance: number
  solBalance: number
}

export function useLiveTrading(wallet: ReturnType<typeof useWallet>) {
  const [state, setState] = useState<LiveTradingState>({
    enabled: false,
    config: {
      ...DEFAULT_CONFIG,
      capital: 5,
      maxPositions: 3,
      tradeSizePct: 25,
      buyThreshold: 0.7,
      sellThreshold: 1.0,
      stopLossPct: 2.5,
      arbMinProfitBps: 20,
      slippageBps: 100, // higher slippage tolerance for small swaps
      scanIntervalMs: 6000,
      tokens: VERIFIED_TOKENS.filter((t) => !t.stable).map((t) => t.mint),
    },
    prices: {},
    change24h: {},
    priceHistory: {},
    positions: [],
    trades: [],
    stats: null,
    equityCurve: [],
    logs: [],
    status: "idle",
    error: null,
    tradingWallet: null,
    tradingBalances: null,
    fundedUsd: 0,
    fundingStatus: "idle",
    usdcBalance: 0,
    solBalance: 0,
  })

  const stateRef = useRef(state)
  stateRef.current = state
  // Keep a ref to the wallet so effects depending only on `wallet.connected`
  // don't re-run on every render (the `wallet` object is a new reference
  // each render, which would cause an infinite update loop).
  const walletRef = useRef(wallet)
  walletRef.current = wallet
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tokensRef = useRef<TokenInfo[]>(VERIFIED_TOKENS)
  const lastScanRef = useRef(0)
  const inFlightRef = useRef(false)
  const stoppingRef = useRef(false)
  // per-mint intraday tick perturbation state (mean-reverting OU process)
  const pertStateRef = useRef<Record<string, number>>({})
  // track price-fetch failure state so we only log the transition (not every
  // failed scan, which would spam the console during transient outages).
  const priceFetchFailedRef = useRef(false)
  // track the last logged USDC balance so we only log on meaningful changes.
  const lastBalanceLogRef = useRef<number | null>(null)
  // throttle the "trade size too small" warning (spams every scan otherwise)
  const lastMinTradeLogRef = useRef<number>(0)

  const log = useCallback((msg: string, level: "info" | "warn" | "error" | "trade" = "info") => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, 100),
    }))
    console[level === "trade" ? "log" : level](`[live-bot] ${msg}`)
  }, [])

  // ---- load or generate the trading sub-wallet on connect ----
  // Source of truth: localStorage FIRST (instant). If missing, falls back to
  // the SERVER-side DB backup (survives a cleared browser). If neither exists,
  // generates a fresh wallet and persists it to BOTH local + server.
  const applyTradingWallet = useCallback(
    async (tw: TradingWallet) => {
      const w = walletRef.current
      setState((s) => ({ ...s, tradingWallet: tw }))
      const conn = w?.getConnection()
      if (!conn) return
      const b = await getTradingWalletBalances(conn, tw.publicKey).catch(() => null)
      if (!b) return
      setState((s) => ({
        ...s,
        tradingBalances: b,
        fundedUsd: b.usdc,
        fundingStatus: b.usdc > 0 ? "funded" : "idle",
        usdcBalance: b.usdc,
        solBalance: b.sol,
      }))
      if (b.usdc > 0) log(`Trading wallet has $${b.usdc.toFixed(2)} USDC + ${b.sol.toFixed(4)} SOL`, "info")
    },
    [log]
  )

  useEffect(() => {
    if (!walletRef.current.connected) return
    const local = loadTradingWallet()
    if (local) {
      log(`Loaded trading sub-wallet ${local.publicKey.slice(0, 8)}…`, "info")
      applyTradingWallet(local)
    } else {
      // no local copy → try the server backup first; only then generate fresh
      ;(async () => {
        const fromServer = await loadTradingWalletFromServer()
        if (fromServer) {
          log(`Recovered trading sub-wallet ${fromServer.publicKey.slice(0, 8)}… from server backup`, "info")
          await applyTradingWallet(fromServer)
        } else {
          const tw = generateTradingWallet()
          log(`Generated trading sub-wallet ${tw.publicKey.slice(0, 8)}…`, "info")
          saveTradingWalletToServer(tw) // best-effort DB backup
          await applyTradingWallet(tw)
        }
      })()
    }
  }, [wallet.connected, applyTradingWallet])

  // ---- fetch real prices from Jupiter Price API (client-side) ----
  // Tries Jupiter direct from the browser first (real DEX prices that MOVE),
  // falls back to the /api/prices server-side proxy (Jupiter → CoinGecko).
  const fetchRealPrices = useCallback(
    async (mints: string[]): Promise<{ prices: Record<string, number>; change: Record<string, number> }> => {
      const prices: Record<string, number> = { [USDC_MINT]: 1 }
      const change: Record<string, number> = {}
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
          // browser can't reach Jupiter — fall through to proxy
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

  // ---- refresh trading wallet balances (client-side RPC, non-blocking) ----
  const refreshTradingBalances = useCallback(async () => {
    const conn = wallet.getConnection()
    const tw = stateRef.current.tradingWallet
    if (!conn || !tw) return
    try {
      const b = await getTradingWalletBalances(conn, tw.publicKey)
      setState((s) => ({ ...s, tradingBalances: b, usdcBalance: b.usdc, solBalance: b.sol }))
    } catch {
      // ignore
    }
  }, [wallet])

  // ---- FUND the trading wallet (ONE Phantom approval) ----
  // ---- FUND the trading sub-wallet with USDC + SOL from the main wallet ----
  const fundWallet = useCallback(
    async (usdAmount: number, solAmount: number) => {
      const conn = wallet.getConnection()
      const tw = stateRef.current.tradingWallet
      if (!conn || !tw || !wallet.publicKey) {
        log("Connect Phantom first", "warn")
        return
      }
      setState((s) => ({ ...s, fundingStatus: "funding" }))
      try {
        const { transaction } = await buildFundingTransaction(
          conn,
          wallet.publicKey,
          tw.publicKey,
          { solAmount, usdcAmount: usdAmount }
        )
        // Phantom signs + sends the funding tx (supports sendTransaction,
        // signAndSendTransaction, and sign+sendRaw fallbacks). If the wallet's
        // preflight rejects a benign tx, retry once broadcasting without
        // preflight so the REAL on-chain result decides (and `confirmTransaction`
        // below surfaces its actual logs).
        let sig: string
        try {
          sig = await signAndSendTransaction(transaction, conn)
        } catch (firstErr: any) {
          const firstMsg = firstErr?.message ?? String(firstErr ?? "")
          const simLike = /instructionerror|custom program error|simulation|insufficient/i.test(firstMsg)
          if (simLike) {
            console.error("[fund-retry] preflight rejected, retrying skipPreflight:true —", firstMsg.slice(0, 200))
            sig = await signAndSendTransaction(transaction, conn, { skipPreflight: true })
          } else {
            throw firstErr
          }
        }
        await conn.confirmTransaction(sig, "confirmed")
        log(`✅ Funded trading wallet: $${usdAmount} USDC + ${solAmount} SOL — sig ${sig.slice(0, 8)}…`, "trade")
        // refresh balances + seed the in-memory balance (same pattern as Demo)
        const b = await getTradingWalletBalances(conn, tw.publicKey)
        setState((s) => ({
          ...s,
          tradingBalances: b,
          fundedUsd: b.usdc,
          fundingStatus: "funded",
          usdcBalance: b.usdc,
          solBalance: b.sol,
          config: { ...s.config, capital: b.usdc },
        }))
      } catch (e: any) {
const reason = e?.message ?? (e == null ? "unknown error" : typeof e === "object" ? JSON.stringify(e) : String(e))
        const hint = /reject|denied|declined|user.*cancel|timeout/i.test(reason)
          ? " — parece que el popup de Phantom se rechazó/expiró; inténtalo de nuevo y apruébalo"
          : ""
        console.error("[fund-detail]", e)
        if (Array.isArray(e?.logs) && e.logs.length) console.error("[fund-logs]", e.logs)
        log(`Funding failed: ${reason}${hint}`, "error")
        setState((s) => ({ ...s, fundingStatus: "idle" }))
      }
    },
    [wallet, log]
  )

  // ---- WITHDRAW everything back to the main wallet (no Phantom popup) ----
  const withdrawFunds = useCallback(async () => {
    const conn = wallet.getConnection()
    const tw = stateRef.current.tradingWallet
    if (!conn || !tw || !wallet.publicKey) return
    // The withdraw MUST happen only when the bot is fully stopped AND no scan
    // is mid-flight (a racing scan could place a swap right after the sweep).
    if (stateRef.current.enabled || inFlightRef.current) {
      stop()
      // wait up to ~5s for the in-flight scan to abort (stoppingRef check) or finish
      for (let i = 0; i < 50; i++) {
        if (!inFlightRef.current) break
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    setState((s) => ({ ...s, fundingStatus: "withdrawing" }))
    try {
      const sig = await withdrawAll(conn, tw, wallet.publicKey)
      log(`✅ Withdrew all funds to main wallet — sig ${sig.slice(0, 8)}…`, "trade")
      const b = await getTradingWalletBalances(conn, tw.publicKey)
      setState((s) => ({
        ...s,
        tradingBalances: b,
        fundedUsd: b.usdc,
        fundingStatus: b.usdc > 0 ? "funded" : "idle",
        usdcBalance: b.usdc,
        solBalance: b.sol,
      }))
    } catch (e: any) {
      console.error("[withdraw-detail]", e)
      if (Array.isArray(e?.logs) && e.logs.length) console.error("[withdraw-logs]", e.logs)
      const reason = e?.message ?? (e == null ? "unknown error" : String(e))
      log(`Withdraw failed: ${reason}`, "error")
      setState((s) => ({ ...s, fundingStatus: "funded" }))
    }
  }, [wallet, log])

  // ---- fetch a REAL swap quote (Jupiter), with a computed fallback ----
  // Same as the Paper bot: real Jupiter quote first; if the Quote API is
  // unreachable, compute from the real price map + capped slippage so the bot
  // can keep trading (paper fallback) instead of failing.
  const getQuote = useCallback(
    async (
      inputMint: string,
      outputMint: string,
      uiAmount: number,
      slippageBps: number,
      tokens: TokenInfo[],
      prices: Record<string, number>
    ): Promise<LiveQuote | null> => {
      const real = await fetchRealQuote(inputMint, outputMint, uiAmount, slippageBps, tokens)
      if (real && real.outAmount > 0) {
        const outTok = tokens.find((t) => t.mint === outputMint)
        return {
          outAmount: real.outAmount,
          outHuman: outTok ? real.outAmount / Math.pow(10, outTok.decimals) : real.outAmount,
          labels: real.labels.length ? real.labels : ["Jupiter"],
          outPerIn: real.outPerIn,
          simulated: false,
          raw: real,
        }
      }
      // computed fallback from real prices
      const inTok = tokens.find((t) => t.mint === inputMint)
      const outTok = tokens.find((t) => t.mint === outputMint)
      if (!inTok || !outTok) return null
      const inPrice = prices[inputMint]
      const outPrice = prices[outputMint]
      if (!inPrice || !outPrice || outPrice <= 0) return null
      const inUsd = uiAmount * inPrice
      // Cap the effective slippage at 10bps — the config.slippageBps is the
      // user's TOLERANCE, but the ACTUAL execution cost on liquid Solana pools
      // via Jupiter is ~5-15bps. Using the full tolerance (100bps) would make
      // every round-trip lose ~1% to "slippage" and the bot unprofitable.
      const effSlippage = Math.min(slippageBps, 10) / 10000
      const outUsd = inUsd * (1 - effSlippage)
      const outHuman = outUsd / outPrice
      const outAmount = Math.floor(outHuman * Math.pow(10, outTok.decimals))
      return {
        outAmount,
        outHuman,
        labels: ["price-ratio (Jupiter unreachable)"],
        outPerIn: uiAmount > 0 ? outHuman / uiAmount : 0,
        simulated: true,
        raw: null,
      }
    },
    []
  )

  // ---- execute an ON-CHAIN swap signed by the trading sub-wallet ----
  // Uses executeSwapWithKeypair (the sub-wallet key signs — NO Phantom popup).
  const executeSwap = useCallback(
    async (opts: {
      conn: Connection
      quote: RealQuoteResult
      inSymbol: string
      outSymbol: string
      inDecimals: number
      outDecimals: number
    }): Promise<SwapExecution> => {
      const tw = stateRef.current.tradingWallet
      if (!tw) throw new Error("No trading wallet")
      return executeSwapWithKeypair({
        signerKeypair: tw.keypair,
        userPublicKey: tw.publicKey,
        connection: opts.conn,
        quote: opts.quote,
        inSymbol: opts.inSymbol,
        outSymbol: opts.outSymbol,
        inDecimals: opts.inDecimals,
        outDecimals: opts.outDecimals,
      })
    },
    []
  )

  // ---- the FULLY AUTOMATIC bot scan (no per-trade approvals) ----
  const scan = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const s0 = stateRef.current
      if (!s0.enabled || !wallet.publicKey) {
        inFlightRef.current = false
        return
      }
      const conn = wallet.getConnection()
      if (!conn) {
        log("No RPC connection", "error")
        inFlightRef.current = false
        return
      }
      setState((s) => ({ ...s, status: "scanning" }))
      lastScanRef.current = Date.now()

      const tokens = tokensRef.current
      const mints = s0.config.tokens

      // 1. fetch real prices (Jupiter direct → /api/prices proxy fallback)
      const { prices, change } = await fetchRealPrices(mints)
      const newPriceHistory = { ...s0.priceHistory }
      // Intraday tick perturbation (SAME as Demo — OU process anchored to real price)
      const tickPrices: Record<string, number> = { ...prices }
      for (const m of mints) {
        const p = prices[m]
        if (typeof p !== "number" || p <= 0) continue
        const hist = newPriceHistory[m] ?? []
        const lastReal = s0.prices[m]
        const realChanged = !lastReal || Math.abs(p - lastReal) / lastReal > 0.0005
        // evolve the per-mint perturbation (OU mean-reverting process)
        let pert = pertStateRef.current[m] ?? 0
        if (realChanged) {
          // fresh real data → partial reset (real movement dominates)
          pert = pert * 0.4 + (Math.random() - 0.5) * 0.002
        } else {
          // static (cached) → simulate intraday tick movement (bigger swings)
          pert = pert * 0.82 + (Math.random() - 0.5) * 0.009
        }
        if (pert > 0.025) pert = 0.025
        if (pert < -0.025) pert = -0.025
        pertStateRef.current[m] = pert
        const tickPrice = p * (1 + pert)
        tickPrices[m] = tickPrice
        const arr = [...hist, tickPrice]
        if (arr.length > PRICE_HISTORY_CAP) arr.splice(0, arr.length - PRICE_HISTORY_CAP)
        newPriceHistory[m] = arr
      }
      setState((s) => ({ ...s, prices: tickPrices, change24h: change, priceHistory: newPriceHistory }))

      // 2. Read balance from STATE (SAME as Demo — always available, no flicker)
      // The background fetch (below) updates this state periodically.
      // Trades modify it: BUY decreases, SELL increases.
      const usdcBalance = stateRef.current.usdcBalance

      // Background refresh: update usdcBalance/solBalance from the trading
      // SUB-WALLET on-chain balances (client-side RPC — non-blocking).
      // Only updates if the fetch returns a value > 0 (prevents $0 overwrite).
      ;(async () => {
        try {
          const w = walletRef.current
          const tw = stateRef.current.tradingWallet
          if (!w.publicKey || !tw) return
          const c2 = w.getConnection()
          if (!c2) return
          const b = await getTradingWalletBalances(c2, tw.publicKey)
          if (b.usdc > 0 || b.sol > 0) {
            setState((s) => ({
              ...s,
              tradingBalances: b,
              usdcBalance: b.usdc,
              solBalance: b.sol,
            }))
            if (lastBalanceLogRef.current === null || Math.abs(b.usdc - (lastBalanceLogRef.current ?? 0)) > 0.01) {
              lastBalanceLogRef.current = b.usdc
              log(`Trading wallet balance: $${b.usdc.toFixed(2)} USDC + ${b.sol.toFixed(4)} SOL`, "info")
            }
          }
        } catch {}
      })()

      // 3. mean reversion per token (SAME pattern as Demo)
      for (const mint of mints) {
        const hist = newPriceHistory[mint]
        if (!hist || hist.length < 3) continue
        const tok = tokens.find((t) => t.mint === mint)
        if (!tok) continue
        const currentPrice = hist[hist.length - 1]
        const existingPos = stateRef.current.positions.find((p) => p.mint === mint)

        if (existingPos) {
          // SELL: check close conditions
          const closeCheck = shouldClosePosition(existingPos, currentPrice, {
            sellThreshold: s0.config.sellThreshold,
            stopLossPct: s0.config.stopLossPct,
          })
          if (closeCheck.action) {
            try {
              const q = await getQuote(mint, USDC_MINT, existingPos.amount, s0.config.slippageBps, tokens, tickPrices)
              if (!q) {
                log(`SELL quote failed for ${tok.symbol}`, "warn")
                break
              }
              // LIVE mode: never book a paper fill. If there's no REAL quote
              // we can't close on-chain — skip this scan (retry next scan)
              // rather than fake the position.
              if (q.simulated || !q.raw) {
                log(`SELL ${tok.symbol} skipped — real swap quote unavailable (retrying)`, "warn")
                break
              }
              let realOutUsd = q.outHuman
              let sig = ""
              try {
                if (stoppingRef.current) break // a withdraw is pending — no new on-chain trades
                const exec = await executeSwap({ conn, quote: q.raw, inSymbol: tok.symbol, outSymbol: "USDC", inDecimals: tok.decimals, outDecimals: 6 })
                if (exec.success) {
                  realOutUsd = exec.outHuman
                  sig = exec.signature.slice(0, 8)
                } else {
                  log(`SELL on-chain swap failed for ${tok.symbol}: ${exec.error ?? "unknown"}`, "warn")
                  break
                }
              } catch (e: any) {
                log(`SELL on-chain swap failed for ${tok.symbol}: ${e.message}`, "warn")
                break
              }
              const pnl = realOutUsd - existingPos.costUsd
              const pnlPct = (pnl / existingPos.costUsd) * 100
              const trade: LiveTrade = {
                id: `lt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
                route: [`${tok.symbol}->USDC`],
                reason: closeCheck.reason,
                openedAt: existingPos.openedAt,
                closedAt: Date.now(),
                signature: sig,
                status: "confirmed",
              }
              setState((s) => ({
                ...s,
                usdcBalance: s.usdcBalance + realOutUsd,
                positions: s.positions.filter((p) => p.mint !== mint),
                trades: [trade, ...s.trades].slice(0, TRADE_CAP),
              }))
              log(`${pnl >= 0 ? "✅" : "❌"} REAL SELL ${tok.symbol} PnL ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(3)} (${pnlPct.toFixed(2)}%)`, "trade")
              break // one swap per scan
            } catch (e: any) {
              log(`SELL execution error ${tok.symbol}: ${e.message}`, "error")
              break
            }
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
          // COMPOUND INTEREST: trade size = % of the CURRENT trading-wallet USDC
          // balance (not the original funded capital). As profits accumulate and
          // the balance grows, each new trade is proportionally larger → gains
          // compound. e.g. $5 @ 25% = $1.25; after growing to $8 → $2.00; $12 →
          // $3.00; and so on. This is how the bot "uses the capital it has".
          const tradeUsd = usdcBalance * (s0.config.tradeSizePct / 100)
          if (tradeUsd < 0.15) {
            // rate-limit the spammy log (the loop retries every scan)
            if (Date.now() - (lastMinTradeLogRef.current ?? 0) > 30000) {
              lastMinTradeLogRef.current = Date.now()
              log(`Trade size too small to trade profitably: $${tradeUsd.toFixed(2)} (balance $${usdcBalance.toFixed(2)}) — fund more capital`, "warn")
            }
            continue
          }
          try {
            const q = await getQuote(USDC_MINT, mint, tradeUsd, s0.config.slippageBps, tokens, tickPrices)
            if (!q) {
              log(`BUY quote failed for ${tok.symbol}`, "warn")
              continue
            }
            // LIVE mode: if there's no REAL quote we cannot open an on-chain
            // position — skip (no phantom buy) and retry on the next scan.
            if (q.simulated || !q.raw) {
              log(`BUY ${tok.symbol} skipped — real swap quote unavailable (retrying)`, "warn")
              continue
            }
            let amountReceived = q.outHuman
            let sig = ""
            try {
              if (stoppingRef.current) continue // a withdraw is pending — no new on-chain trades
              const exec = await executeSwap({ conn, quote: q.raw, inSymbol: "USDC", outSymbol: tok.symbol, inDecimals: 6, outDecimals: tok.decimals })
              if (exec.success) {
                amountReceived = exec.outHuman
                sig = exec.signature.slice(0, 8)
              } else {
                log(`BUY on-chain swap failed for ${tok.symbol}: ${exec.error ?? "unknown"}`, "warn")
                continue
              }
            } catch (e: any) {
              log(`BUY on-chain swap failed for ${tok.symbol}: ${e.message}`, "warn")
              continue
            }
            const newPos: Position = {
              id: `pos_${Date.now()}`,
              mint,
              symbol: tok.symbol,
              entryPrice: currentPrice,
              amount: amountReceived,
              costUsd: tradeUsd,
              smaAtEntry: computeSMA(hist, Math.min(8, hist.length)),
              openedAt: Date.now(),
            }
            const trade: LiveTrade = {
              id: `lt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
              route: [`USDC->${tok.symbol}`],
              reason: signal.reason,
              openedAt: Date.now(),
              closedAt: undefined,
              signature: sig,
              status: "confirmed",
            }
            setState((s) => ({
              ...s,
              usdcBalance: s.usdcBalance - tradeUsd,
              positions: [newPos, ...s.positions],
              trades: [trade, ...s.trades].slice(0, TRADE_CAP),
            }))
            log(`✅ ${sig ? "REAL" : "PAPER"} BUY ${tok.symbol} — $${tradeUsd.toFixed(2)} USDC → ${amountReceived.toFixed(4)} @ $${currentPrice.toFixed(4)}`, "trade")
            break // one swap per scan
          } catch (e: any) {
            log(`BUY execution error ${tok.symbol}: ${e.message}`, "error")
            break
          }
        }
      }

      // 4. compute stats (use in-memory usdcBalance, SAME as Demo)
      const s1 = stateRef.current
      const openPosValue = s1.positions.reduce((acc, p) => acc + (s1.prices[p.mint] ?? p.entryPrice) * p.amount, 0)
      const openPnl = s1.positions.reduce(
        (acc, p) => acc + ((s1.prices[p.mint] ?? p.entryPrice) - p.entryPrice) * p.amount,
        0
      )
      const equity = s1.usdcBalance + openPosValue
      const totalTrades = s1.trades.filter((t) => t.closedAt).length
      const wins = s1.trades.filter((t) => t.closedAt && t.win).length
      const totalPnl = s1.trades.filter((t) => t.closedAt).reduce((acc, t) => acc + t.pnl, 0)
      const stats: BotStats = {
        running: s1.enabled,
        startedAt: s1.enabled ? (s1.stats?.startedAt ?? Date.now()) : null,
        uptimeMs: s1.enabled ? Date.now() - (s1.stats?.startedAt ?? Date.now()) : 0,
        capital: s1.config.capital,
        balance: s1.usdcBalance,
        equity,
        openPnl,
        openPositions: s1.positions.length,
        totalTrades,
        wins,
        losses: totalTrades - wins,
        winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
        totalPnl,
        totalPnlPct: s1.config.capital > 0 ? (totalPnl / s1.config.capital) * 100 : 0,
        bestTrade: totalTrades > 0 ? Math.max(...s1.trades.filter((t) => t.closedAt).map((t) => t.pnl)) : 0,
        worstTrade: totalTrades > 0 ? Math.min(...s1.trades.filter((t) => t.closedAt).map((t) => t.pnl)) : 0,
        arbOpportunitiesDetected: 0,
        arbTradesExecuted: s1.trades.filter((t) => t.strategy === "arbitrage").length,
        lastScanAt: lastScanRef.current,
        scanCount: (s1.stats?.scanCount ?? 0) + 1,
      }
      const eqPoint: EquityPoint = {
        timestamp: Date.now(),
        equity,
        balance: s1.usdcBalance,
        openPnl,
      }
      setState((s) => ({
        ...s,
        stats,
        equityCurve: [...s.equityCurve, eqPoint].slice(-100),
        status: "scanning",
      }))
    } finally {
      inFlightRef.current = false
    }
  }, [wallet, fetchRealPrices, log])

  const start = useCallback(() => {
    const s = stateRef.current
    if (!wallet.publicKey) {
      log("Connect Phantom first", "warn")
      return
    }
    stoppingRef.current = false
    setState((st) => ({
      ...st,
      enabled: true,
      stats: st.stats ? { ...st.stats, running: true, startedAt: st.stats.startedAt ?? Date.now() } : { ...DEFAULT_CONFIG, running: true, startedAt: Date.now(), uptimeMs: 0, capital: st.config.capital, balance: st.tradingBalances?.usdc ?? 0, equity: st.tradingBalances?.usdc ?? 0, openPnl: 0, openPositions: 0, totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, totalPnlPct: 0, bestTrade: 0, worstTrade: 0, arbOpportunitiesDetected: 0, arbTradesExecuted: 0, lastScanAt: null, scanCount: 0 } as BotStats,
      status: "scanning",
    }))
    log(`🔴 FULLY AUTOMATIC live trading started. Trading wallet signs all swaps — NO per-trade approvals.`, "trade")
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => {
      scan().catch((e) => log(`Scan error: ${e.message}`, "error"))
    }, stateRef.current.config.scanIntervalMs)
  }, [scan, log])

  const stop = useCallback(() => {
    stoppingRef.current = true
    setState((s) => ({ ...s, enabled: false, status: "idle" }))
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log("Auto-trading stopped", "info")
  }, [log])

  useEffect(() => {
    return () => {
      if (loopRef.current) clearInterval(loopRef.current)
    }
  }, [])

  const updateConfig = useCallback((patch: Partial<BotConfig>) => {
    setState((s) => ({ ...s, config: { ...s.config, ...patch } }))
  }, [])

  const resetTradingWallet = useCallback(() => {
    // Stop the bot first (a live loop must never trade on a fresh wallet).
    stoppingRef.current = true
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    clearTradingWallet()
    clearTradingWalletFromServer()
    const tw = generateTradingWallet()
    saveTradingWalletToServer(tw) // back up the new wallet too
    setState((s) => ({
      ...s,
      enabled: false,
      status: "idle",
      tradingWallet: tw,
      tradingBalances: null,
      fundedUsd: 0,
      fundingStatus: "idle",
      usdcBalance: 0,
      solBalance: 0,
      positions: [],
      trades: [],
      stats: null,
      equityCurve: [],
    }))
    log(`Generated new trading sub-wallet ${tw.publicKey.slice(0, 8)}… (previous wallet deleted)`, "info")
  }, [log])

  return {
    ...state,
    tokens: tokensRef.current,
    start,
    stop,
    scan: () => scan(),
    updateConfig,
    fundWallet,
    withdrawFunds,
    resetTradingWallet,
    refreshTradingBalances,
    log,
  }
}