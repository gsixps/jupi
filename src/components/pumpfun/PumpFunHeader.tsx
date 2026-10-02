'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Pause, Percent, Play, Rocket, Square, TrendingDown, TrendingUp, Wifi, Zap } from 'lucide-react'
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
import type { PumpFunBot } from '@/hooks/use-pumpfun'

interface PumpFunHeaderProps {
  bot: PumpFunBot
}

export function PumpFunHeader({ bot }: PumpFunHeaderProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)

  const stats = bot.stats
  const equity = stats?.equityUsd ?? bot.config.capitalUsd
  const totalPnl = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const pnlPositive = totalPnl >= 0
  const running = bot.enabled
  const live = bot.dataSource === 'live'

  const handleStart = () => {
    setConfirmedThisSession(true)
    bot.start()
  }

  return (
    <header className="sticky top-0 z-40 border-b border-fuchsia-500/20 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-fuchsia-500/15 text-fuchsia-400 ring-1 ring-fuchsia-500/30">
            <Rocket className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              PumpFun Meme Hunter
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Buy cheap &middot; sell expensive &middot; detect new opportunities &middot; pump.fun
            </p>
          </div>
        </div>

        {/* Right: stats + badge + start/stop */}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 md:gap-4">
          <div className="hidden items-end gap-4 sm:flex">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Equity</div>
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
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Realized P&L</div>
              <motion.div
                key={totalPnl.toFixed(2)}
                initial={{ opacity: 0.6, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`flex items-center gap-1 text-base font-semibold tabular-nums ${
                  pnlPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {pnlPositive ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
                {fmtUsd(totalPnl)}
              </motion.div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Meme coins</div>
              <div className="text-base font-semibold tabular-nums">{bot.coins.length}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Win Rate</div>
              <div className="flex items-center gap-1 text-base font-semibold tabular-nums">
                <Percent className="size-3.5 text-muted-foreground" />
                {winRate.toFixed(1)}%
              </div>
            </div>
          </div>

          <Badge
            variant="outline"
            className={`hidden gap-1 sm:inline-flex ${
              running
                ? 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300'
                : 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }`}
          >
            {running ? (
              <Rocket className="size-3 animate-pulse text-fuchsia-400" />
            ) : (
              <Rocket className="size-3" />
            )}
            MEME ARB · BUY CHEAP · SELL EXPENSIVE
          </Badge>

          {running ? (
            <Button
              size="sm"
              onClick={() => bot.stop()}
              className="gap-1.5 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : confirmedThisSession ? (
            <Button size="sm" onClick={handleStart} className="gap-1.5 bg-fuchsia-600 text-white hover:bg-fuchsia-500">
              <Play className="size-3.5" /> Start
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" className="gap-1.5 bg-fuchsia-600 text-white hover:bg-fuchsia-500">
                  <Play className="size-3.5" /> Start
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <Rocket className="size-5 text-fuchsia-400" />
                    Launch the PumpFun meme hunter?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot watches a universe of pump.fun memecoins, scores every
                    coin for dips, momentum and fresh listings, buys the cheap
                    ones and sells them on the pump. It reads prices from the
                    live pump.fun API (with the deterministic demo engine as
                    fallback). Capital is fictional (
                    {fmtUsd(bot.config.capitalUsd)}) — no real tokens are bought.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleStart} className="gap-1.5 bg-fuchsia-600 text-white hover:bg-fuchsia-500">
                    <Play className="size-4" /> Start Meme Hunter
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {!running && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
              <Zap className="size-3 text-fuchsia-400" /> Ready — hunt dips &amp; pumps.
            </span>
          )}
          {running && (
            <span className="hidden items-center gap-1 text-[11px] text-fuchsia-300 lg:flex">
              <Pause className="size-3" /> Click Stop to pause hunting.
            </span>
          )}
          <span
            className={`hidden items-center gap-1 text-[10px] xl:flex ${
              live ? 'text-emerald-400' : 'text-amber-400'
            }`}
            title={live ? 'Live pump.fun data' : 'Deterministic demo data'}
          >
            <Wifi className="size-3" />
            {live ? 'live API' : 'demo'}
          </span>
        </div>
      </div>
    </header>
  )
}