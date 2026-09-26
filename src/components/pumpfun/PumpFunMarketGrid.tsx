'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { Flame, Rocket, Search, TrendingDown, TrendingUp } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { fmtUsd } from '@/lib/format'
import type { PumpFunBot } from '@/hooks/use-pumpfun'

interface PumpFunMarketGridProps {
  bot: PumpFunBot
}

function Sparkline({ data }: { data: { i: number; v: number }[] }) {
  if (!data || data.length < 2) return null
  const up = data[data.length - 1].v >= data[0].v
  const color = up ? 'rgb(16 185 129)' : 'rgb(244 63 94)'
  return (
    <div className="h-8 w-20">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    buy: { label: 'BUY', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
    hot: { label: 'HOT', cls: 'border-orange-500/40 bg-orange-500/10 text-orange-300' },
    sell: { label: 'SELL', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-300' },
    neutral: { label: 'NEUTRAL', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300' },
  }
  const cfg = map[verdict] ?? map.neutral
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] ${cfg.cls}`}>
      {verdict === 'sell' ? <TrendingDown className="size-3" /> : <TrendingUp className="size-3" />}
      {cfg.label}
    </Badge>
  )
}

function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    'new-listing': { label: 'NUEVO LISTING', cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
    dip: { label: 'DIP', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
    momentum: { label: 'MOMENTO', cls: 'border-orange-500/40 bg-orange-500/10 text-orange-300' },
    pump: { label: 'PUMP', cls: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300' },
  }
  const cfg = map[kind] ?? map.momentum
  return <Badge variant="outline" className={`gap-1 text-[10px] ${cfg.cls}`}>{cfg.label}</Badge>
}

export function PumpFunMarketGrid({ bot }: PumpFunMarketGridProps) {
  const rows = useMemo(() => {
    return bot.coins
      .map((c) => {
        const history = bot.priceHistory[c.id] ?? []
        return {
          ...c,
          spark: history.map((v, i) => ({ i, v })),
          relPct: c.refUsd > 0 ? ((c.priceUsd - c.refUsd) / c.refUsd) * 100 : 0,
        }
      })
      .sort((a, b) => b.score - a.score)
  }, [bot.coins, bot.priceHistory])

  const top = rows[0]
  const buyCount = rows.filter((r) => r.verdict === 'buy' || r.verdict === 'hot').length

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6">
      {/* Opportunity radar */}
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4 text-fuchsia-400" />
            New Opportunities Detected
          </CardTitle>
          <CardDescription className="mt-1">
            {bot.dataSource === 'live' ? 'pump.fun API' : 'demo engine'} &middot; cheap + momentum +
            new listings &middot; {bot.opps.length} recorded
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          {top && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 p-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{top.emoji}</span>
                <div>
                  <div className="text-sm font-semibold">
                    {top.symbol} <span className="font-normal text-muted-foreground">· {top.name}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    score {top.score} &middot; {fmtUsd(top.priceUsd, 8)} &middot; mcap {fmtUsd(top.mcapUsd)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Progress value={top.score} className="h-2 w-32" />
                <VerdictBadge verdict={top.verdict} />
              </div>
            </div>
          )}
          <div className="max-h-80 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {bot.opps.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No opportunities detected yet — start the hunter.
              </div>
            ) : (
              <div>
                {bot.opps.slice(0, 12).map((o) => (
                  <motion.div
                    key={o.id}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0"
                  >
                    <span className="text-lg">{o.emoji}</span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{o.symbol}</span>
                        <KindBadge kind={o.kind} />
                        {o.executed && (
                          <Badge variant="outline" className="gap-1 border-fuchsia-500/40 bg-fuchsia-500/10 text-[10px] text-fuchsia-300">
                            <Rocket className="size-3" /> executed
                          </Badge>
                        )}
                      </div>
                      <span className="truncate text-[10px] text-muted-foreground">{o.reason}</span>
                    </div>
                    <div className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                      {fmtUsd(o.priceUsd, 8)}
                    </div>
                    <div className="flex w-16 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums">
                      <Flame className={`size-3 ${o.score >= 60 ? 'text-orange-400' : 'text-muted-foreground'}`} />
                      {o.score}
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Meme coin quotes */}
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Rocket className="size-4 text-fuchsia-400" />
            Meme Coin Radar — {bot.coins.length} watched
          </CardTitle>
          <CardDescription className="mt-1">
            sorted by opportunity score &middot; {buyCount} buy-grade candidates right now
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <div className="max-h-[26rem] overflow-y-auto scrollbar-thin pr-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs uppercase tracking-wider">Coin</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Price (USD)</TableHead>
                  <TableHead className="hidden text-right text-xs uppercase tracking-wider md:table-cell">vs Ref</TableHead>
                  <TableHead className="hidden text-right text-xs uppercase tracking-wider lg:table-cell">Market Cap</TableHead>
                  <TableHead className="hidden text-right text-xs uppercase tracking-wider xl:table-cell">Momentum</TableHead>
                  <TableHead className="w-28 text-right text-xs uppercase tracking-wider">Score</TableHead>
                  <TableHead className="w-24 text-right text-xs uppercase tracking-wider">Signal</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => {
                  const up = r.relPct >= 0
                  return (
                    <motion.tr
                      key={r.id}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i * 0.03, 0.3) }}
                      className="border-b transition-colors hover:bg-muted/40"
                    >
                      <TableCell className="py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{r.emoji}</span>
                          <div className="leading-tight">
                            <div className="flex items-center gap-1.5 font-semibold">
                              {r.symbol}
                              {r.isNew && (
                                <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-[9px] text-sky-300">
                                  NEW
                                </Badge>
                              )}
                            </div>
                            <div className="hidden text-[10px] text-muted-foreground sm:block">{r.name}</div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-2 text-right font-medium tabular-nums">{fmtUsd(r.priceUsd, 8)}</TableCell>
                      <TableCell className="hidden py-2 text-right md:table-cell">
                        <span className={`tabular-nums ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {up ? '+' : ''}
                          {r.relPct.toFixed(2)}%
                        </span>
                      </TableCell>
                      <TableCell className="hidden py-2 text-right tabular-nums text-muted-foreground lg:table-cell">
                        {fmtUsd(r.mcapUsd)}
                      </TableCell>
                      <TableCell className="hidden py-2 text-right xl:table-cell">
                        <span
                          className={`flex items-center justify-end gap-1 text-xs tabular-nums ${
                            r.momentumPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {r.momentumPct >= 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                          {r.momentumPct >= 0 ? '+' : ''}
                          {r.momentumPct.toFixed(1)}%
                        </span>
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="hidden h-1.5 w-16 overflow-hidden rounded bg-muted sm:block">
                            <div
                              className={`h-full rounded ${
                                r.score >= 60 ? 'bg-fuchsia-500' : r.score >= 40 ? 'bg-orange-400' : 'bg-zinc-500'
                              }`}
                              style={{ width: `${r.score}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-xs font-semibold">{r.score}</span>
                        </div>
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <VerdictBadge verdict={r.verdict} />
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <Sparkline data={r.spark} />
                      </TableCell>
                    </motion.tr>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}