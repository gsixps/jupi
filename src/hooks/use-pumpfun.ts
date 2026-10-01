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
  PUMPFUN_API_CORE,
  PUMPFUN_API_NEW,
  PUMPFUN_MIN_LIQUIDITY_USD,
  PUMPFUN_MIN_MCAP_NEW_USD,
  SOL_DECIMALS,
  WSOL_MINT,
  fetchPumpApiCoins,
  fetchJupiterTokenPrices,
  isValidMint,
  mockPumpUsdPrice,
  mockPumpRefUsd,
  parsePumpApiCoins,
  scorePumpOpportunity,
  seededRandom,
  pumpVerdict,
  pumpOpportunityKind,
} from '@/lib/pumpfun'
import type {
  JupiterTokenPrice,
  PumpApiCoin,
  PumpCoinRow,
  PumpCoinSeed,
  PumpOpportunity,
} from '@/lib/pumpfun'
import type { EquityPoint } from '@/lib/trading-types'
import { executeRealSwap, fetchRealQuote } from '@/lib/jupiter-swap'
import { TAKER_FEE } from '@/lib/paper-fees'

/** Swap cost per side used ONLY in the explicit simulation data mode
 *  (pool fee ≈ 0.25–1% + price impact on thin memecoin pools). */
const SIM_SWAP_COST = 0.01
import { getTokenBalance } from '@/lib/trading-wallet'
import {
  clearLiveSnapshot,
  loadLiveSnapshot,
  reconcileLiveState,
  saveLiveSnapshot,
} from '@/lib/live-state'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import type { TokenInfo } from '@/lib/trading-types'
import { realTokenPriceUsd } from '@/lib/cex'
import type { UseWallet } from '@/hooks/use-wallet'

const LIVE_BOT = 'pumpfun'

/** Slippage tolerance for the real Jupiter swaps (0.5%). */
const SLIPPAGE_BPS = 50

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
  compound: boolean // reinvest profits → per-trade budget scales with equity
  /** Trade on Solana with a connected Phantom wallet and real capital. */
  liveTrading: boolean
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
  compound: true,
  liveTrading: false,
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
  /** LIVE only: on-chain mint of the position (required to sell it back). */
  mint?: string
  /** LIVE only: SPL decimals of the mint. */
  decimals?: number
  /** LIVE only: real transaction signature of the buy. */
  realSignature?: string
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
  compound: boolean
  compoundFactor: number
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
  /**
   * LIVE safety latch. A failed real swap (no wallet, no SOL, user rejected the
   * Phantom prompt, RPC error) stops the bot and records why. It never falls
   * back to the simulated engine while real money is at stake.
   */
  halted: boolean
  haltReason: string | null
  /** LIVE only: the wallet the bot is trading with. */
  walletAddress: string | null
  /** LIVE only: last confirmed SOL balance of that wallet. */
  solBalance: number | null
}

/**
 * Build rows for the DEMO universe. The seeds are fictional tokens with no
 * on-chain mint, which is exactly why live mode uses `buildLiveCoins` instead.
 */
function buildCoins(seeds: PumpCoinSeed[], now: number): PumpCoinRow[] {
  return seeds.map((s) => {
    const priceUsd = mockPumpUsdPrice(s.id, s.baseUsd, now, { isNew: s.isNew })
    return {
      id: s.id,
      symbol: s.symbol,
      name: s.name,
      emoji: s.emoji,
      priceUsd,
      refUsd: mockPumpRefUsd(s.id, s.baseUsd, now),
      mcapUsd: (priceUsd / s.baseUsd) * s.baseMcapUsd,
      ageMs: s.createdAgoMs + (now % 3600000),
      liquidityUsd: s.liquidityUsd,
      volumeUsd: s.volumeUsd,
      isNew: s.isNew,
      momentumPct: 0,
      score: 0,
      verdict: 'neutral' as PumpCoinRow['verdict'],
      // Fictional demo token: no mint, so live mode would refuse to swap it.
      mint: '',
      decimals: 0,
    }
  })
}

/** Deterministic avatar for a real coin, keyed off its mint. */
function pumpEmoji(seed: string): string {
  const pool = ['🐶', '🐱', '🐸', '🚀', '💎', '🌙', '⚡', '🔥', '🍌', '🤖', '👽', '🐢', '🎰', '🧠', '🎯']
  return pool[Math.floor(seededRandom(seed) * pool.length)]
}

/**
 * Build rows for the REAL pump.fun universe. Prices and liquidity come from
 * Jupiter (the executable price), discovery from the pump.fun API. `refMap`
 * keeps the first price ever seen for a mint, which is the "drifted reference"
 * the cheap-entry filter compares against — the demo seeds cannot provide it.
 */
function buildLiveCoins(
  coins: PumpApiCoin[],
  prices: Map<string, JupiterTokenPrice>,
  now: number,
  refMap: Map<string, number>,
  heldMints: Set<string>
): PumpCoinRow[] {
  const rows: PumpCoinRow[] = []
  for (const c of coins) {
    const p = prices.get(c.mint)
    // No Jupiter price means no route: not buyable, not sellable. Drop it.
    if (!p) continue
    const priceUsd = p.usdPrice
    if (!(priceUsd > 0)) continue
    const held = heldMints.has(c.mint)
    // Thin books are untradeable: a $25 order would move the price against us.
    // An OPEN position is never dropped for this, though: hiding it would
    // freeze the exit rules and strand the coins in it forever.
    if (!held && p.liquidityUsd < PUMPFUN_MIN_LIQUIDITY_USD) continue
    const ref = refMap.get(c.mint) ?? priceUsd
    if (!refMap.has(c.mint)) refMap.set(c.mint, priceUsd)
    const createdAt = c.createdAt > 0 ? c.createdAt : p.createdAt
    const ageMs = Math.max(0, now - createdAt)
    rows.push({
      id: c.mint,
      symbol: c.symbol.slice(0, 12),
      name: c.name.slice(0, 40),
      emoji: pumpEmoji(c.mint),
      priceUsd,
      refUsd: ref,
      mcapUsd: c.mcapUsd,
      ageMs,
      // Jupiter liquidity is the real exit depth, in USD.
      liquidityUsd: p.liquidityUsd,
      volumeUsd: 0,
      isNew: ageMs < 60 * 60 * 1000,
      momentumPct: p.priceChange24h,
      score: 0,
      verdict: 'neutral' as PumpCoinRow['verdict'],
      mint: c.mint,
      decimals: p.decimals || c.decimals,
    })
  }
  return rows
}

export function usePumpFunBot(wallet?: UseWallet) {
  const [state, setState] = useState<PumpFunState>(() => {
    const now = Date.now()
    const coins = buildCoins(PUMP_COIN_SEEDS, now)
    const priceHistory: Record<string, number[]> = {}
    for (const c of coins) {
      const h: number[] = []
      for (let i = 20; i >= 0; i--) {
        h.push(mockPumpUsdPrice(c.id, c.refUsd, now - i * 10000, { isNew: c.isNew }))
      }
      priceHistory[c.id] = h
    }
    // LIVE positions survive a refresh: without this the bot forgets the mints
    // it holds in the wallet and buys the same coin twice.
    const snap = loadLiveSnapshot<PumpHolding>(LIVE_BOT)
    return {
      enabled: false,
      config: { ...DEFAULT_PUMPFUN_CONFIG },
      cashUsd: snap?.cashUsd ?? DEFAULT_PUMPFUN_CONFIG.capitalUsd,
      coins,
      holdings: snap?.open ?? [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: snap
        ? [
            {
              time: Date.now(),
              msg: `Sesión live restaurada: ${snap.open.length} posición(es) abierta(s) desde ${new Date(snap.savedAt).toLocaleString()}. Se verificará contra la wallet al arrancar.`,
              level: 'info',
            },
          ]
        : [],
      status: 'idle',
      priceHistory,
      opps: [],
      lastUpdatedAt: null,
      dataSource: 'mock',
      halted: false,
      haltReason: null,
      walletAddress: null,
      solBalance: null,
    }
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  /** First price ever seen per mint: the "drifted reference" for cheap entries. */
  const refPriceRef = useRef(new Map<string, number>())
  /** Consecutive ticks without usable live data (live mode halts at 3). */
  const feedFailsRef = useRef(0)

  const log = useCallback((msg: string, level: PumpFunLogEntry['level'] = 'info') => {
    setState((s) => ({
      ...s,
      logs: [{ time: Date.now(), msg, level }, ...s.logs].slice(0, LOG_CAP),
    }))
    console[level === 'trade' ? 'log' : level](`[pumpfun] ${msg}`)
  }, [])

  /**
   * Stop the bot and surface why. Triggered whenever a REAL swap path fails:
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
      const cfg = s0.config

      // 1a. LIVE preflight: wallet, on-chain SOL balance and the SOL/USD price
      // that sizes every swap and prices the curve liquidity. All of it has to
      // be known before any coin is considered.
      let solUsd = 0
      /** Open positions confirmed against the chain this tick (live only). */
      let reconciled: PumpHolding[] = []
      if (cfg.liveTrading) {
        if (!wallet || !wallet.connected || !wallet.publicKey) {
          halt('modo live sin wallet Phantom conectada')
          return
        }
        const connection = wallet.getConnection()
        if (!connection) {
          halt('modo live sin conexión RPC de Solana')
          return
        }
        // Reconcile the real SOL balance: never size an order we cannot pay.
        let solBalance = 0
        try {
          solBalance =
            (await connection.getBalance(new PublicKey(wallet.publicKey), 'confirmed')) /
            LAMPORTS_PER_SOL
        } catch (e) {
          halt(`no se pudo leer el saldo de SOL on-chain: ${(e as Error).message}`)
          return
        }
        if (solBalance < 0.01) {
          halt(
            `saldo SOL insuficiente: ${solBalance.toFixed(4)} SOL — se necesitan al menos 0.01 para operar`
          )
          return
        }
        setState((s) => ({
          ...s,
          walletAddress: wallet.publicKey,
          solBalance,
        }))
        solUsd = await realTokenPriceUsd(WSOL_MINT).catch(() => 0)
        if (!(solUsd > 0)) {
          halt('no se pudo obtener el precio de SOL en USD; no se pueden dimensionar swaps')
          return
        }

        // The chain decides the quantities. A refresh, a manual swap from
        // another tab or a partial fill all show up here.
        const openNow = stateRef.current.holdings.filter((h) => h.status === 'open' && h.mint)
        if (openNow.length > 0) {
          const balances = new Map<string, number>()
          for (const h of openNow) {
            balances.set(
              h.mint as string,
              await getTokenBalance(connection, wallet.publicKey, h.mint as string, h.decimals ?? 6)
            )
          }
          const rec = reconcileLiveState<PumpHolding>({
            bot: LIVE_BOT,
            persisted: openNow,
            balances,
            minQty: 0.000000001,
            view: (h) => ({
              liveAsset: h.mint ?? '',
              liveQty: h.qty,
              liveLabel: `${h.symbol} (${h.name})`,
            }),
            withQty: (h, qty) => ({ ...h, qty }),
          })
          for (const n of rec.notes) log(`PumpFun: ${n}`, 'info')
          if (rec.fatal) {
            halt(rec.fatal)
            return
          }
          if (rec.missing.length > 0) {
            log(
              `PumpFun: ${rec.missing.length} posición(es) ya no están en la wallet y se marcan como cerradas`,
              'warn'
            )
          }
          reconciled = rec.holdings
        }
      }

      if (!cfg.liveTrading && cfg.dataMode === 'live') {
        solUsd = await realTokenPriceUsd(WSOL_MINT).catch(() => 0)
      }
      // Demo fills come from REAL Jupiter quotes (pool fee + price impact
      // included), exactly what the live swap would get. No quote → no fill.
      const paperQuote = (inMint: string, inDec: number, outMint: string, outDec: number, amount: number) =>
        fetchRealQuote(inMint, outMint, amount, SLIPPAGE_BPS, [
          { mint: inMint, decimals: inDec, symbol: 'IN', name: 'IN' },
          { mint: outMint, decimals: outDec, symbol: 'OUT', name: 'OUT' },
        ]).catch(() => null)

      // 1b. Universe. With the real API the rows ARE the pump.fun market, so
      // each coin carries its on-chain mint. Demo mode falls back to the
      // curated fictional seeds when the API is unreachable.
      let coins: PumpCoinRow[]
      let liveData = false
      let liveErr: string | null = null
      const wantLive = cfg.dataMode === 'live' || cfg.liveTrading
      if (wantLive) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 15000)
        try {
          // Core universe (liquid caps) + fresh listings watchlist.
          const [coreRaw, newRaw] = await Promise.all([
            fetchPumpApiCoins(PUMPFUN_API_CORE, ctrl.signal).catch(() => null),
            fetchPumpApiCoins(PUMPFUN_API_NEW, ctrl.signal).catch(() => null),
          ])
          if (!coreRaw && !newRaw) throw new Error('pump.fun no respondió')
          // The core page and the newest-listing page overlap heavily, so the two
          // lists are merged by mint: a duplicated row would otherwise be scored
          // and sized twice for the very same token.
          const merged = new Map<string, PumpApiCoin>()
          for (const c of [
            ...(coreRaw ? parsePumpApiCoins(coreRaw) : []),
            ...(newRaw ? parsePumpApiCoins(newRaw, PUMPFUN_MIN_MCAP_NEW_USD) : []),
          ]) {
            if (!merged.has(c.mint)) merged.set(c.mint, c)
          }
          const discovered = [...merged.values()]
          // Open positions must keep a price even after the mint falls out of
          // the "newest 100" window, otherwise the exit rules never trigger.
          const heldMints = stateRef.current.holdings
            .filter((h) => h.status === 'open' && h.mint)
            .map((h) => h.mint as string)
          const known = new Set(discovered.map((d) => d.mint))
          const heldExtra: PumpApiCoin[] = heldMints
            .filter((m) => !known.has(m))
            .map((m) => {
              const h = stateRef.current.holdings.find((x) => x.mint === m)
              return {
                mint: m,
                name: h?.name ?? 'Posición abierta',
                symbol: h?.symbol ?? m.slice(0, 6),
                decimals: h?.decimals ?? 6,
                priceUsd: h?.currentPriceUsd ?? 0,
                mcapUsd: 0,
                createdAt: h?.boughtAt ?? now,
                curveSol: 0,
                complete: false,
                tokenProgram: '',
              }
            })
          const prices = await fetchJupiterTokenPrices(
            [...discovered.map((d) => d.mint), ...heldMints],
            ctrl.signal
          )
          const rows = buildLiveCoins(
            [...discovered, ...heldExtra],
            prices,
            now,
            refPriceRef.current,
            new Set(heldMints)
          )
          if (rows.length > 0) {
            coins = rows
            liveData = true
          } else {
            liveErr = `sin precios ejecutables en Jupiter (${discovered.length} mints descubiertos)`
            coins = []
          }
        } catch (e) {
          liveErr = (e as Error).message
          coins = []
        } finally {
          clearTimeout(timer)
        }
      } else {
        coins = buildCoins(PUMP_COIN_SEEDS, now)
      }

      // A dead price feed must not trade on stale or simulated data — in the
      // demo either. Skip the tick; with real money halt after repeated failures.
      if (wantLive && coins.length === 0) {
        feedFailsRef.current += 1
        if (cfg.liveTrading && feedFailsRef.current >= 3) {
          halt(`API de pump.fun sin datos utilizables (${liveErr ?? 'sin respuesta'}); el bot se detiene`)
          return
        }
        log(`⚠ pump.fun no disponible (${liveErr ?? 'sin datos'}); tick omitido`, 'warn')
        return
      }
      if (liveData) feedFailsRef.current = 0

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
      let holdings = stateRef.current.holdings.map((h) => ({ ...h }))
      if (reconciled.length > 0) {
        const gone = new Set(
          stateRef.current.holdings
            .filter((h) => h.status === 'open' && h.mint && !reconciled.some((r) => r.id === h.id))
            .map((h) => h.id)
        )
        holdings = [
          ...reconciled,
          ...holdings
            .filter((h) => h.status === 'open' && !h.mint)
            .map((h) => ({ ...h }))
            .concat(
              stateRef.current.holdings
                .filter((h) => gone.has(h.id))
                .map((h) => ({
                  ...h,
                  status: 'sold' as const,
                  soldAt: now,
                  sellPriceUsd: h.currentPriceUsd,
                  pnlUsd: 0,
                }))
            ),
        ]
      }
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
          // LIVE: swap the position back to SOL. The mint is what makes this
          // possible, so a position without one cannot be closed for real.
          if (cfg.liveTrading) {
            if (!wallet || !wallet.connected || !wallet.publicKey) {
              halt('modo live sin wallet Phantom conectada')
              return
            }
            if (!h.mint || !isValidMint(h.mint)) {
              halt(`no se puede cerrar ${h.symbol} en real: la posición no tiene un mint on-chain válido`)
              return
            }
            const connection = wallet.getConnection()
            if (!connection) {
              halt('modo live sin conexión RPC de Solana')
              return
            }
            const decimals = h.decimals && h.decimals > 0 ? h.decimals : 6
            const tokenHuman = h.qty
            if (!(tokenHuman > 0)) {
              halt(`saldo de ${h.symbol} es 0; nada que vender`)
              return
            }
            let quote
            try {
              quote = await fetchRealQuote(
                h.mint,
                WSOL_MINT,
                tokenHuman,
                SLIPPAGE_BPS,
                [
                  {
                    mint: h.mint,
                    decimals,
                    symbol: h.symbol,
                    name: h.name,
                  },
                  {
                    mint: WSOL_MINT,
                    decimals: SOL_DECIMALS,
                    symbol: 'SOL',
                    name: 'Wrapped SOL',
                  },
                ]
              )
            } catch (e) {
              halt(`cotización de venta ${h.symbol} fallida: ${(e as Error).message}`)
              return
            }
            if (!quote) {
              halt(`sin ruta de liquidez para vender ${h.symbol} a SOL`)
              return
            }
            let exec
            try {
              exec = await executeRealSwap({
                userPublicKey: wallet.publicKey,
                connection,
                quote,
                inSymbol: h.symbol,
                outSymbol: 'SOL',
                inDecimals: decimals,
                outDecimals: SOL_DECIMALS,
              })
            } catch (e) {
              halt(`venta de ${h.symbol} rechazada: ${(e as Error).message}`)
              return
            }
            if (!exec.success) {
              halt(`venta de ${h.symbol} no confirmada: ${exec.error ?? 'transacción fallida'}`)
              return
            }
            const outUsd = exec.outHuman * solUsd
            const inputUsd = h.buyPriceUsd * h.qty
            const pnl = outUsd - inputUsd
            const pnlBps = Math.round((pnl / Math.max(inputUsd, 1e-9)) * 10000)
            h.status = 'sold'
            h.soldAt = now
            h.sellPriceUsd = exec.outHuman > 0 ? outUsd / h.qty : current
            h.pnlUsd = pnl
            cash += outUsd
            trades.unshift({
              id: `ppt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              type: 'sell',
              symbol: h.symbol,
              name: h.name,
              emoji: h.emoji,
              qty: h.qty,
              priceUsd: h.sellPriceUsd,
              inputUsd,
              outUsd,
              pnlUsd: pnl,
              profitBps: pnlBps,
              reason: `${reason} (real, tx ${exec.signature.slice(0, 12)}…)`,
              status: 'filled',
              createdAt: now,
            })
            log(
              `LIVE VENTA ${h.qty.toFixed(4)} ${h.symbol} → ${exec.outHuman.toFixed(6)} SOL (${outUsd >= 0 ? '+' : ''}${fmtUsdPump(outUsd, 2)} USD) · tx ${exec.signature.slice(0, 12)}…`,
              'trade'
            )
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdPump(cash, 2)} USD (P&L real ${pnl >= 0 ? '+' : ''}${fmtUsdPump(pnl, 2)})`,
              'info'
            )
            continue
          }

          let outUsd: number
          if (liveData && h.mint && isValidMint(h.mint) && solUsd > 0) {
            const q = await paperQuote(h.mint, h.decimals && h.decimals > 0 ? h.decimals : 6, WSOL_MINT, SOL_DECIMALS, h.qty)
            if (!q || !(q.outAmount > 0)) {
              log(`⏭ ${h.symbol}: sin ruta de liquidez en Jupiter para vender — se reintenta`, 'warn')
              continue
            }
            outUsd = (q.outAmount / 10 ** SOL_DECIMALS) * solUsd * (1 - TAKER_FEE.jupiterNetwork)
          } else {
            // explicit simulation mode: flat swap cost
            outUsd = current * h.qty * (1 - SIM_SWAP_COST)
          }
          const sellPrice = outUsd / h.qty
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
          if (cfg.compound) {
            log(
              `⚡ Interés compuesto: capital disponible → ${fmtUsdPump(cash, 2)} USD (P&L ${pnl >= 0 ? '+' : ''}${fmtUsdPump(pnl, 2)})`,
              'info'
            )
          }
        } else {
          h.peakPriceUsd = Math.max(h.peakPriceUsd, current)
        }
      }

      // 4. BUY cheap coins — scored opportunities
      const openCount = holdings.filter((h) => h.status === 'open').length
      const investedBeforePump = holdings
        .filter((h) => h.status === 'open')
        .reduce((a, h) => a + h.buyPriceUsd * h.qty, 0)
      const equityBeforePump = cash + investedBeforePump
      // Compound interest: scale per-trade budget with grown capital
      const compoundFactor = cfg.compound ? Math.max(equityBeforePump, 1) / Math.max(cfg.capitalUsd, 1) : 1
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
        const spend = Math.min(cfg.budgetPerTradeUsd * compoundFactor, cash)
        if (spend < 0.01) break
        const qty = spend / c.priceUsd

        // LIVE: swap SOL → coin through Jupiter. Only coins with a real mint
        // can be traded; the demo universe is fictional.
        if (cfg.liveTrading) {
          if (!wallet || !wallet.connected || !wallet.publicKey) {
            halt('modo live sin wallet Phantom conectada')
            return
          }
          if (!isValidMint(c.mint)) {
            log(
              `⏭ ${c.symbol}: sin mint on-chain válido (${c.mint || 'desconocido'}) — no se puede comprar en real`,
              'warn'
            )
            continue
          }
          const connection = wallet.getConnection()
          if (!connection) {
            halt('modo live sin conexión RPC de Solana')
            return
          }
          const decimals = c.decimals > 0 ? c.decimals : 6
          const spendSol = spend / solUsd
          if (!(spendSol > 0)) {
            log(`⏭ ${c.symbol}: ${fmtUsdPump(spend, 2)} USD no alcanza una fracción de lamport`, 'warn')
            continue
          }
          let quote
          try {
            quote = await fetchRealQuote(
              WSOL_MINT,
              c.mint,
              spendSol,
              SLIPPAGE_BPS,
              [
                {
                  mint: WSOL_MINT,
                  decimals: SOL_DECIMALS,
                  symbol: 'SOL',
                  name: 'Wrapped SOL',
                },
                { mint: c.mint, decimals, symbol: c.symbol, name: c.name },
              ]
            )
          } catch (e) {
            halt(`cotización de compra ${c.symbol} fallida: ${(e as Error).message}`)
            return
          }
          if (!quote) {
            log(`⏭ ${c.symbol}: sin ruta de liquidez SOL → ${c.symbol}`, 'warn')
            continue
          }
          let exec
          try {
            exec = await executeRealSwap({
              userPublicKey: wallet.publicKey,
              connection,
              quote,
              inSymbol: 'SOL',
              outSymbol: c.symbol,
              inDecimals: SOL_DECIMALS,
              outDecimals: decimals,
            })
          } catch (e) {
            halt(`compra de ${c.symbol} rechazada: ${(e as Error).message}`)
            return
          }
          if (!exec.success) {
            halt(`compra de ${c.symbol} no confirmada: ${exec.error ?? 'transacción fallida'}`)
            return
          }
          const realQty = exec.outHuman
          if (!(realQty > 0)) {
            halt(`compra de ${c.symbol} devolvió 0 tokens`)
            return
          }
          const unitPrice = spend / realQty
          holdings.unshift({
            id: `pph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            coinId: c.id,
            symbol: c.symbol,
            name: c.name,
            emoji: c.emoji,
            qty: realQty,
            buyPriceUsd: unitPrice,
            currentPriceUsd: unitPrice,
            peakPriceUsd: unitPrice,
            buyPair: 'pump.fun',
            status: 'open',
            boughtAt: now,
            mint: c.mint,
            decimals,
            realSignature: exec.signature,
          })
          trades.unshift({
            id: `ppt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: 'buy',
            symbol: c.symbol,
            name: c.name,
            emoji: c.emoji,
            qty: realQty,
            priceUsd: unitPrice,
            inputUsd: spend,
            outUsd: spend,
            pnlUsd: 0,
            profitBps: 0,
            reason: `Op. score ${c.score} · ${c.symbol} barato (${fmtMcap(c.mcapUsd)} mcap) [real, tx ${exec.signature.slice(0, 12)}…]`,
            status: 'filled',
            createdAt: now,
          })
          cash -= spend
          buys++
          openSymbols.add(c.symbol)
          log(
            `LIVE COMPRA ${realQty.toFixed(4)} ${c.symbol} por ${fmtUsdPump(spend, 2)} USD (score ${c.score}) · tx ${exec.signature.slice(0, 12)}…`,
            'trade'
          )
          continue
        }

        let paperQty: number
        const paperDecimals = c.decimals > 0 ? c.decimals : 6
        if (liveData && isValidMint(c.mint) && solUsd > 0) {
          const q = await paperQuote(WSOL_MINT, SOL_DECIMALS, c.mint, paperDecimals, (spend * (1 - TAKER_FEE.jupiterNetwork)) / solUsd)
          if (!q || !(q.outAmount > 0)) {
            log(`⏭ ${c.symbol}: sin ruta de liquidez en Jupiter — no se simula la compra`, 'warn')
            continue
          }
          paperQty = q.outAmount / 10 ** paperDecimals
        } else {
          paperQty = (spend * (1 - SIM_SWAP_COST)) / c.priceUsd
        }
        if (!(paperQty > 0)) continue
        const paperUnit = spend / paperQty
        holdings.unshift({
          id: `pph_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          coinId: c.id,
          symbol: c.symbol,
          name: c.name,
          emoji: c.emoji,
          qty: paperQty,
          buyPriceUsd: paperUnit,
          currentPriceUsd: c.priceUsd,
          peakPriceUsd: c.priceUsd,
          buyPair: 'pump.fun',
          status: 'open',
          boughtAt: now,
          mint: isValidMint(c.mint) ? c.mint : undefined,
          decimals: paperDecimals,
        })
        trades.unshift({
          id: `ppt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'buy',
          symbol: c.symbol,
          name: c.name,
          emoji: c.emoji,
          qty: paperQty,
          priceUsd: paperUnit,
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
        compound: cfg.compound,
        compoundFactor,
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

      // Persist only what a refresh must not lose: the open live positions.
      if (cfg.liveTrading) {
        saveLiveSnapshot(
          LIVE_BOT,
          holdings.filter((h) => h.status === 'open'),
          { cashUsd: cash, wasRunning: true }
        )
      }

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
    const cfg = stateRef.current.config
    if (cfg.liveTrading) {
      if (!wallet || !wallet.connected || !wallet.publicKey) {
        halt('modo live sin wallet Phantom conectada — conéctala antes de iniciar')
        return
      }
      if (!wallet.installed) {
        halt('modo live requiere Phantom instalado en el navegador')
        return
      }
    }
    setState((s) => ({
      ...s,
      enabled: true,
      halted: false,
      haltReason: null,
      status: 'scanning',
      walletAddress: cfg.liveTrading ? (wallet?.publicKey ?? null) : s.walletAddress,
      stats: s.stats ? { ...s.stats, running: true } : s.stats,
    }))
    log(
      cfg.liveTrading
        ? `PUMPFUN BOT iniciado en MODO LIVE — swaps reales Jupiter desde ${wallet?.shortAddress ?? 'la wallet'}`
        : `PUMPFUN BOT iniciado - ${cfg.capitalUsd.toFixed(2)} USD ficticios, hunting meme dips & pumps`,
      'trade'
    )
    if (loopRef.current) clearInterval(loopRef.current)
    loopRef.current = setInterval(() => {
      scan().catch((e) => {
        if (stateRef.current.config.liveTrading) halt(`error inesperado: ${e.message}`)
        else log(`Scan error: ${e.message}`, 'error')
      })
    }, cfg.tickIntervalMs)
  }, [scan, log, halt, wallet])

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
      halted: false,
      haltReason: null,
      status: 'idle',
      cashUsd: cfg.capitalUsd,
      holdings: [],
      trades: [],
      stats: null,
      equityCurve: [],
      logs: [],
      opps: [],
    }))
    clearLiveSnapshot(LIVE_BOT)
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
    halt,
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

function fmtUsdPump(n: number, d = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

export type PumpFunBot = ReturnType<typeof usePumpFunBot>