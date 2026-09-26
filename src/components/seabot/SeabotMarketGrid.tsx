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
import { fmtEth, fmtEthUsd } from '@/lib/format'
import { ETH_USD_PRICE } from '@/lib/seabot'
import type { useSeabot } from '@/hooks/use-seabot'

interface SeabotMarketGridProps {
  seabot: ReturnType<typeof useSeabot>
}

interface Row {
  slug: string
  name: string
  tier: number
  floor: number
  maxBuy: number
  change: number
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

function TierBadge({ tier }: { tier: number }) {
  const cls =
    tier === 1
      ? 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
      : tier === 2
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
        : tier === 3
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          : 'border-violet-500/40 bg-violet-500/10 text-violet-300'
  return (
    <Badge variant="outline" className={`text-[10px] ${cls}`}>
      T{tier}
    </Badge>
  )
}

export function SeabotMarketGrid({ seabot }: SeabotMarketGridProps) {
  const rows: Row[] = useMemo(() => {
    return seabot.collections.map((c) => {
      const history = seabot.priceHistory[c.slug] ?? []
      const spark = history.map((v, i) => ({ i, v }))
      const prev = history.length > 1 ? history[0] : c.baseFloor
      const change = prev > 0 ? ((c.floorPrice - prev) / prev) * 100 : 0
      return {
        slug: c.slug,
        name: c.name,
        tier: c.tier,
        floor: c.floorPrice,
        maxBuy: c.maxBuyPrice,
        change,
        spark,
      }
    })
  }, [seabot.collections, seabot.priceHistory])

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">NFT Floor Prices</CardTitle>
            <CardDescription className="mt-1">
              Watchlist &middot; {rows.length} collections &middot; mock floor engine
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        <div className="max-h-96 overflow-y-auto scrollbar-thin pr-1">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs uppercase tracking-wider">Collection</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Floor (ETH)</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Floor ($)</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Max Buy</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Trend</TableHead>
                <TableHead className="text-right text-xs uppercase tracking-wider">Tier</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const up = r.change >= 0
                const affordable = seabot.cashEth >= r.maxBuy
                return (
                  <motion.tr
                    key={r.slug}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.18, delay: Math.min(i * 0.015, 0.4) }}
                    className="border-b transition-colors hover:bg-muted/40"
                  >
                    <TableCell className="py-2 font-semibold">{r.name}</TableCell>
                    <TableCell className="py-2 text-right font-medium tabular-nums">
                      {fmtEth(r.floor)}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                      {fmtEthUsd(r.floor, ETH_USD_PRICE)}
                    </TableCell>
                    <TableCell className="py-2 text-right tabular-nums text-cyan-300">
                      {fmtEth(r.maxBuy)}
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      <span
                        className={`flex items-center justify-end gap-0.5 text-xs font-medium tabular-nums ${
                          up ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                        {up ? '+' : ''}
                        {r.change.toFixed(2)}%
                      </span>
                    </TableCell>
                    <TableCell className="py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Sparkline data={r.spark} up={up} />
                        <TierBadge tier={r.tier} />
                        {!affordable && (
                          <span className="text-[10px] text-muted-foreground" title="Cash balance below max buy price">
                            locked
                          </span>
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
  )
}