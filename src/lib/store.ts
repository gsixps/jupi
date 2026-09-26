'use client'

import { create } from 'zustand'
import { io, type Socket } from 'socket.io-client'
import {
  EVENTS,
  DEFAULT_CONFIG,
  type BotStats,
  type Position,
  type Trade,
  type EquityPoint,
  type ArbitrageOpportunity,
  type BotConfig,
  type TokenInfo,
  type PriceTick,
} from '@/lib/trading-types'

export interface LogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
}

export interface StateSnapshot {
  stats?: BotStats
  positions?: Position[]
  trades?: Trade[]
  equityCurve?: EquityPoint[]
  arbitrageOpportunities?: ArbitrageOpportunity[]
  lastPrices?: Record<string, number>
  change24h?: Record<string, number>
  priceHistory?: Record<string, number[]>
  config?: BotConfig
  tokens?: TokenInfo[]
}

interface TradingState {
  // connection
  connected: boolean
  socket: Socket | null
  initialized: boolean

  // market + bot state
  stats: BotStats | null
  positions: Position[]
  trades: Trade[]
  equity: EquityPoint[]
  arbitrage: ArbitrageOpportunity[]
  prices: Record<string, number>
  priceHistory: Record<string, number[]>
  change24h: Record<string, number>
  config: BotConfig
  tokens: TokenInfo[]
  logs: LogEntry[]

  // actions
  init: () => void
  startBot: () => void
  stopBot: () => void
  updateConfig: (cfg: Partial<BotConfig>) => void
  getInitialState: () => void
}

const PRICE_HISTORY_CAP = 60
const TRADES_CAP = 200
const ARB_CAP = 50
const EQUITY_CAP = 200
const LOGS_CAP = 100

function makeLog(raw: unknown): LogEntry | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    return { timestamp: Date.now(), level: 'info', message: raw }
  }
  if (typeof raw === 'object') {
    const e = raw as Partial<LogEntry> & { message?: string; msg?: string }
    const message = e.message ?? e.msg ?? ''
    if (!message) return null
    return {
      timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
      level: (e.level as LogEntry['level']) ?? 'info',
      message,
    }
  }
  return null
}

let socketRef: Socket | null = null

export const useTradingStore = create<TradingState>((set, get) => ({
  connected: false,
  socket: null,
  initialized: false,

  stats: null,
  positions: [],
  trades: [],
  equity: [],
  arbitrage: [],
  prices: {},
  priceHistory: {},
  change24h: {},
  config: { ...DEFAULT_CONFIG },
  tokens: [],
  logs: [],

  init: () => {
    if (get().initialized) return
    if (typeof window === 'undefined') return
    set({ initialized: true })

    // Connect to engine on port 3003 via Caddy gateway
    // Path MUST be "/" and port goes in XTransformPort query param
    const socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 10000,
      timeout: 15000,
    })
    socketRef = socket
    set({ socket })

    // ---- Connection lifecycle ----
    socket.on('connect', () => {
      set({ connected: true })
      // Ask the engine for a full snapshot on (re)connect
      socket.emit(EVENTS.GET_STATE)
      // Also subscribe to live streams (engine may or may not require this)
      socket.emit(EVENTS.SUBSCRIBE)
    })

    socket.on(EVENTS.CONNECTED, () => {
      set({ connected: true })
      socket.emit(EVENTS.GET_STATE)
    })

    socket.on('disconnect', () => {
      set({ connected: false })
    })

    socket.on('connect_error', () => {
      set({ connected: false })
    })

    // ---- Full state snapshot ----
    socket.on(EVENTS.STATE_SNAPSHOT, (snap: StateSnapshot) => {
      if (!snap) return
      set({
        stats: snap.stats ?? get().stats,
        positions: snap.positions ?? [],
        trades: (snap.trades ?? []).slice(0, TRADES_CAP),
        equity: (snap.equityCurve ?? []).slice(-EQUITY_CAP),
        arbitrage: (snap.arbitrageOpportunities ?? []).slice(0, ARB_CAP),
        prices: snap.lastPrices ?? {},
        priceHistory: snap.priceHistory ?? {},
        change24h: snap.change24h ?? {},
        config: { ...DEFAULT_CONFIG, ...(snap.config ?? {}) },
        tokens: snap.tokens ?? [],
      })
    })

    // ---- Stats update ----
    socket.on(EVENTS.STATS, (s: BotStats) => {
      if (!s) return
      set({ stats: s })
    })

    // ---- Price tick ----
    socket.on(EVENTS.PRICE_TICK, (tick: PriceTick) => {
      if (!tick || !tick.mint) return
      const price = typeof tick.price === 'number' ? tick.price : 0
      set((state) => {
        const prices = { ...state.prices, [tick.mint]: price }
        const change24h = { ...state.change24h }
        if (typeof tick.changePct24h === 'number') {
          change24h[tick.mint] = tick.changePct24h
        }
        const prevHist = state.priceHistory[tick.mint] ?? []
        const nextHist = [...prevHist, price].slice(-PRICE_HISTORY_CAP)
        return {
          prices,
          change24h,
          priceHistory: { ...state.priceHistory, [tick.mint]: nextHist },
        }
      })
    })

    // ---- Trade (closed) ----
    socket.on(EVENTS.TRADE, (t: Trade) => {
      if (!t) return
      set((state) => ({
        trades: [t, ...state.trades].slice(0, TRADES_CAP),
      }))
    })

    // ---- Position lifecycle ----
    socket.on(EVENTS.POSITION_OPENED, (p: Position) => {
      if (!p) return
      set((state) => {
        if (state.positions.find((x) => x.id === p.id)) return state
        return { positions: [p, ...state.positions] }
      })
    })

    socket.on(EVENTS.POSITION_CLOSED, (payload: { id: string } | Position) => {
      const id = payload && typeof payload === 'object' ? payload.id : undefined
      if (!id) return
      set((state) => ({
        positions: state.positions.filter((x) => x.id !== id),
      }))
    })

    // ---- Arbitrage opportunity detected ----
    socket.on(EVENTS.ARBITRAGE_FOUND, (a: ArbitrageOpportunity) => {
      if (!a) return
      set((state) => ({
        arbitrage: [a, ...state.arbitrage].slice(0, ARB_CAP),
      }))
    })

    // ---- Equity point ----
    socket.on(EVENTS.EQUITY_POINT, (e: EquityPoint) => {
      if (!e) return
      set((state) => ({
        equity: [...state.equity, e].slice(-EQUITY_CAP),
      }))
    })

    // ---- Log line ----
    socket.on(EVENTS.LOG, (raw: unknown) => {
      const entry = makeLog(raw)
      if (!entry) return
      set((state) => ({
        logs: [entry, ...state.logs].slice(0, LOGS_CAP),
      }))
    })
  },

  startBot: () => {
    const s = get().socket ?? socketRef
    s?.emit(EVENTS.START)
  },

  stopBot: () => {
    const s = get().socket ?? socketRef
    s?.emit(EVENTS.STOP)
  },

  updateConfig: (cfg: Partial<BotConfig>) => {
    const s = get().socket ?? socketRef
    if (!s) return
    // Optimistically update local config so the UI feels instant
    set((state) => ({ config: { ...state.config, ...cfg } }))
    s.emit(EVENTS.UPDATE_CONFIG, cfg)
  },

  getInitialState: () => {
    const s = get().socket ?? socketRef
    s?.emit(EVENTS.GET_STATE)
  },
}))

// Convenience hook that returns the whole state + actions (for small dashboards)
export function useTrading() {
  return useTradingStore()
}
