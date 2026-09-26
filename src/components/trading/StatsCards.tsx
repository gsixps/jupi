'use client'

import { motion } from 'framer-motion'
import {
  Banknote,
  Bot,
  Clock,
  Crosshair,
  Percent,
  Repeat,
  Target,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useTradingStore } from '@/lib/store'
import { fmtUsd, fmtPct, fmtDuration, fmtNum } from '@/lib/format'

interface StatDef {
  key: string
  label: string
  value: string
  sub?: string
  icon: React.ComponentType<{ className?: string }>
  tone?: 'default' | 'positive' | 'negative' | 'accent'
}

const toneClass: Record<NonNullable<StatDef['tone']>, string> = {
  default: 'text-foreground',
  positive: 'text-emerald-400',
  negative: 'text-rose-400',
  accent: 'text-violet-400',
}

export function StatsCards() {
  const stats = useTradingStore((s) => s.stats)
  const config = useTradingStore((s) => s.config)
  const positions = useTradingStore((s) => s.positions)
  const arbitrage = useTradingStore((s) => s.arbitrage)

  const capital = stats?.capital ?? config.capital
  const balance = stats?.balance ?? capital
  const equity = stats?.equity ?? capital
  const totalPnl = stats?.totalPnl ?? 0
  const totalPnlPct = stats?.totalPnlPct ?? 0
  const winRate = stats?.winRate ?? 0
  const totalTrades = stats?.totalTrades ?? 0
  const openPositionsCount = stats?.openPositions ?? positions.length
  const uptimeMs = stats?.uptimeMs ?? 0
  const arbCount = stats?.arbOpportunitiesDetected ?? arbitrage.length

  const pnlTone = totalPnl >= 0 ? 'positive' : 'negative'

  const items: StatDef[] = [
    {
      key: 'equity',
      label: 'Equity',
      value: fmtUsd(equity),
      sub: `Balance ${fmtUsd(balance)}`,
      icon: Wallet,
    },
    {
      key: 'pnl',
      label: 'Total P&L',
      value: fmtUsd(totalPnl),
      sub: fmtPct(totalPnlPct),
      icon: totalPnl >= 0 ? TrendingUp : Target,
      tone: pnlTone,
    },
    {
      key: 'winrate',
      label: 'Win Rate',
      value: `${winRate.toFixed(1)}%`,
      sub: `${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`,
      icon: Percent,
      tone: winRate >= 0.5 ? 'positive' : 'default',
    },
    {
      key: 'trades',
      label: 'Total Trades',
      value: fmtNum(totalTrades, 0),
      sub: totalTrades === 0 ? 'No trades yet' : `${stats?.bestTrade ?? 0} best`,
      icon: Repeat,
    },
    {
      key: 'positions',
      label: 'Open Positions',
      value: String(openPositionsCount),
      sub: `Max ${config.maxPositions}`,
      icon: Bot,
    },
    {
      key: 'balance',
      label: 'Available Balance',
      value: fmtUsd(balance),
      sub: `Capital ${fmtUsd(capital)}`,
      icon: Banknote,
    },
    {
      key: 'arb',
      label: 'Arb Opportunities',
      value: fmtNum(arbCount, 0),
      sub: `${stats?.arbTradesExecuted ?? 0} executed`,
      icon: Crosshair,
      tone: 'accent',
    },
    {
      key: 'uptime',
      label: 'Uptime',
      value: fmtDuration(uptimeMs),
      sub: stats?.running ? 'Running' : 'Stopped',
      icon: Clock,
      tone: stats?.running ? 'positive' : 'default',
    },
  ]

  return (
    <section
      aria-label="Bot statistics"
      className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4"
    >
      {items.map((it, i) => {
        const Icon = it.icon
        return (
          <motion.div
            key={it.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3) }}
          >
            <Card className="gap-0 p-4 md:p-5">
              <CardHeader className="p-0">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {it.label}
                  </CardTitle>
                  <div className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-3.5" />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0 pt-2">
                <div className={`text-xl font-semibold tabular-nums md:text-2xl ${toneClass[it.tone ?? 'default']}`}>
                  {it.value}
                </div>
                {it.sub && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{it.sub}</div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )
      })}
    </section>
  )
}
