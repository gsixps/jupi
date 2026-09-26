'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { ArrowLeftRight, TrendingDown, TrendingUp } from 'lucide-react'
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
import { fmtUsd } from '@/lib/format'
import type { CoinBot } from '@/hooks/use-coin'

interface CoinMarketGridProps {
  bot: CoinBot
}

function Sparkline({ data }: { data: { i: number; v: number }[] }) {
  if (!data || data.length < 2) return null
  const up = data[data.length - 1].v >= data[0].v
  const color = up ? 'rgb(16 185 129)' : 'rgb(244 63 94)'
  return (
    <div className="h-8 w-20">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function CoinMarketGrid({ bot }: CoinMarketGridProps) {
  const rows = useMemo(() => {
    return bot.rows.map((r) => {
      const history = bot.priceHistory[r.symbol] ?? []
      return {
        symbol: r.symbol,
        quote: r.quote,
        priceUsd: r.priceUsd,
        anchorUsd: r.anchorUsd,
        spark: history.map((v, i) => ({ i, v })),
      }
    })
  }, [bot.rows, bot.priceHistory])

  const cheapest = rows.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a), rows[0])
  const dearest = rows.reduce((a, b) => (b.priceUsd > a.priceUsd ? b : a), rows[0])
  const spreadBps =
    cheapest && dearest && cheapest.priceUsd > 0
      ? Math.round(((dearest.priceUsd - cheapest.priceUsd) / cheapest.priceUsd) * 10000)
      : 0

  const symbols = bot.asset.symbol
  const accent = bot.asset.accent
  const accentText =
    accent === 'indigo' ? 'text-indigo-400' : 'text-amber-400'
  const accentBadge =
    accent === 'indigo'
      ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-300'

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
      {/* Cheapest vs dearest spread */}
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowLeftRight className={`size-4 ${accentText}`} />
            Cross-Pair Spread
          </CardTitle>
          <CardDescription className="mt-1">
            Buy {symbols} on the cheapest pair &middot; sell on the dearest
            &middot; {bot.dataSource === 'live' ? 'binance.com API' : 'demo engine'}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <div className="grid grid-cols-1 gap-2">
            {cheapest && dearest && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Cheapest ({symbols})
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {cheapest.symbol}{' '}
                    <span className={accentText}>{fmtUsd(cheapest.priceUsd, 2)}</span>
                  </div>
                </div>
                <Badge variant="outline" className={`gap-1 text-[10px] ${accentBadge}`}>
                  <TrendingUp className="size-3" />
                  buy here
                </Badge>
              </div>
            )}
            {cheapest && dearest && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 p-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Dearest ({symbols})
                  </div>
                  <div className="text-lg font-semibold tabular-nums">
                    {dearest.symbol}{' '}
                    <span className={accentText}>{fmtUsd(dearest.priceUsd, 2)}</span>
                  </div>
                </div>
                <Badge variant="outline" className={`gap-1 text-[10px] ${accentBadge}`}>
                  <TrendingUp className="size-3" />
                  sell here
                </Badge>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border/60 p-3">
              <span className="text-xs text-muted-foreground">Current spread</span>
              <span
                className={`flex items-center gap-1 text-sm font-semibold tabular-nums ${
                  spreadBps > 0 ? 'text-emerald-400' : 'text-muted-foreground'
                }`}
              >
                {spreadBps > 0 ? <TrendingUp className="size-4" /> : null}
                +{spreadBps} bps
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pair prices */}
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className={`size-4 ${accentText}`} />
            {symbols} Pair Quotes
          </CardTitle>
          <CardDescription className="mt-1">
            Same coin against different stables &middot; {rows.length} pairs
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <div className="max-h-72 overflow-y-auto scrollbar-thin pr-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs uppercase tracking-wider">Pair</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Last (USD)</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Anchor</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => {
                  const change =
                    r.anchorUsd > 0 ? ((r.priceUsd - r.anchorUsd) / r.anchorUsd) * 100 : 0
                  const up = change >= 0
                  return (
                    <motion.tr
                      key={r.symbol}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i * 0.05, 0.3) }}
                      className="border-b transition-colors hover:bg-muted/40"
                    >
                      <TableCell className="py-2 font-semibold">{r.symbol}</TableCell>
                      <TableCell className="py-2 text-right font-medium tabular-nums">
                        {fmtUsd(r.priceUsd, 2)}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                        {fmtUsd(r.anchorUsd, 2)}
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span
                            className={`flex items-center gap-0.5 text-xs font-medium tabular-nums ${
                              up ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                            {up ? '+' : ''}
                            {change.toFixed(3)}%
                          </span>
                          <Sparkline data={r.spark} />
                        </div>
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