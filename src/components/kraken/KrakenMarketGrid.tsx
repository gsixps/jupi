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
import { fmtUsd, fmtCompact } from '@/lib/format'
import type { useKrakenBot } from '@/hooks/use-kraken'
import { KRAKEN_TRIANGLES } from '@/lib/kraken'

interface KrakenMarketGridProps {
  kraken: ReturnType<typeof useKrakenBot>
}

interface RouteRow {
  routeId: string
  name: string
  token: string
  directSymbol: string
  crossSymbol: string
  usdtSymbol: string
  directUsd: number
  impliedUsd: number
  diffBps: number
}

interface SymbolRow {
  symbol: string
  base: string
  quote: string
  kind: string
  priceUsd: number
  anchorUsd: number
  change24hPct: number
  vol24h: number
  hasVol: boolean
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

const KIND_LABEL: Record<string, string> = {
  crypto: 'crypto',
  stable: 'stable',
  gold: 'gold',
  cross: 'cross',
  fiat: 'fiat',
}

export function KrakenMarketGrid({ kraken }: KrakenMarketGridProps) {
  const routeRows: RouteRow[] = useMemo(() => {
    const rawBySym: Record<string, number> = {}
    for (const r of kraken.rows) rawBySym[r.symbol] = r.lastRaw
    return KRAKEN_TRIANGLES.map((t) => {
      const direct = rawBySym[t.directSymbol]
      const cross = rawBySym[t.crossSymbol]
      const usdt = rawBySym[t.usdtSymbol]
      if (!direct || !cross || !usdt || direct <= 0) {
        return { routeId: t.id, name: t.name, token: t.token, directSymbol: t.directSymbol, crossSymbol: t.crossSymbol, usdtSymbol: t.usdtSymbol, directUsd: 0, impliedUsd: 0, diffBps: 0 }
      }
      const implied = cross * usdt
      const diffBps = Math.round(((implied - direct) / direct) * 10000)
      return { routeId: t.id, name: t.name, token: t.token, directSymbol: t.directSymbol, crossSymbol: t.crossSymbol, usdtSymbol: t.usdtSymbol, directUsd: direct, impliedUsd: implied, diffBps }
    })
  }, [kraken.rows])

  const symbolRows: SymbolRow[] = useMemo(() => {
    return kraken.rows.map((r) => {
      const history = kraken.priceHistory[r.symbol] ?? []
      return {
        symbol: r.symbol,
        base: r.base,
        quote: r.quote,
        kind: r.kind,
        priceUsd: r.priceUsd,
        anchorUsd: r.anchorUsd,
        change24hPct: r.change24hPct,
        vol24h: r.vol24h,
        hasVol: r.hasVol,
        spark: history.map((v, i) => ({ i, v })),
      }
    })
  }, [kraken.rows, kraken.priceHistory])

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
      {/* Arb routes */}
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowLeftRight className="size-4 text-teal-400" />
            Triangle Arb Routes
          </CardTitle>
          <CardDescription className="mt-1">
            Direct vs implied USD &middot; {routeRows.length} routes &middot;{' '}
            {kraken.dataSource === 'live' ? 'api.kraken.com' : 'demo engine'}
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
                  const open = kraken.holdings.some(
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
                            {r.directSymbol} vs {r.crossSymbol}
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
                              className="gap-1 border-teal-500/40 bg-teal-500/10 text-teal-300 text-[10px]"
                            >
                              <span className="size-1.5 animate-pulse rounded-full bg-teal-400" />
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
          <CardTitle className="text-base">Kraken Product Watchlist</CardTitle>
          <CardDescription className="mt-1">
            All Kraken products in USD &middot; {symbolRows.length} pairs
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <div className="max-h-96 overflow-y-auto scrollbar-thin pr-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs uppercase tracking-wider">Pair</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Price (USD)</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">24h</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Vol</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {symbolRows.map((r, i) => {
                  const up = r.change24hPct >= 0
                  return (
                    <motion.tr
                      key={r.symbol}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.4) }}
                      className="border-b transition-colors hover:bg-muted/40"
                    >
                      <TableCell className="py-2">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold">{r.base}</span>
                            <span className="text-[10px] text-muted-foreground">/{r.quote}</span>
                            <Badge
                              variant="outline"
                              className="px-1.5 py-0 text-[9px] text-teal-300/90"
                            >
                              {KIND_LABEL[r.kind] ?? r.kind}
                            </Badge>
                          </div>
                          <span className="text-[10px] text-muted-foreground">{r.symbol}</span>
                        </div>
                      </TableCell>
                      <TableCell className="py-2 text-right font-medium tabular-nums">
                        {fmtUsd(r.priceUsd, r.priceUsd < 1 ? 6 : 2)}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                        {r.hasVol ? fmtCompact(r.vol24h) : '—'}
                      </TableCell>
                      <TableCell className="py-2 text-right">
                        <span
                          className={`flex items-center justify-end gap-0.5 text-xs font-medium tabular-nums ${
                            up ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                          {up ? '+' : ''}
                          {r.change24hPct.toFixed(3)}%
                        </span>
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