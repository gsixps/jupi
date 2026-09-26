'use client'

import { motion } from 'framer-motion'
import { ArrowRight, Bot, Crosshair, TrendingDown, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useTradingStore } from '@/lib/store'
import { fmtUsd, fmtNum, fmtTime, fmtPct } from '@/lib/format'
import type { Trade } from '@/lib/trading-types'

function StrategyBadge({ strategy }: { strategy: Trade['strategy'] }) {
  if (strategy === 'arbitrage') {
    return (
      <Badge
        variant="outline"
        className="border-violet-500/40 bg-violet-500/10 text-violet-300"
      >
        <Crosshair className="size-3" /> Arbitrage
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 text-amber-300"
    >
      <Bot className="size-3" /> Mean Reversion
    </Badge>
  )
}

function SideBadge({ side }: { side: Trade['side'] }) {
  if (side === 'BUY') {
    return (
      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
        BUY
      </Badge>
    )
  }
  if (side === 'SELL') {
    return (
      <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-rose-300">
        SELL
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-300">
      ARB
    </Badge>
  )
}

function TradeRow({ t, index }: { t: Trade; index: number }) {
  const win = t.win
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, backgroundColor: 'rgba(16,185,129,0.10)' }}
      animate={{ opacity: 1, y: 0, backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.01, 0.15) }}
      className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0"
    >
      <div className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
        {fmtTime(t.closedAt ?? t.openedAt)}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <StrategyBadge strategy={t.strategy} />
      </div>
      <div className="hidden w-12 shrink-0 sm:block">
        <SideBadge side={t.side} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 text-xs">
        <span className="font-medium">{t.inputSymbol}</span>
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium">{t.outputSymbol}</span>
      </div>
      <div className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {fmtNum(t.inputAmount, 4)} {t.inputSymbol}
      </div>
      <div
        className={`flex w-24 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
          win ? 'text-emerald-400' : 'text-rose-400'
        }`}
      >
        {win ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
        {fmtUsd(t.pnl)}
        <span className="text-[10px] font-normal opacity-70">({fmtPct(t.pnlPct)})</span>
      </div>
    </motion.div>
  )
}

export function TradeFeed() {
  const trades = useTradingStore((s) => s.trades)
  const shown = trades.slice(0, 100)

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Live Trade Feed</CardTitle>
            <CardDescription className="mt-1">
              Most recent simulated trades
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">
            {trades.length} shown
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        <div className="max-h-96 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
          {shown.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              No trades yet &mdash; start the bot to begin.
            </div>
          ) : (
            shown.map((t, i) => <TradeRow key={t.id || `tr-${i}`} t={t} index={i} />)
          )}
        </div>
      </CardContent>
    </Card>
  )
}
