'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Bitcoin,
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
import type { CoinBot } from '@/hooks/use-coin'

interface CoinHeaderProps {
  bot: CoinBot
}

function accentCls(accent: string, running: boolean) {
  if (accent === 'indigo') {
    return running
      ? 'gap-1 border-indigo-500/40 bg-indigo-500/15 text-indigo-300'
      : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
  }
  return running
    ? 'gap-1 border-amber-500/40 bg-amber-500/15 text-amber-300'
    : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
}

/**
 * Header for the Bitcoin / Ethereum accumulation bot.
 * Shows equity + realized P&L + win-rate in USD, plus the stored coin balance.
 */
export function CoinHeader({ bot }: CoinHeaderProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)

  const stats = bot.stats
  const equity = stats?.equityUsd ?? bot.capitalUsd
  const totalPnl = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const storedQty = stats?.storedQty ?? 0
  const pnlPositive = totalPnl >= 0
  const running = bot.enabled
  const live = bot.dataSource === 'live'
  const accent = bot.asset.accent
  const name = bot.asset.name
  const symbol = bot.asset.symbol
  const iconCls =
    accent === 'indigo'
      ? 'bg-indigo-500/15 text-indigo-400 ring-1 ring-indigo-500/30'
      : 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30'
  const btnCls =
    accent === 'indigo'
      ? 'bg-indigo-600 text-white hover:bg-indigo-500'
      : 'bg-amber-600 text-white hover:bg-amber-500'

  const handleStart = () => {
    setConfirmedThisSession(true)
    bot.start()
  }

  return (
    <header
      className={`sticky top-0 z-40 border-b bg-background/80 backdrop-blur ${
        accent === 'indigo' ? 'border-indigo-500/20' : 'border-amber-500/20'
      } supports-[backdrop-filter]:bg-background/60`}
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        {/* Left: brand */}
        <div className="flex items-center gap-3">
          <div className={`flex size-9 items-center justify-center rounded-lg ${iconCls}`}>
            {accent === 'indigo' ? (
              <TrendingUp className="size-5" />
            ) : (
              <Bitcoin className="size-5" />
            )}
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">{name}</h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Buy cheap &middot; sell expensive &middot; accumulate {symbol} &middot; live binance API
            </p>
          </div>
        </div>

        {/* Right: stats + badge + start/stop */}
        <div className="flex items-center gap-3 md:gap-4">
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
                Stored {symbol}
              </div>
              <div className="text-base font-semibold tabular-nums">
                {storedQty.toFixed(6)}
              </div>
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

          <Badge variant="outline" className={accentCls(accent, running)}>
            {accent === 'indigo' ? (
              <TrendingUp
                className={`size-3 ${running ? 'animate-pulse text-indigo-400' : ''}`}
              />
            ) : (
              <Bitcoin
                className={`size-3 ${running ? 'animate-pulse text-amber-400' : ''}`}
              />
            )}
            {symbol} · BUY SELL · ACCUMULATE
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
            <Button size="sm" onClick={handleStart} className={`gap-1.5 ${btnCls}`}>
              <Play className="size-3.5" /> Start
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" className={`gap-1.5 ${btnCls}`}>
                  <Play className="size-3.5" /> Start
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    {accent === 'indigo' ? (
                      <TrendingUp className={`size-5 text-indigo-400`} />
                    ) : (
                      <Bitcoin className="size-5 text-amber-400" />
                    )}
                    Start the {name} accumulation bot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot reads live {symbol} prices from the Binance API
                    (pairs: BTCUSDT / BTCUSDC / BTCFDUSD equivalents for{' '}
                    {symbol}). It buys {symbol} on the cheapest pair, stores the
                    coins, and sells on the dearest pair at take-profit /
                    stop-loss / trailing levels — netting +{symbol} every cycle.
                    Capital is fictional (
                    {fmtUsd(bot.capitalUsd)}) — no real funds are at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className={`gap-1.5 ${btnCls}`}
                  >
                    <Play className="size-4" /> Start {symbol} Bot
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}

          {!running && (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground lg:flex">
              <Zap className={`size-3 ${accent === 'indigo' ? 'text-indigo-400' : 'text-amber-400'}`} />
              Ready — no wallet needed.
            </span>
          )}
          {running && (
            <span className={`hidden items-center gap-1 text-[11px] lg:flex ${accent === 'indigo' ? 'text-indigo-300' : 'text-amber-300'}`}>
              <Pause className="size-3" /> Click Stop to pause.
            </span>
          )}
          <span
            className={`hidden items-center gap-1 text-[10px] xl:flex ${
              live ? 'text-emerald-400' : 'text-amber-400'
            }`}
            title={live ? 'Live binance.com data' : 'Deterministic demo data'}
          >
            <Wifi className="size-3" />
            {live ? 'live API' : 'demo'}
          </span>
        </div>
      </div>
    </header>
  )
}