'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  ChartNoAxesCombined,
  Pause,
  Percent,
  Play,
  Square,
  TrendingDown,
  TrendingUp,
  Wifi,
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
import type { useCurveBot } from '@/hooks/use-curve'

interface CurveHeaderProps {
  curve: ReturnType<typeof useCurveBot>
}

/**
 * Header for the Curve Finance tab.
 * - BLUE "CURVE FINANCE · STABLECOIN ARB" badge (buy cheap / sell expensive).
 * - Start/Stop button inside the header (client-side, no wallet needed).
 * - Equity + total P&L + win rate (USD-denominated).
 */
export function CurveHeader({ curve }: CurveHeaderProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)

  const stats = curve.stats
  const equity = stats?.equityUsd ?? curve.config.capitalUsd
  const totalPnl = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const pnlPositive = totalPnl >= 0
  const running = curve.enabled
  const live = curve.dataSource === 'live'

  const handleStart = () => {
    setConfirmedThisSession(true)
    curve.start()
  }

  return (
    <header className="sticky top-0 z-40 border-b border-blue-500/20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/30">
            <ChartNoAxesCombined className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              Curve Finance
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Stablecoin arbitrage &middot; live curve.finance API &middot; fictional USD
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
                Realized P&amp;L
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
                {fmtUsd(totalPnl)}
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

          {/* BLUE badge */}
          <Badge
            variant="outline"
            className={
              running
                ? 'gap-1 border-blue-500/40 bg-blue-500/15 text-blue-300'
                : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }
          >
            <ChartNoAxesCombined
              className={`size-3 ${running ? 'animate-pulse text-blue-400' : ''}`}
            />
            CURVE · STABLECOIN ARB
          </Badge>

          {/* Start / Stop — always enabled */}
          {running ? (
            <Button
              size="sm"
              onClick={() => curve.stop()}
              className="gap-1.5 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="sm"
              onClick={handleStart}
              className="gap-1.5 bg-blue-600 text-white hover:bg-blue-500"
            >
              <Play className="size-3.5" /> Start
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  className="gap-1.5 bg-blue-600 text-white hover:bg-blue-500"
                >
                  <Play className="size-3.5" /> Start
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <ChartNoAxesCombined className="size-5 text-blue-400" />
                    Start the Curve arb bot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot reads live implied USD prices from the Curve Finance
                    API and executes buy-cheap / sell-expensive stablecoin
                    arbitrage across pools. If the API is unreachable it falls
                    back to a deterministic demo engine. Capital is fictional (
                    {fmtUsd(curve.config.capitalUsd)}) — no real funds are at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="gap-1.5 bg-blue-600 text-white hover:bg-blue-500"
                  >
                    <Play className="size-4" /> Start Curve Bot
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {!running && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
              <Zap className="size-3 text-blue-400" />
              Ready — no wallet needed.
            </span>
          )}
          {running && (
            <span className="hidden items-center gap-1 text-[11px] text-blue-300 lg:flex">
              <Pause className="size-3" /> Click Stop to pause.
            </span>
          )}
          <span
            className={`hidden items-center gap-1 text-[10px] xl:flex ${
              live ? 'text-emerald-400' : 'text-amber-400'
            }`}
            title={live ? 'Live curve.finance data' : 'Deterministic demo data'}
          >
            <Wifi className="size-3" />
            {live ? 'live API' : 'demo'}
          </span>
        </div>
      </div>
    </header>
  )
}