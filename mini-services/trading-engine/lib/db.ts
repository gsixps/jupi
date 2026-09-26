// Prisma client singleton + helper queries for the trading engine
import { PrismaClient } from "@prisma/client"
import "dotenv"

export const db = new PrismaClient({ log: ["warn", "error"] })

import { DEFAULT_CONFIG, type BotConfig, type Trade, type EquityPoint, type PriceTick, type Position } from "./types"
import { fetchTokenList, USDC_MINT } from "./tokens"

/**
 * Read BotConfig row id="default" from DB. If missing, insert a default row
 * with tokens = the mints of the curated token list (resolved via fetchTokenList,
 * excluding USDC itself). Returns the config as a BotConfig type.
 */
export async function loadConfig(): Promise<BotConfig> {
  let row = await db.botConfig.findUnique({ where: { id: "default" } })
  if (!row) {
    // Resolve a curated token list (USDC excluded from `tokens` array since it's the quote)
    const tokens = await fetchTokenList()
    const tokenMints = tokens
      .filter((t) => t.mint !== USDC_MINT)
      .map((t) => t.mint)

    row = await db.botConfig.create({
      data: {
        id: "default",
        running: DEFAULT_CONFIG.running,
        capital: DEFAULT_CONFIG.capital,
        maxPositions: DEFAULT_CONFIG.maxPositions,
        tradeSizePct: DEFAULT_CONFIG.tradeSizePct,
        buyThreshold: DEFAULT_CONFIG.buyThreshold,
        sellThreshold: DEFAULT_CONFIG.sellThreshold,
        stopLossPct: DEFAULT_CONFIG.stopLossPct,
        arbMinProfitBps: DEFAULT_CONFIG.arbMinProfitBps,
        slippageBps: DEFAULT_CONFIG.slippageBps,
        scanIntervalMs: DEFAULT_CONFIG.scanIntervalMs,
        tokens: JSON.stringify(tokenMints),
      },
    })
  }

  return rowToConfig(row)
}

/** Upsert the BotConfig row from the BotConfig type. */
export async function saveConfig(cfg: BotConfig): Promise<void> {
  await db.botConfig.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      running: cfg.running,
      capital: cfg.capital,
      maxPositions: cfg.maxPositions,
      tradeSizePct: cfg.tradeSizePct,
      buyThreshold: cfg.buyThreshold,
      sellThreshold: cfg.sellThreshold,
      stopLossPct: cfg.stopLossPct,
      arbMinProfitBps: cfg.arbMinProfitBps,
      slippageBps: cfg.slippageBps,
      scanIntervalMs: cfg.scanIntervalMs,
      tokens: JSON.stringify(cfg.tokens ?? []),
    },
    update: {
      running: cfg.running,
      capital: cfg.capital,
      maxPositions: cfg.maxPositions,
      tradeSizePct: cfg.tradeSizePct,
      buyThreshold: cfg.buyThreshold,
      sellThreshold: cfg.sellThreshold,
      stopLossPct: cfg.stopLossPct,
      arbMinProfitBps: cfg.arbMinProfitBps,
      slippageBps: cfg.slippageBps,
      scanIntervalMs: cfg.scanIntervalMs,
      tokens: JSON.stringify(cfg.tokens ?? []),
    },
  })
}

/** Insert a Trade into the DB. Maps the Trade type -> Trade model. JSON-stringifies route and cycle. */
export async function insertTrade(t: Trade): Promise<void> {
  await db.trade.create({
    data: {
      id: t.id,
      strategy: t.strategy,
      side: t.side,
      inputMint: t.inputMint,
      outputMint: t.outputMint,
      inputSymbol: t.inputSymbol,
      outputSymbol: t.outputSymbol,
      inputAmount: t.inputAmount,
      outputAmount: t.outputAmount,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice ?? null,
      pnl: t.pnl,
      pnlPct: t.pnlPct,
      win: t.win,
      route: JSON.stringify(t.route ?? []),
      cycle: t.cycle ? JSON.stringify(t.cycle) : null,
      reason: t.reason ?? "",
      openedAt: new Date(t.openedAt),
      closedAt: t.closedAt ? new Date(t.closedAt) : null,
    },
  })
}

/**
 * Insert an EquityPoint, then prune to keep the last 500 (delete older).
 */
export async function insertEquityPoint(e: EquityPoint): Promise<void> {
  await db.equityPoint.create({
    data: {
      equity: e.equity,
      balance: e.balance,
      openPnl: e.openPnl,
      timestamp: new Date(e.timestamp),
    },
  })
  // Prune: keep last 500 by timestamp desc
  const keep = await db.equityPoint.findMany({
    orderBy: { timestamp: "desc" },
    take: 500,
    select: { id: true },
  })
  const keepIds = keep.map((r) => r.id)
  if (keepIds.length > 0) {
    await db.equityPoint.deleteMany({ where: { id: { notIn: keepIds } } })
  }
}

/**
 * Insert a PriceTick, then prune to keep the last 100 per mint.
 */
export async function insertPriceTick(t: PriceTick): Promise<void> {
  await db.priceTick.create({
    data: {
      mint: t.mint,
      symbol: t.symbol,
      price: t.price,
      source: "jupiter",
      timestamp: new Date(t.timestamp),
    },
  })
  // Prune: keep last 100 per mint
  const keep = await db.priceTick.findMany({
    where: { mint: t.mint },
    orderBy: { timestamp: "desc" },
    take: 100,
    select: { id: true },
  })
  const keepIds = keep.map((r) => r.id)
  if (keepIds.length > 0) {
    await db.priceTick.deleteMany({
      where: { mint: t.mint, id: { notIn: keepIds } },
    })
  }
}

/** Read recent closed trades ordered by closedAt desc, mapped to the Trade type. */
export async function loadRecentTrades(limit = 100): Promise<Trade[]> {
  const rows = await db.trade.findMany({
    orderBy: { closedAt: "desc" },
    take: limit,
  })
  return rows.map(rowToTrade)
}

/** Read equity points ordered by time desc limit, mapped to EquityPoint (asc order returned). */
export async function loadEquityHistory(limit = 200): Promise<EquityPoint[]> {
  const rows = await db.equityPoint.findMany({
    orderBy: { timestamp: "desc" },
    take: limit,
  })
  // reverse to ascending for charting
  const list = rows.map((r) => ({
    timestamp: r.timestamp.getTime(),
    equity: r.equity,
    balance: r.balance,
    openPnl: r.openPnl,
  }))
  list.reverse()
  return list
}

/** Upsert an open Position into the DB (used when a position opens). */
export async function upsertPosition(p: Position): Promise<void> {
  await db.position.upsert({
    where: { id: p.id },
    create: {
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      entryPrice: p.entryPrice,
      amount: p.amount,
      costUsd: p.costUsd,
      smaAtEntry: p.smaAtEntry,
      openedAt: new Date(p.openedAt),
    },
    update: {
      mint: p.mint,
      symbol: p.symbol,
      entryPrice: p.entryPrice,
      amount: p.amount,
      costUsd: p.costUsd,
      smaAtEntry: p.smaAtEntry,
      openedAt: new Date(p.openedAt),
    },
  })
}

/** Delete a Position by id (when closed). */
export async function deletePosition(id: string): Promise<void> {
  await db.position.deleteMany({ where: { id } })
}

/** Clear all open positions from DB (used on init reset if needed). */
export async function clearPositions(): Promise<void> {
  await db.position.deleteMany({})
}

/** Load all open positions from DB (for restart state recovery). */
export async function loadOpenPositions(): Promise<Position[]> {
  const rows = await db.position.findMany({})
  return rows.map((r) => ({
    id: r.id,
    mint: r.mint,
    symbol: r.symbol,
    entryPrice: r.entryPrice,
    amount: r.amount,
    costUsd: r.costUsd,
    smaAtEntry: r.smaAtEntry,
    openedAt: r.openedAt.getTime(),
  }))
}

// ---- internal mappers ----

function rowToConfig(row: {
  running: boolean
  capital: number
  maxPositions: number
  tradeSizePct: number
  buyThreshold: number
  sellThreshold: number
  stopLossPct: number
  arbMinProfitBps: number
  slippageBps: number
  scanIntervalMs: number
  tokens: string
}): BotConfig {
  let tokens: string[] = []
  try {
    const parsed = JSON.parse(row.tokens ?? "[]")
    if (Array.isArray(parsed)) tokens = parsed.filter((x) => typeof x === "string")
  } catch {
    tokens = []
  }
  return {
    running: row.running,
    capital: row.capital,
    maxPositions: row.maxPositions,
    tradeSizePct: row.tradeSizePct,
    buyThreshold: row.buyThreshold,
    sellThreshold: row.sellThreshold,
    stopLossPct: row.stopLossPct,
    arbMinProfitBps: row.arbMinProfitBps,
    slippageBps: row.slippageBps,
    scanIntervalMs: row.scanIntervalMs,
    tokens,
  }
}

function rowToTrade(r: {
  id: string
  strategy: string
  side: string
  inputMint: string
  outputMint: string
  inputSymbol: string
  outputSymbol: string
  inputAmount: number
  outputAmount: number
  entryPrice: number
  exitPrice: number | null
  pnl: number
  pnlPct: number
  win: boolean
  route: string
  cycle: string | null
  reason: string
  openedAt: Date
  closedAt: Date | null
}): Trade {
  let route: string[] = []
  try {
    const parsed = JSON.parse(r.route ?? "[]")
    if (Array.isArray(parsed)) route = parsed.filter((x) => typeof x === "string")
  } catch {
    route = []
  }
  let cycle: string[] | undefined
  if (r.cycle) {
    try {
      const parsed = JSON.parse(r.cycle)
      if (Array.isArray(parsed)) cycle = parsed.filter((x) => typeof x === "string")
    } catch {
      cycle = undefined
    }
  }
  return {
    id: r.id,
    strategy: r.strategy as Trade["strategy"],
    side: r.side as Trade["side"],
    inputMint: r.inputMint,
    outputMint: r.outputMint,
    inputSymbol: r.inputSymbol,
    outputSymbol: r.outputSymbol,
    inputAmount: r.inputAmount,
    outputAmount: r.outputAmount,
    entryPrice: r.entryPrice,
    exitPrice: r.exitPrice ?? undefined,
    pnl: r.pnl,
    pnlPct: r.pnlPct,
    win: r.win,
    route,
    cycle,
    reason: r.reason ?? "",
    openedAt: r.openedAt.getTime(),
    closedAt: r.closedAt ? r.closedAt.getTime() : undefined,
  }
}
