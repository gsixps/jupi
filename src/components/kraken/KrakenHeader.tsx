'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Anchor,
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
import type { useKrakenBot } from '@/hooks/use-kraken'
import { KRAKEN_PRODUCTS } from '@/lib/kraken'

interface KrakenHeaderProps {
  kraken: ReturnType<typeof useKrakenBot>
}

/**
 * Header for the Kraken tab.
 * - TEAL "KRAKEN · TRIANGLE ARB" badge over the full Kraken product shelf.
 * - Start/Stop button inside the header (client-side, no wallet needed).
 * - Equity + total P&L + win rate (USD-denominated).
 */
export function KrakenHeader({ kraken }: KrakenHeaderProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)

  const stats = kraken.stats
  const equity = stats?.equityUsd ?? kraken.config.capitalUsd
  const totalPnl = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const pnlPositive = totalPnl >= 0
  const running = kraken.enabled
  const live = kraken.dataSource === 'live'

  const handleStart = () => {
    setConfirmedThisSession(true)
    kraken.start()
  }

  return (
    <header className="sticky top-0 z-40 border-b border-teal-500/20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-teal-500/15 text-teal-400 ring-1 ring-teal-500/30">
            <Anchor className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              Kraken
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Triangle arbitrage &middot; live api.kraken.com &middot; all products
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

          {/* TEAL badge */}
          <Badge
            variant="outline"
            className={
              running
                ? 'gap-1 border-teal-500/40 bg-teal-500/15 text-teal-300'
                : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }
          >
            <Anchor
              className={`size-3 ${running ? 'animate-pulse text-teal-400' : ''}`}
            />
            KRAKEN · TRIANGLE ARB
          </Badge>

          {/* Start / Stop — always enabled */}
          {running ? (
            <Button
              size="sm"
              onClick={() => kraken.stop()}
              className="gap-1.5 bg-teal-600 text-white hover:bg-teal-500"
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="sm"
              onClick={handleStart}
              className="gap-1.5 bg-teal-600 text-white hover:bg-teal-500"
            >
              <Play className="size-3.5" /> Start
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  className="gap-1.5 bg-teal-600 text-white hover:bg-teal-500"
                >
                  <Play className="size-3.5" /> Start
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <Anchor className="size-5 text-teal-400" />
                    Start the Kraken arb bot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot reads live prices from the Kraken public API
                    (api.kraken.com/0/public/Ticker) across {KRAKEN_PRODUCTS.pairs}{' '}
                    pairs — {KRAKEN_PRODUCTS.routes} triangle routes covering
                    crypto majors, stables, tokenized gold, cross pairs, EUR
                    pairs and fiat crosses — and executes buy-cheap /
                    sell-expensive arbitrage. If the API is unreachable it falls
                    back to a deterministic demo engine. Capital is fictional (
                    {fmtUsd(kraken.config.capitalUsd)}) — no real funds are at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="gap-1.5 bg-teal-600 text-white hover:bg-teal-500"
                  >
                    <Play className="size-4" /> Start Kraken Bot
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {!running && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
              <Zap className="size-3 text-teal-400" />
              Ready — no wallet needed.
            </span>
          )}
          {running && (
            <span className="hidden items-center gap-1 text-[11px] text-teal-300 lg:flex">
              <Pause className="size-3" /> Click Stop to pause.
            </span>
          )}
          <span
            className={`hidden items-center gap-1 text-[10px] xl:flex ${
              live ? 'text-emerald-400' : 'text-amber-400'
            }`}
            title={live ? 'Live api.kraken.com data' : 'Deterministic demo data'}
          >
            <Wifi className="size-3" />
            {live ? 'live API' : 'demo'}
          </span>
        </div>
      </div>
    </header>
  )
}