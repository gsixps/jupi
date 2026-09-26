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
import type { useBinanceBot } from '@/hooks/use-binance'
import { BINANCE_TRIANGLES } from '@/lib/binance'

interface BinanceMarketGridProps {
  binance: ReturnType<typeof useBinanceBot>
}

interface RouteRow {
  routeId: string
  name: string
  token: string
  crossSymbol: string
  usdtSymbol: string
  directUsd: number
  impliedUsd: number
  diffBps: number
}

interface SymbolRow {
  symbol: string
  priceUsd: number
  anchorUsd: number
  spark: { i: number; v: number }[]
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

export function BinanceMarketGrid({ binance }: BinanceMarketGridProps) {
  const routeRows: RouteRow[] = useMemo(() => {
    const priceBySym: Record<string, number> = {}
    for (const r of binance.rows) priceBySym[r.symbol] = r.priceUsd
    return BINANCE_TRIANGLES.map((t) => {
      const direct = priceBySym[t.directSymbol]
      const cross = priceBySym[t.crossSymbol]
      const usdt = priceBySym[t.usdtSymbol]
      if (!direct || !cross || !usdt || direct <= 0) {
        return { routeId: t.id, name: t.name, token: t.token, crossSymbol: t.crossSymbol, usdtSymbol: t.usdtSymbol, directUsd: 0, impliedUsd: 0, diffBps: 0 }
      }
      const implied = cross * usdt
      const diffBps = Math.round(((implied - direct) / direct) * 10000)
      return { routeId: t.id, name: t.name, token: t.token, crossSymbol: t.crossSymbol, usdtSymbol: t.usdtSymbol, directUsd: direct, impliedUsd: implied, diffBps }
    })
  }, [binance.rows])

  const symbolRows: SymbolRow[] = useMemo(() => {
    return binance.rows.map((r) => {
      const history = binance.priceHistory[r.symbol] ?? []
      return {
        symbol: r.symbol,
        priceUsd: r.priceUsd,
        anchorUsd: r.anchorUsd,
        spark: history.map((v, i) => ({ i, v })),
      }
    })
  }, [binance.rows, binance.priceHistory])

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
      {/* Arb routes */}
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowLeftRight className="size-4 text-amber-400" />
            Triangle Arb Routes
          </CardTitle>
          <CardDescription className="mt-1">
            Direct vs implied USD &middot; {routeRows.length} routes &middot;{' '}
            {binance.dataSource === 'live' ? 'binance.com API' : 'demo engine'}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <div className="max-h-96 overflow-y-auto scrollbar-thin pr-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs uppercase tracking-wider">Route</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Direct</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Implied</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Divergence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routeRows.map((r, i) => {
                  const up = r.diffBps >= 0
                  const open = binance.holdings.some(
                    (h) => h.status === 'open' && h.routeId === r.routeId
                  )
                  return (
                    <motion.tr
                      key={r.routeId}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.4) }}
                      className="border-b transition-colors hover:bg-muted/40"
                    >
                      <TableCell className="py-2">
                        <div className="flex flex-col">
                          <span className="font-semibold">{r.name}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {r.token}USDT vs {r.crossSymbol}
                            {' × '}
                            {r.usdtSymbol}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums">
                        {r.directUsd > 0 ? fmtUsd(r.directUsd, 6) : '—'}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                        {r.impliedUsd > 0 ? fmtUsd(r.impliedUsd, 6) : '—'}
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <span
                            className={`flex items-center gap-0.5 text-xs font-medium tabular-nums ${
                              r.diffBps > 0 ? 'text-emerald-400' : r.diffBps < 0 ? 'text-rose-400' : 'text-muted-foreground'
                            }`}
                          >
                            {r.diffBps > 0 ? <TrendingUp className="size-3" /> : r.diffBps < 0 ? <TrendingDown className="size-3" /> : null}
                            {r.diffBps >= 0 ? '+' : ''}
                            {r.diffBps.toFixed(1)} bps
                          </span>
                          {open && (
                            <Badge
                              variant="outline"
                              className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]"
                            >
                              <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
                              open
                            </Badge>
                          )}
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

      {/* Symbol prices */}
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="text-base">Spot Watchlist</CardTitle>
          <CardDescription className="mt-1">
            Live Binance prices &middot; {symbolRows.length} symbols
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <div className="max-h-96 overflow-y-auto scrollbar-thin pr-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs uppercase tracking-wider">Symbol</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Last (USD)</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Anchor</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {symbolRows.map((r, i) => {
                  const change =
                    r.anchorUsd > 0 ? ((r.priceUsd - r.anchorUsd) / r.anchorUsd) * 100 : 0
                  const up = change >= 0
                  return (
                    <motion.tr
                      key={r.symbol}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.4) }}
                      className="border-b transition-colors hover:bg-muted/40"
                    >
                      <TableCell className="py-2 font-semibold">{r.symbol}</TableCell>
                      <TableCell className="py-2 text-right font-medium tabular-nums">
                        {fmtUsd(r.priceUsd, 6)}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                        {fmtUsd(r.anchorUsd, 6)}
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