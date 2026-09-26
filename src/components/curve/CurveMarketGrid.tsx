'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { TrendingDown, TrendingUp } from 'lucide-react'
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
import type { useCurveBot } from '@/hooks/use-curve'

interface CurveMarketGridProps {
  curve: ReturnType<typeof useCurveBot>
}

interface Row {
  poolId: string
  name: string
  quote: number
  deviationBps: number
  usdTotal: number
  coins: { symbol: string; price: number }[]
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

function CoinPrice({ price, symbol }: { price: number; symbol: string }) {
  const deviation = (price - 1) * 10000
  const up = deviation >= 0
  const isStable = symbol.length <= 5
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${
        isStable ? (up ? 'text-emerald-400' : 'text-rose-400') : 'text-muted-foreground'
      }`}
      title={isStable ? `${symbol} ${deviation >= 0 ? '+' : ''}${deviation.toFixed(1)}bps from $1` : 'yield token'}
    >
      {fmtUsd(price, 6)}
    </span>
  )
}

export function CurveMarketGrid({ curve }: CurveMarketGridProps) {
  const rows: Row[] = useMemo(() => {
    return curve.pools.map((p) => {
      const history = curve.priceHistory[p.address] ?? []
      const spark = history.map((v, i) => ({ i, v }))
      return {
        poolId: p.id,
        name: p.name,
        quote: p.quote,
        deviationBps: p.deviationBps,
        usdTotal: p.usdTotal,
        coins: p.coins.map((c) => ({ symbol: c.symbol, price: c.usdPrice })),
        spark,
      }
    })
  }, [curve.pools, curve.priceHistory])

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Curve Stablecoin Pools</CardTitle>
            <CardDescription className="mt-1">
              Live implied USD quotes &middot; {rows.length} pools &middot;{' '}
              {curve.dataSource === 'live' ? 'curve.finance API' : 'demo engine'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        <div className="max-h-96 overflow-y-auto scrollbar-thin pr-1">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs uppercase tracking-wider">Pool</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Coins (USD)</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Deviation</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">TVL</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Trend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const up = r.deviationBps >= 0
                const dev = Math.abs(r.deviationBps)
                return (
                  <motion.tr
                    key={r.poolId}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.4) }}
                    className="border-b transition-colors hover:bg-muted/40"
                  >
                    <TableCell className="py-2 font-semibold">{r.name}</TableCell>
                    <TableCell className="py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {r.coins.map((c) => (
                          <CoinPrice key={c.symbol} price={c.price} symbol={c.symbol} />
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      <span
                        className={`flex items-center justify-end gap-0.5 text-xs font-medium tabular-nums ${
                          dev > 0 ? (up ? 'text-emerald-400' : 'text-rose-400') : 'text-muted-foreground'
                        }`}
                      >
                        <Badge variant="outline" className="text-[10px] border-border/60">
                          {dev > 0 ? (
                            up ? <TrendingUp className="mr-1 size-3" /> : <TrendingDown className="mr-1 size-3" />
                          ) : null}
                          {up ? '+' : ''}
                          {r.deviationBps.toFixed(1)} bps
                        </Badge>
                      </span>
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                      {fmtUsd(r.usdTotal)}
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
  )
}