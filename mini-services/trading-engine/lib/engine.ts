// TradingEngine - the core engine class
import type { Server as SocketIOServer, Socket } from "socket.io"
import type {
  BotConfig,
  BotStats,
  Position,
  Trade,
  PriceTick,
  ArbitrageOpportunity,
  EquityPoint,
  TokenInfo,
} from "./types"
import { EVENTS } from "./types"
import { USDC_MINT, fetchTokenList, toBaseAmount, fromBaseAmount } from "./tokens"
import { fetchPrices, fetchQuote } from "./jupiter"
import {
  loadConfig,
  saveConfig,
  insertTrade,
  insertEquityPoint,
  insertPriceTick,
  loadRecentTrades,
  loadEquityHistory,
  upsertPosition,
  deletePosition,
  loadOpenPositions,
} from "./db"
import {
  computeSMA,
  meanReversionSignal,
  shouldClosePosition,
  buildArbCycles,
  computeCycleReturn,
  type CloseSignal,
} from "./strategy"

const PRICE_HISTORY_CAP = 60
const TRADE_RING_CAP = 200
const EQUITY_RING_CAP = 200
const ARB_OPP_RING_CAP = 50
const ARB_SCAN_EVERY_N = 3
const EQUITY_FLUSH_EVERY_N = 2

function genId(prefix = "t"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export class TradingEngine {
  io: SocketIOServer

  config: BotConfig
  tokens: TokenInfo[] = []
  running = false
  startedAt: number | null = null

  balance = 0
  positions: Map<string, Position> = new Map()
  priceHistory: Map<string, number[]> = new Map()
  lastPrices: Map<string, number> = new Map()
  change24h: Map<string, number> = new Map()

  trades: Trade[] = []
  equityCurve: EquityPoint[] = []
  arbitrageOpportunities: ArbitrageOpportunity[] = []

  scanCount = 0
  lastScanAt: number | null = null
  loopTimer: ReturnType<typeof setInterval> | null = null

  private initialized = false

  constructor(io: SocketIOServer) {
    this.io = io
    this.config = {
      running: false,
      capital: 1000,
      maxPositions: 5,
      tradeSizePct: 10,
      buyThreshold: 1.5,
      sellThreshold: 1.5,
      stopLossPct: 3,
      arbMinProfitBps: 40,
      slippageBps: 50,
      scanIntervalMs: 4000,
      tokens: [],
    }
  }

  async init(): Promise<void> {
    // Load config from DB
    this.config = await loadConfig()

    // If tokens list empty, resolve from token list and save
    if (!this.config.tokens || this.config.tokens.length === 0) {
      const tokens = await fetchTokenList()
      this.config.tokens = tokens.filter((t) => t.mint !== USDC_MINT).map((t) => t.mint)
      await saveConfig(this.config)
    }

    // Resolve full TokenInfo objects for the configured mints
    const allTokens = await fetchTokenList()
    this.tokens = allTokens.filter((t) => this.config.tokens.includes(t.mint))
    // Always include USDC for USD<->token conversions in price maps
    if (!this.tokens.find((t) => t.mint === USDC_MINT)) {
      const usdc = allTokens.find((t) => t.mint === USDC_MINT)
      if (usdc) this.tokens.unshift(usdc)
    }

    // Set balance from capital
    this.balance = this.config.capital

    // Load recent trades + equity history so restart shows history
    this.trades = await loadRecentTrades(TRADE_RING_CAP)
    this.equityCurve = await loadEquityHistory(EQUITY_RING_CAP)

    // Load open positions from DB (state recovery)
    const openPositions = await loadOpenPositions()
    for (const p of openPositions) {
      this.positions.set(p.mint, p)
    }

    // Sync running flag from config (in case process restarted while running)
    this.running = this.config.running
    if (this.running) {
      this.startedAt = Date.now() - 1000 // approximate
      this.emitLog("Bot auto-resumed (was running on restart)")
    }

    this.initialized = true
    this.emitLog("Engine initialized")

    // Start the scan loop (always runs to stream prices; only trades when running)
    this.startLoop()
  }

  /** Start or restart the scan loop using the configured interval. */
  private startLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer)
    const interval = Math.max(1000, this.config.scanIntervalMs || 4000)
    this.loopTimer = setInterval(() => {
      this.scan().catch((err) => {
        console.error("[scan] error:", err)
        this.emitLog(`Scan error: ${err?.message ?? String(err)}`)
      })
    }, interval)
  }

  start(): void {
    this.running = true
    this.startedAt = Date.now()
    this.config.running = true
    saveConfig(this.config).catch((e) => console.error("[saveConfig]", e))
    this.emitLog("Bot started")
    this.emitStats()
  }

  stop(): void {
    this.running = false
    this.startedAt = null
    this.config.running = false
    saveConfig(this.config).catch((e) => console.error("[saveConfig]", e))
    this.emitLog("Bot stopped (price streaming continues)")
    this.emitStats()
  }

  /** The main scan loop body. Never throws - catches internally. */
  async scan(): Promise<void> {
    const now = Date.now()
    this.scanCount++
    this.lastScanAt = now

    // 1. Fetch prices for all token mints
    const mints = this.config.tokens
    let prices: Record<string, number> = {}
    try {
      prices = await fetchPrices(mints)
    } catch (e) {
      console.warn("[scan] fetchPrices failed:", e)
      this.emitLog(`fetchPrices failed: ${(e as Error).message}`)
      // Still continue - we keep the loop alive, prices stays empty this round
    }

    // 2. For each token with a price: update lastPrices, push to priceHistory, emit PRICE_TICK
    for (const mint of mints) {
      const p = prices[mint]
      if (typeof p !== "number" || p <= 0) continue
      this.lastPrices.set(mint, p)

      let hist = this.priceHistory.get(mint)
      if (!hist) {
        hist = []
        this.priceHistory.set(mint, hist)
      }
      hist.push(p)
      if (hist.length > PRICE_HISTORY_CAP) hist.splice(0, hist.length - PRICE_HISTORY_CAP)

      const tok = this.tokens.find((t) => t.mint === mint)
      const symbol = tok?.symbol ?? "UNKNOWN"
      const tick: PriceTick = {
        mint,
        symbol,
        price: p,
        changePct24h: this.change24h.get(mint) ?? 0,
        timestamp: now,
      }
      this.io.emit(EVENTS.PRICE_TICK, tick)

      // 3. Persist price tick to DB (with aggressive pruning to 100/mint)
      insertPriceTick(tick).catch((e) =>
        console.warn("[insertPriceTick]", mint, e?.message ?? e)
      )
    }

    // 4. If running: run mean reversion strategy per token. Run arbitrage scan.
    if (this.running) {
      try {
        await this.runMeanReversion(now)
      } catch (e) {
        console.error("[scan] mean reversion error:", e)
        this.emitLog(`Mean reversion error: ${(e as Error).message}`)
      }

      // Arbitrage only every N scans when running
      if (this.scanCount % ARB_SCAN_EVERY_N === 0) {
        try {
          await this.runArbitrageScan(now)
        } catch (e) {
          console.error("[scan] arbitrage error:", e)
          this.emitLog(`Arbitrage scan error: ${(e as Error).message}`)
        }
      }
    }

    // 5. Recompute stats, emit STATS
    this.emitStats()

    // 6. Compute equity, push EquityPoint (throttle to every 2 scans), emit EQUITY_POINT
    if (this.scanCount % EQUITY_FLUSH_EVERY_N === 0) {
      try {
        const stats = this.computeStats()
        const point: EquityPoint = {
          timestamp: now,
          equity: stats.equity,
          balance: this.balance,
          openPnl: stats.openPnl,
        }
        this.equityCurve.push(point)
        if (this.equityCurve.length > EQUITY_RING_CAP) {
          this.equityCurve.splice(0, this.equityCurve.length - EQUITY_RING_CAP)
        }
        this.io.emit(EVENTS.EQUITY_POINT, point)
        insertEquityPoint(point).catch((e) =>
          console.warn("[insertEquityPoint]", e?.message ?? e)
        )
      } catch (e) {
        console.error("[scan] equity point error:", e)
      }
    }
  }

  /** Mean reversion strategy per token. */
  private async runMeanReversion(now: number): Promise<void> {
    const cfg = {
      buyThreshold: this.config.buyThreshold,
      sellThreshold: this.config.sellThreshold,
      stopLossPct: this.config.stopLossPct,
    }

    for (const mint of this.config.tokens) {
      const hist = this.priceHistory.get(mint)
      if (!hist || hist.length < 5) continue
      const currentPrice = hist[hist.length - 1]
      const tok = this.tokens.find((t) => t.mint === mint)
      const symbol = tok?.symbol ?? "UNKNOWN"

      // If there's an open position for this mint: check close conditions
      const position = this.positions.get(mint)
      if (position) {
        const closeCheck = shouldClosePosition(position, currentPrice, cfg)
        if (closeCheck.action === "SELL" || closeCheck.action === "STOPLOSS") {
          await this.closePosition(position, currentPrice, closeCheck, now)
        }
        continue
      }

      // Otherwise check buy signal
      const signal = meanReversionSignal(hist, cfg)
      if (signal.action !== "BUY") continue

      const maxedOut = this.positions.size >= this.config.maxPositions
      const tradeAmountUsd = this.balance * (this.config.tradeSizePct / 100)
      if (maxedOut || this.balance < tradeAmountUsd || tradeAmountUsd < 1) continue

      const amount = tradeAmountUsd / currentPrice
      const sma = computeSMA(hist, Math.min(20, hist.length))
      const newPosition: Position = {
        id: genId("p"),
        mint,
        symbol,
        entryPrice: currentPrice,
        amount,
        costUsd: tradeAmountUsd,
        smaAtEntry: sma,
        openedAt: now,
      }
      this.balance -= tradeAmountUsd
      this.positions.set(mint, newPosition)
      upsertPosition(newPosition).catch((e) =>
        console.warn("[upsertPosition]", e?.message ?? e)
      )
      this.io.emit(EVENTS.POSITION_OPENED, { position: newPosition })
      this.emitLog(
        `BUY ${amount.toFixed(4)} ${symbol} @ ${currentPrice.toFixed(4)} (oversold) - $${tradeAmountUsd.toFixed(2)}`
      )
    }
  }

  /** Close an open position and record the trade. */
  private async closePosition(
    position: Position,
    currentPrice: number,
    closeCheck: CloseSignal,
    now: number
  ): Promise<void> {
    const pnl = (currentPrice - position.entryPrice) * position.amount
    const outputAmount = position.amount * currentPrice
    this.balance += outputAmount
    this.positions.delete(position.mint)
    deletePosition(position.id).catch((e) =>
      console.warn("[deletePosition]", e?.message ?? e)
    )

    const trade: Trade = {
      id: genId("t"),
      strategy: "mean_reversion",
      side: "SELL",
      inputMint: position.mint,
      outputMint: USDC_MINT,
      inputSymbol: position.symbol,
      outputSymbol: "USDC",
      inputAmount: position.amount,
      outputAmount,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      pnl,
      pnlPct: closeCheck.pnlPct,
      win: pnl > 0,
      route: [`${position.symbol}->USDC`],
      reason: closeCheck.reason,
      openedAt: position.openedAt,
      closedAt: now,
    }
    this.pushTrade(trade)
    insertTrade(trade).catch((e) => console.warn("[insertTrade]", e?.message ?? e))
    this.io.emit(EVENTS.POSITION_CLOSED, { position, trade, pnl, pnlPct: closeCheck.pnlPct })
    this.io.emit(EVENTS.TRADE, trade)
    this.emitLog(
      `${closeCheck.action} ${position.symbol} pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${closeCheck.pnlPct.toFixed(2)}%) - ${closeCheck.reason}`
    )
  }

  /** Arbitrage scan: triangular cycles. */
  private async runArbitrageScan(now: number): Promise<void> {
    // Need at least 3 tradable tokens (excluding USDC) to form a cycle [USDC, A, B, USDC]
    const tradableMints = this.config.tokens.filter((m) => m !== USDC_MINT)
    if (tradableMints.length < 2) return // need at least 2 non-USDC tokens to form a pair

    const cycles = buildArbCycles(tradableMints, USDC_MINT).slice(0, 6)
    if (cycles.length === 0) return

    const slippageBps = this.config.slippageBps
    const arbInputUsd = Math.min(
      this.balance,
      this.config.capital * (this.config.tradeSizePct / 100) * 0.5
    )
    if (arbInputUsd < 1) return

    for (const cycle of cycles) {
      // cycle = [USDC, A, B, USDC]
      const [usdc, a, b] = cycle
      if (usdc !== USDC_MINT) continue

      // leg1: USDC -> A
      const leg1 = await fetchQuote(
        USDC_MINT,
        a,
        toBaseAmount(arbInputUsd, 6),
        slippageBps,
        this.tokens
      )
      if (!leg1 || leg1.outAmount <= 0) continue

      // leg2: A -> B
      const leg2 = await fetchQuote(a, b, leg1.outAmount, slippageBps, this.tokens)
      if (!leg2 || leg2.outAmount <= 0) continue

      // leg3: B -> USDC
      const leg3 = await fetchQuote(b, USDC_MINT, leg2.outAmount, slippageBps, this.tokens)
      if (!leg3 || leg3.outAmount <= 0) continue

      // Compute return
      const { profitUsd, profitPct, profitBps, outUsd } = computeCycleReturn(
        [leg1, leg2, leg3],
        arbInputUsd,
        {}
      )

      const aSym = this.tokens.find((t) => t.mint === a)?.symbol ?? "A"
      const bSym = this.tokens.find((t) => t.mint === b)?.symbol ?? "B"
      const symbols = ["USDC", aSym, bSym, "USDC"]

      const opp: ArbitrageOpportunity = {
        id: genId("arb"),
        cycle,
        symbols,
        legs: [
          { from: "USDC", to: aSym, outPerIn: leg1.outPerIn },
          { from: aSym, to: bSym, outPerIn: leg2.outPerIn },
          { from: bSym, to: "USDC", outPerIn: leg3.outPerIn },
        ],
        inputAmountUsd: arbInputUsd,
        outputAmountUsd: outUsd,
        profitUsd,
        profitPct,
        profitBps,
        detectedAt: now,
        executed: false,
      }

      if (profitBps >= this.config.arbMinProfitBps) {
        // EXECUTE - the input was "spent", output returned; net = profitUsd
        this.balance += profitUsd
        opp.executed = true
        const trade: Trade = {
          id: genId("t"),
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
          route: [`USDC->${aSym}`, `${aSym}->${bSym}`, `${bSym}->USDC`],
          cycle,
          reason: `Triangular arb ${profitBps.toFixed(0)}bps`,
          openedAt: now,
          closedAt: now,
        }
        this.pushTrade(trade)
        insertTrade(trade).catch((e) => console.warn("[insertTrade/arb]", e?.message ?? e))
        this.io.emit(EVENTS.ARBITRAGE_FOUND, { opportunity: opp })
        this.io.emit(EVENTS.TRADE, trade)
        this.emitLog(
          `ARBITRAGE executed +$${profitUsd.toFixed(2)} on USDC->${aSym}->${bSym}->USDC (${profitBps.toFixed(0)}bps)`
        )
      } else {
        // Just emit as detected (not executed)
        this.io.emit(EVENTS.ARBITRAGE_FOUND, { opportunity: opp })
        if (profitBps > 0) {
          this.emitLog(
            `Arb near miss USDC->${aSym}->${bSym}->USDC: ${profitBps.toFixed(0)}bps (need ${this.config.arbMinProfitBps})`
          )
        }
      }

      // Push to arbitrageOpportunities ring buffer (cap 50)
      this.arbitrageOpportunities.push(opp)
      if (this.arbitrageOpportunities.length > ARB_OPP_RING_CAP) {
        this.arbitrageOpportunities.splice(0, this.arbitrageOpportunities.length - ARB_OPP_RING_CAP)
      }
    }
  }

  /** Push trade to ring buffer (cap 200). */
  private pushTrade(t: Trade): void {
    this.trades.push(t)
    if (this.trades.length > TRADE_RING_CAP) {
      this.trades.splice(0, this.trades.length - TRADE_RING_CAP)
    }
  }

  /** Compute live stats. */
  computeStats(): BotStats {
    const now = Date.now()
    const positionsArr = Array.from(this.positions.values())
    let openPositionsValue = 0
    let openPnl = 0
    for (const p of positionsArr) {
      const cur = this.lastPrices.get(p.mint) ?? p.entryPrice
      openPositionsValue += p.amount * cur
      openPnl += (cur - p.entryPrice) * p.amount
    }
    const equity = this.balance + openPositionsValue

    const totalTrades = this.trades.length
    const wins = this.trades.filter((t) => t.win).length
    const losses = totalTrades - wins
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0
    const totalPnl = this.trades.reduce((s, t) => s + t.pnl, 0)
    const totalPnlPct =
      this.config.capital > 0 ? ((equity - this.config.capital) / this.config.capital) * 100 : 0
    const bestTrade = totalTrades > 0 ? Math.max(...this.trades.map((t) => t.pnl)) : 0
    const worstTrade = totalTrades > 0 ? Math.min(...this.trades.map((t) => t.pnl)) : 0
    const arbTradesExecuted = this.trades.filter((t) => t.strategy === "arbitrage").length

    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
      capital: this.config.capital,
      balance: this.balance,
      equity,
      openPnl,
      openPositions: positionsArr.length,
      totalTrades,
      wins,
      losses,
      winRate,
      totalPnl,
      totalPnlPct,
      bestTrade,
      worstTrade,
      arbOpportunitiesDetected: this.arbitrageOpportunities.length,
      arbTradesExecuted,
      lastScanAt: this.lastScanAt,
      scanCount: this.scanCount,
    }
  }

  private emitStats(): void {
    try {
      const stats = this.computeStats()
      this.io.emit(EVENTS.STATS, stats)
    } catch (e) {
      console.error("[emitStats]", e)
    }
  }

  private emitLog(msg: string): void {
    const entry = { msg, time: Date.now() }
    this.io.emit(EVENTS.LOG, entry)
    console.log(`[engine] ${msg}`)
  }

  /** Send full snapshot to a single socket (on connect / get-state). */
  emitState(socket: Socket): void {
    try {
      // Compress price history to last 20 per mint for snapshot
      const priceHistoryObj: Record<string, number[]> = {}
      for (const [mint, hist] of this.priceHistory.entries()) {
        priceHistoryObj[mint] = hist.slice(-20)
      }
      const lastPricesObj: Record<string, number> = {}
      for (const [mint, p] of this.lastPrices.entries()) lastPricesObj[mint] = p
      const change24hObj: Record<string, number> = {}
      for (const [mint, p] of this.change24h.entries()) change24hObj[mint] = p

      const snapshot = {
        config: this.config,
        tokens: this.tokens,
        stats: this.computeStats(),
        positions: Array.from(this.positions.values()),
        trades: this.trades.slice(-50),
        equityCurve: this.equityCurve,
        arbitrageOpportunities: this.arbitrageOpportunities,
        lastPrices: lastPricesObj,
        change24h: change24hObj,
        priceHistory: priceHistoryObj,
      }
      socket.emit(EVENTS.STATE_SNAPSHOT, snapshot)
    } catch (e) {
      console.error("[emitState]", e)
    }
  }

  /** Merge partial config updates, save, emit log. Does NOT change running here. */
  handleUpdateConfig(newCfg: Partial<BotConfig>): void {
    const oldTokens = new Set(this.config.tokens)
    const updatedTokens = newCfg.tokens
    Object.assign(this.config, newCfg)

    // If tokens changed, reset priceHistory for removed tokens
    if (updatedTokens) {
      const newSet = new Set(updatedTokens)
      for (const mint of oldTokens) {
        if (!newSet.has(mint)) {
          this.priceHistory.delete(mint)
          this.lastPrices.delete(mint)
          this.change24h.delete(mint)
        }
      }
      // Resolve tokens list
      fetchTokenList()
        .then((all) => {
          this.tokens = all.filter((t) => this.config.tokens.includes(t.mint))
          if (!this.tokens.find((t) => t.mint === USDC_MINT)) {
            const usdc = all.find((t) => t.mint === USDC_MINT)
            if (usdc) this.tokens.unshift(usdc)
          }
        })
        .catch(() => {})
    }

    saveConfig(this.config).catch((e) => console.error("[saveConfig]", e))
    this.emitLog("Config updated")
    // Restart loop if scanIntervalMs changed
    if (newCfg.scanIntervalMs) {
      this.startLoop()
    }
  }
}
