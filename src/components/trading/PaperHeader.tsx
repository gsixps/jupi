'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Bot,
  FlaskConical,
  Pause,
  Percent,
  Play,
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
import { fmtUsd, fmtPct } from '@/lib/format'
import type { usePaperTrading } from '@/hooks/use-paper-trading'

interface PaperHeaderProps {
  paper: ReturnType<typeof usePaperTrading>
}

/**
 * Header for Paper Trading mode.
 * - GREEN "PAPER · REAL DATA" badge (instead of Live's red LIVE).
 * - Start/Stop button INSIDE the header (always enabled — no socket/wallet dep).
 * - Big equity + total P&L numbers.
 *
 * The Start button is ALWAYS enabled — this is the fix the user asked for
 * (the old Paper mode gated it behind a socket.io `connected` check).
 */
export function PaperHeader({ paper }: PaperHeaderProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)

  const stats = paper.stats
  const equity = stats?.equity ?? paper.config.capital
  const totalPnl = stats?.totalPnl ?? 0
  const totalPnlPct = stats?.totalPnlPct ?? 0
  const winRate = stats?.winRate ?? 0
  const pnlPositive = totalPnl >= 0
  const running = paper.enabled

  const handleStart = () => {
    setConfirmedThisSession(true)
    paper.start()
  }

  return (
    <header className="sticky top-0 z-40 border-b border-emerald-500/20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            <Bot className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              Jupiter Bot
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Demo mode &middot; real Jupiter market data &middot; fictional
              capital
            </p>
          </div>
        </div>

        {/* Right: stats + badge + start/stop */}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 md:gap-4">
          {/* Big numbers (hidden on mobile) */}
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

          {/* GREEN badge — PAPER · REAL DATA */}
          <Badge
            variant="outline"
            className={
              running
                ? 'hidden gap-1 sm:inline-flex border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                : 'hidden gap-1 sm:inline-flex border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }
          >
            <FlaskConical
              className={`size-3 ${running ? 'animate-pulse text-emerald-400' : ''}`}
            />
            DEMO · REAL DATA
          </Badge>

          {/* Start / Stop button — ALWAYS enabled (no socket/wallet gate) */}
          {running ? (
            <Button
              size="sm"
              onClick={() => paper.stop()}
              className="gap-1.5 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="sm"
              onClick={handleStart}
              className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
            >
              <Play className="size-3.5" /> Start
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
                >
                  <Play className="size-3.5" /> Start
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <FlaskConical className="size-5 text-emerald-400" />
                    Start paper trading?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot will run entirely in your browser, fetching REAL
                    prices and REAL swap quotes from Jupiter. Capital is
                    fictional (${paper.config.capital.toFixed(2)}) so no real
                    funds are at risk. Every P&amp;L figure reflects what would
                    have happened at the real market rate.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
                  >
                    <Play className="size-4" /> Start paper bot
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {/* tiny idle indicator when stopped (mobile-friendly) */}
          {!running && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
              <Zap className="size-3 text-emerald-400" />
              Ready — no wallet needed.
            </span>
          )}
          {running && (
            <span className="hidden items-center gap-1 text-[11px] text-emerald-300 lg:flex">
              <Pause className="size-3" /> Click Stop to pause.
            </span>
          )}
        </div>
      </div>
    </header>
  )
}
