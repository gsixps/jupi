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
  SOL_DECIMALS,
  WSOL_MINT,
  isValidMint,
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
import { executeRealSwap, fetchRealQuote } from '@/lib/jupiter-swap'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import type { TokenInfo } from '@/lib/trading-types'
import { realTokenPriceUsd } from '@/lib/cex'
import type { UseWallet } from '@/hooks/use-wallet'

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

/** Build coin rows for the watched universe. */
interface PumpLiveQuote {
  priceUsd: number
  mcapUsd: number
  /** Real on-chain mint, only present when the API row carried a valid one. */
  mint: string
  decimals: number
}

function buildCoins(
  seeds: PumpCoinSeed[],
  now: number,
  mode: PumpFunConfig['dataMode'],
  live?: Record<string, PumpLiveQuote>
): PumpCoinRow[] {
  return seeds.map((s) => {
    let priceUsd: number
    let mcapUsd: number
    let refUsd = mockPumpRefUsd(s.id, s.baseUsd, now)
    let mint = ''
    let decimals = 0
    if (live && live[s.id]) {
      const lv = live[s.id]
      mint = lv.mint
      decimals = lv.decimals
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
      mint,
      decimals,
    }
  })
}

async function fetchPumpCoins(): Promise<Record<string, PumpLiveQuote>> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const res = await fetch(PUMPFUN_API_BASE, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`pump.fun api ${res.status}`)
    const j = await res.json()
    const arr = (Array.isArray(j) ? j : ((j as { coins?: unknown[] }).coins ?? [])) as {
      mint?: string
      address?: string
      symbol?: string
      name?: string
      price?: number
      usd_price?: number
      usd_market_cap?: number
      market_cap_usd?: number
      decimals?: number
    }[]
    const out: Record<string, PumpLiveQuote> = {}
    for (const c of arr) {
      if (!c.symbol) continue
      const ext = c.usd_market_cap ?? c.market_cap_usd
      const key = PUMP_COIN_SEEDS.find(
        (s) => s.symbol.toLowerCase() === c.symbol!.toLowerCase()
      )?.id
      if (!key) continue
      const mint = c.mint ?? c.address ?? ''
      out[key] = {
        priceUsd: c.usd_price ?? c.price ?? NaN,
        mcapUsd: ext ?? NaN,
        // Only a real base58 mint is usable for an on-chain swap.
        mint: isValidMint(mint) ? mint : '',
        decimals: c.decimals ?? 6,
      }
    }
    return out
  } catch (e) {
    throw e
  } finally {
    clearTimeout(t)
  }
}

export function usePumpFunBot(wallet?: UseWallet) {
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

      // LIVE: the swaps are sized in SOL, so its USD price drives both the
      // lamport sizing and the USD P&L. It must be known before any order.
      let solUsd = 0
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
          solBalance = (await connection.getBalance(new PublicKey(wallet.publicKey), 'confirmed')) / LAMPORTS_PER_SOL
        } catch (e) {
          halt(`no se pudo leer el saldo de SOL on-chain: ${(e as Error).message}`)
          return
        }
        if (solBalance < 0.01) {
          halt(`saldo SOL insuficiente: ${solBalance.toFixed(4)} SOL — se necesitan al menos 0.01 para operar`)
          return
        }
        setState((s) => ({
          ...s,
          walletAddress: wallet.publicKey,
          solBalance,
        }))
        try {
          solUsd = await realTokenPriceUsd(WSOL_MINT)
        } catch (e) {
          halt(`no se pudo obtener el precio de SOL: ${(e as Error).message}`)
          return
        }
        if (!(solUsd > 0)) {
          halt('no se pudo obtener el precio de SOL en USD; no se pueden dimensionar swaps')
          return
        }
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
    if (loopRef.current) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    log(`Cuenta reiniciada a ${cfg.capitalUsd.toFixed(2)} USD`, 'info')
  }, [log])

  const updateConfig = useCallback((patch: Partial<PumpFunConfig>) => {
    setState((s) => {
      // Interest compounding is mandatory: the patch can never turn it off.
      const next = { ...s.config, ...patch, compound: true }
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