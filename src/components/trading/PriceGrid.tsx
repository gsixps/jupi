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
import { Skeleton } from '@/components/ui/skeleton'
import { useTradingStore } from '@/lib/store'
import { fmtUsdFull, fmtPct } from '@/lib/format'

interface PriceRow {
  symbol: string
  mint: string
  price: number
  change: number | undefined
  spark: { i: number; v: number }[]
}

function Sparkline({ data, up }: { data: { i: number; v: number }[]; up: boolean }) {
  if (!data || data.length < 2) return null
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

export function PriceGrid() {
  const prices = useTradingStore((s) => s.prices)
  const change24h = useTradingStore((s) => s.change24h)
  const priceHistory = useTradingStore((s) => s.priceHistory)
  const tokens = useTradingStore((s) => s.tokens)

  const rows: PriceRow[] = useMemo(() => {
    return tokens
      .filter((t) => prices[t.mint] !== undefined)
      .map((t) => {
        const history = priceHistory[t.mint] ?? []
        const spark = history.map((v, i) => ({ i, v }))
        return {
          symbol: t.symbol,
          mint: t.mint,
          price: prices[t.mint],
          change: change24h[t.mint],
          spark,
        }
      })
  }, [prices, change24h, priceHistory, tokens])

  const hasData = rows.length > 0

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Market Prices</CardTitle>
            <CardDescription className="mt-1">
              Live Jupiter DEX prices &middot; {rows.length} tokens
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        {tokens.length === 0 && !hasData ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="max-h-96 overflow-y-auto scrollbar-thin pr-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs uppercase tracking-wider">Token</TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">
                    Price
                  </TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">
                    24h
                  </TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wider">
                    Trend
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => {
                  const up = (r.change ?? 0) >= 0
                  return (
                    <motion.tr
                      key={r.mint}
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.4) }}
                      className="border-b transition-colors hover:bg-muted/40"
                    >
                      <TableCell className="py-2 font-semibold">{r.symbol}</TableCell>
                      <TableCell className="py-2 text-right font-medium tabular-nums">
                        {fmtUsdFull(r.price, r.price >= 1 ? 4 : 6)}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.change === undefined ? (
                          <span className="text-xs text-muted-foreground">--</span>
                        ) : (
                          <span
                            className={`flex items-center justify-end gap-0.5 text-xs font-medium tabular-nums ${
                              up ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {up ? (
                              <TrendingUp className="size-3" />
                            ) : (
                              <TrendingDown className="size-3" />
                            )}
                            {fmtPct(r.change)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.spark.length < 2 ? (
                          <span className="text-xs text-muted-foreground">--</span>
                        ) : (
                          <div className="ml-auto inline-block">
                            <Sparkline data={r.spark} up={up} />
                          </div>
                        )}
                      </TableCell>
                    </motion.tr>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
