'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Building2,
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
import { fmtUsd } from '@/lib/format'
import type { useBybitBot } from '@/hooks/use-bybit'
import { BYBIT_RWA_PAIRS } from '@/lib/bybit'

interface BybitHeaderProps {
  bybit: ReturnType<typeof useBybitBot>
}

/**
 * Header for the Bybit RWA tab.
 * - ORANGE "BYBIT · RWA BASIS ARB" badge over the xStocks shelf.
 * - Start/Stop inside the header.
 * - Equity + realized P&L + win rate (USD-denominated).
 */
export function BybitHeader({ bybit }: BybitHeaderProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)

  const stats = bybit.stats
  const equity = stats?.equityUsd ?? bybit.config.capitalUsd
  const totalPnl = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const pnlPositive = totalPnl >= 0
  const running = bybit.enabled
  const live = bybit.dataSource === 'live'
  const realMode = bybit.config.liveTrading

  const handleStart = () => {
    setConfirmedThisSession(true)
    bybit.start()
  }

  return (
    <header className="sticky top-0 z-40 border-b border-orange-500/20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/30">
            <Building2 className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              Bybit RWA
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Basis arbitrage &middot; xStocks vs TradFi perps &middot; live Bybit API
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

          {/* ORANGE badge */}
          <Badge
            variant="outline"
            className={
              running
                ? 'gap-1 border-orange-500/40 bg-orange-500/15 text-orange-300'
                : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }
          >
            <Building2
              className={`size-3 ${running ? 'animate-pulse text-orange-400' : ''}`}
            />
            {realMode ? 'BYBIT · RWA · REAL' : 'BYBIT · RWA BASIS ARB'}
          </Badge>

          {/* Start / Stop */}
          {running ? (
            <Button
              size="sm"
              onClick={() => bybit.stop()}
              className="gap-1.5 bg-orange-600 text-white hover:bg-orange-500"
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="sm"
              onClick={handleStart}
              className="gap-1.5 bg-orange-600 text-white hover:bg-orange-500"
            >
              <Play className="size-3.5" /> Start
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  className="gap-1.5 bg-orange-600 text-white hover:bg-orange-500"
                >
                  <Play className="size-3.5" /> Start
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <Building2 className="size-5 text-orange-400" />
                    Start the Bybit RWA basis bot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot reads live prices from the Bybit public V5 API across{' '}
                    {BYBIT_RWA_PAIRS.length} tokenized RWA pairs (xStocks spot vs the
                    TradFi perp on the same underlying) and opens market-neutral basis
                    trades: buy the spot xStock and short the perp when the perp is rich,
                    and the reverse when it is cheap. If the API is unreachable it falls
                    back to a deterministic demo engine. Capital is fictional (
                    {fmtUsd(bybit.config.capitalUsd)}) — no real funds are at risk.
                    {realMode &&
                      ' WARNING: real mode is ON, so real orders with real capital will be sent.'}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="gap-1.5 bg-orange-600 text-white hover:bg-orange-500"
                  >
                    <Play className="size-4" /> Start Bybit Bot
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {!running && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
              <Zap className="size-3 text-orange-400" />
              Ready — no wallet needed.
            </span>
          )}
          {running && (
            <span className="hidden items-center gap-1 text-[11px] text-orange-300 lg:flex">
              <Pause className="size-3" /> Click Stop to pause.
            </span>
          )}
          <span
            className={`hidden items-center gap-1 text-[10px] xl:flex ${
              live ? 'text-emerald-400' : 'text-amber-400'
            }`}
            title={live ? 'Live api.bybit.com data' : 'Deterministic demo data'}
          >
            <Wifi className="size-3" />
            {live ? 'live API' : 'demo'}
          </span>
        </div>
      </div>

      {bybit.haltedReason && (
        <div className="border-t border-rose-500/30 bg-rose-500/10 px-4 py-2 text-center text-[11px] text-rose-300 md:px-6">
          Bot detenido por el modo real: {bybit.haltedReason}
        </div>
      )}
    </header>
  )
}
