'use client'

import { motion } from 'framer-motion'
import { Bot, Percent, TrendingDown, TrendingUp, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { fmtUsd, fmtPct } from '@/lib/format'
import type { useLiveTrading } from '@/hooks/use-live-trading'
import type { UseWallet } from '@/hooks/use-wallet'

interface LiveHeaderProps {
  live: ReturnType<typeof useLiveTrading>
  wallet: UseWallet
}

/**
 * Header for Live Trading mode.
 * Shows the LIVE TRADING red badge + live stats (equity, P&L, win rate).
 * No Start/Stop buttons here — those live in the LiveTradingPanel.
 */
export function LiveHeader({ live, wallet }: LiveHeaderProps) {
  const stats = live.stats
  const equity = stats?.equity ?? live.config.capital
  const totalPnl = stats?.totalPnl ?? 0
  const totalPnlPct = stats?.totalPnlPct ?? 0
  const winRate = stats?.winRate ?? 0
  const pnlPositive = totalPnl >= 0
  const running = live.enabled

  return (
    <header className="sticky top-0 z-40 border-b border-rose-500/20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/30">
            <Bot className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              Jupiter Bot
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Real on-chain trading via Phantom &amp; Jupiter Swap API
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 md:gap-4">
          {/* Live stats */}
          <div className="hidden items-end gap-4 sm:flex">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Equity
              </div>
              <motion.div
                key={equity.toFixed(2)}
                initial={{ opacity: 0.6, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="text-base font-semibold tabular-nums"
              >
                {fmtUsd(equity)}
              </motion.div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total P&amp;L
              </div>
              <motion.div
                key={totalPnl.toFixed(2)}
                initial={{ opacity: 0.6, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`flex items-center gap-1 text-base font-semibold tabular-nums ${
                  pnlPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {pnlPositive ? (
                  <TrendingUp className="size-4" />
                ) : (
                  <TrendingDown className="size-4" />
                )}
                {fmtUsd(totalPnl)}{' '}
                <span className="text-xs">({fmtPct(totalPnlPct)})</span>
              </motion.div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Win Rate
              </div>
              <div className="flex items-center gap-1 text-base font-semibold tabular-nums">
                <Percent className="size-3.5 text-muted-foreground" />
                {winRate.toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Live mode badge */}
          <Badge
            variant="outline"
            className={
              running
                ? 'gap-1 border-rose-500/40 bg-rose-500/15 text-rose-300'
                : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }
          >
            <Zap
              className={`size-3 ${running ? 'animate-pulse text-rose-400' : ''}`}
            />
            {running ? 'LIVE' : 'LIVE IDLE'}
          </Badge>

          {/* Wallet status pill (compact) */}
          {wallet.connected ? (
            <Badge
              variant="outline"
              className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            >
              {wallet.shortAddress}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-amber-300"
            >
              No wallet
            </Badge>
          )}
        </div>
      </div>
    </header>
  )
}
