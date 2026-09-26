'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Pause,
  Percent,
  Play,
  Ship,
  Square,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { fmtEth, fmtPct } from '@/lib/format'
import type { useSeabot } from '@/hooks/use-seabot'

interface SeabotHeaderProps {
  seabot: ReturnType<typeof useSeabot>
}

/**
 * Header for the SeaBot tab.
 * - CYAN "SEABOT · FLOOR ENGINE" badge (NFT buy-low/sell-high, mock floors).
 * - Start/Stop button inside the header (no wallet/socket dependency).
 * - Equity + total P&L + win rate (ETH-denominated).
 */
export function SeabotHeader({ seabot }: SeabotHeaderProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)

  const stats = seabot.stats
  const equity = stats?.equityEth ?? seabot.config.capitalEth
  const totalPnl = stats?.realizedPnlEth ?? 0
  const winRate = stats?.winRate ?? 0
  const pnlPositive = totalPnl >= 0
  const running = seabot.enabled

  const handleStart = () => {
    setConfirmedThisSession(true)
    seabot.start()
  }

  return (
    <header className="sticky top-0 z-40 border-b border-cyan-500/20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30">
            <Ship className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              SeaBot
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              NFT buy-low / sell-high &middot; mock floor engine &middot; fictional ETH
            </p>
          </div>
        </div>

        {/* Right: stats + badge + start/stop */}
        <div className="flex items-center gap-3 md:gap-4">
          {/* Big numbers (hidden on mobile) */}
          <div className="hidden items-end gap-4 sm:flex">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Equity
              </div>
              <motion.div
                key={equity.toFixed(4)}
                initial={{ opacity: 0.6, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="text-base font-semibold tabular-nums"
              >
                {fmtEth(equity)}
              </motion.div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Realized P&amp;L
              </div>
              <motion.div
                key={totalPnl.toFixed(4)}
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
                {fmtEth(totalPnl)}
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

          {/* CYAN badge */}
          <Badge
            variant="outline"
            className={
              running
                ? 'gap-1 border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
                : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }
          >
            <Ship
              className={`size-3 ${running ? 'animate-pulse text-cyan-400' : ''}`}
            />
            SEABOT · FLOOR ENGINE
          </Badge>

          {/* Start / Stop — always enabled */}
          {running ? (
            <Button
              size="sm"
              onClick={() => seabot.stop()}
              className="gap-1.5 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="sm"
              onClick={handleStart}
              className="gap-1.5 bg-cyan-600 text-white hover:bg-cyan-500"
            >
              <Play className="size-3.5" /> Start
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  className="gap-1.5 bg-cyan-600 text-white hover:bg-cyan-500"
                >
                  <Play className="size-3.5" /> Start
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <Ship className="size-5 text-cyan-400" />
                    Start the SeaBot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot runs fully in your browser with a deterministic
                    floor-price engine (no API key required). It buys cheap NFTs
                    and sells at take-profit / stop-loss / trailing-stop levels.
                    Capital is fictional ({fmtEth(seabot.config.capitalEth)}) —
                    no real funds are at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="gap-1.5 bg-cyan-600 text-white hover:bg-cyan-500"
                  >
                    <Play className="size-4" /> Start SeaBot
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {!running && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
              <Zap className="size-3 text-cyan-400" />
              Ready — no wallet needed.
            </span>
          )}
          {running && (
            <span className="hidden items-center gap-1 text-[11px] text-cyan-300 lg:flex">
              <Pause className="size-3" /> Click Stop to pause.
            </span>
          )}
        </div>
      </div>
    </header>
  )
}