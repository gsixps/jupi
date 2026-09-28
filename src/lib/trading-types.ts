// Shared trading types for the Jupiter Solana trading bot
// Used by both the Next.js app and the trading-engine mini-service

export interface TokenInfo {
  symbol: string
  name: string
  mint: string
  decimals: number
  logo?: string
  // flag: whether this is a stablecoin (used as quote currency)
  stable?: boolean
}

export type Strategy = "mean_reversion" | "arbitrage"
export type Side = "BUY" | "SELL" | "ARB"

export interface Position {
  id: string
  mint: string
  symbol: string
  entryPrice: number
  amount: number // token amount held
  costUsd: number
  smaAtEntry: number
  openedAt: number // epoch ms
}

export interface Trade {
  id: string
  strategy: Strategy
  side: Side
  inputMint: string
  outputMint: string
  inputSymbol: string
  outputSymbol: string
  inputAmount: number
  outputAmount: number
  entryPrice: number
  exitPrice?: number
  pnl: number
  pnlPct: number
  win: boolean
  route: string[] // e.g. ["USDC->SOL", "SOL->JUP", "JUP->USDC"]
  cycle?: string[] // arbitrage cycle mints
  reason: string
  openedAt: number
  closedAt?: number
}

export interface PriceTick {
  mint: string
  symbol: string
  price: number
  changePct24h?: number
  timestamp: number
}

export interface ArbitrageOpportunity {
  id: string
  cycle: string[] // mint addresses
  symbols: string[] // symbols for display
  legs: { from: string; to: string; outPerIn: number }[]
  inputAmountUsd: number
  outputAmountUsd: number
  profitUsd: number
  profitPct: number
  profitBps: number
  detectedAt: number
  executed: boolean
}

export interface BotStats {
  running: boolean
  startedAt: number | null
  uptimeMs: number
  capital: number // starting capital
  balance: number // current available USDC
  equity: number // balance + open positions value
  openPnl: number // unrealized PnL
  openPositions: number
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  totalPnlPct: number
  bestTrade: number
  worstTrade: number
  arbOpportunitiesDetected: number
  arbTradesExecuted: number
  lastScanAt: number | null
  scanCount: number
}

export interface EquityPoint {
  timestamp: number
  equity: number
  balance: number
  openPnl: number
}

export interface BotConfig {
  running: boolean
  capital: number
  maxPositions: number
  tradeSizePct: number
  /**
   * Interest compounding. When on, the per-trade size follows the CURRENT
   * balance, so profits are reinvested. When off, the size follows the
   * original capital. On by default.
   */
  compoundInterest: boolean
  buyThreshold: number
  sellThreshold: number
  stopLossPct: number
  arbMinProfitBps: number
  slippageBps: number
  scanIntervalMs: number
  tokens: string[] // mint addresses the bot trades
}

// Default token mints the bot monitors (curated, verified)
// Thresholds tuned for active trading on the realistic tick data layer.
export const DEFAULT_CONFIG: BotConfig = {
  running: false,
  capital: 1000,
  maxPositions: 6,
  tradeSizePct: 12,
  compoundInterest: true,
  buyThreshold: 0.7, // buy when price is 0.7% below SMA (oversold)
  sellThreshold: 1.0, // sell when 1% above entry (take profit)
  stopLossPct: 2.5, // cut loss at -2.5%
  arbMinProfitBps: 20, // execute arb when cycle yields > 0.2%
  slippageBps: 50,
  scanIntervalMs: 4000,
  tokens: [],
}

// Socket event names shared between engine and client
export const EVENTS = {
  // Client -> Server
  GET_STATE: "get-state",
  UPDATE_CONFIG: "update-config",
  START: "start",
  STOP: "stop",
  SUBSCRIBE: "subscribe",
  // Server -> Client
  STATE_SNAPSHOT: "state-snapshot",
  STATS: "stats",
  PRICE_TICK: "price-tick",
  TRADE: "trade",
  POSITION_OPENED: "position-opened",
  POSITION_CLOSED: "position-closed",
  ARBITRAGE_FOUND: "arbitrage-found",
  EQUITY_POINT: "equity-point",
  LOG: "log",
  CONNECTED: "connected",
} as const
