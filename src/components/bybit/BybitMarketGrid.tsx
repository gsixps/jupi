'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Line, LineChart, ResponsiveContainer } from 'recharts'
import { ArrowDownRight, ArrowUpRight, Building2, Layers } from 'lucide-react'

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
import type { useBybitBot } from '@/hooks/use-bybit'

interface BybitMarketGridProps {
  bybit: ReturnType<typeof useBybitBot>
}

function Sparkline({ data }: { data: { i: number; v: number }[] }) {
  if (!data || data.length < 2) return null
  const up = data[data.length - 1].v >= data[0].v
  const color = up ? 'rgb(249 115 22)' : 'rgb(16 185 129)'
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

function sparkOf(series: number[] | undefined) {
  if (!series) return []
  return series.slice(-40).map((v, i) => ({ i, v }))
}

/**
 * RWA watchlist — every xStock paired with its TradFi perp, showing the live
 * basis. This is the table the strategy trades off: the wider the basis, the
 * more convergence is left to capture.
 */
export function BybitMarketGrid({ bybit }: BybitMarketGridProps) {
  const { rows, priceHistory, config, holdings, opps, trades, dataSource } = bybit

  const sorted = useMemo(
    () => [...rows].sort((a, b) => Math.abs(b.basisBps) - Math.abs(a.basisBps)),
    [rows]
  )

  const openPairs = useMemo(
    () => new Set(holdings.filter((h) => h.status === 'open').map((h) => h.pairId)),
    [holdings]
  )

  return (
    <div className="space-y-4 md:space-y-6">
      {/* RWA watchlist */}
      <Card>
        <CardHeader className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="size-4 text-orange-400" />
                RWA shelf &middot; xStock vs TradFi perp
              </CardTitle>
              <CardDescription className="mt-1">
                Basis = (perp &minus; spot) / spot. Entry when |basis| ≥{' '}
                {config.entryBasisBps}bps.
              </CardDescription>
            </div>
            <Badge
              variant="outline"
              className={
                dataSource === 'live'
                  ? 'gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'gap-1 border-amber-500/40 bg-amber-500/10 text-amber-300'
              }
            >
              {dataSource === 'live' ? 'live api.bybit.com' : 'demo engine'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>RWA</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead className="text-right">Spot (xStock)</TableHead>
                  <TableHead className="text-right">Perp</TableHead>
                  <TableHead className="text-right">Basis</TableHead>
                  <TableHead>Spot trend</TableHead>
                  <TableHead className="text-right">Signal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, idx) => {
                  const rich = r.basisBps > 0
                  const inTrade = openPairs.has(r.pairId)
                  return (
                    <motion.tr
                      key={r.pairId}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(idx * 0.02, 0.3) }}
                      className={
                        inTrade
                          ? 'bg-orange-500/5'
                          : r.tradable
                            ? 'bg-amber-500/5'
                            : ''
                      }
                    >
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{r.token}</span>
                          {!r.dataLive && (
                            <span
                              className="size-1.5 rounded-full bg-amber-400"
                              title="perfil sin precio en vivo (mock)"
                            />
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {r.sector}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{r.company}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtUsd(r.spotUsd)}
                        <div className="text-[10px] text-muted-foreground">
                          {r.spotSymbol}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtUsd(r.perpUsd)}
                        <div className="text-[10px] text-muted-foreground">
                          {r.perpSymbol}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span
                          className={
                            Math.abs(r.basisBps) >= config.entryBasisBps
                              ? rich
                                ? 'font-semibold text-rose-400'
                                : 'font-semibold text-emerald-400'
                              : 'text-muted-foreground'
                          }
                        >
                          {r.basisBps >= 0 ? '+' : ''}
                          {r.basisBps}bps
                        </span>
                        <div className="text-[10px] text-muted-foreground">
                          {rich ? 'perp rico' : 'perp barato'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Sparkline data={sparkOf(priceHistory[r.spotSymbol])} />
                      </TableCell>
                      <TableCell className="text-right">
                        {inTrade ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-orange-500/40 text-orange-300"
                          >
                            <Layers className="size-3" /> hedged
                          </Badge>
                        ) : r.tradable ? (
                          <Badge
                            variant="outline"
                            className={cxBadge(rich)}
                          >
                            {rich ? (
                              <ArrowDownRight className="size-3" />
                            ) : (
                              <ArrowUpRight className="size-3" />
                            )}
                            {rich ? 'buy spot / short perp' : 'sell spot / long perp'}
                          </Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">
                            — quiet
                          </span>
                        )}
                      </TableCell>
                    </motion.tr>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Opps + trade log */}
      <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="p-0">
            <CardTitle className="text-base">Signals detected</CardTitle>
            <CardDescription>
              Every basis window the bot acted on this session.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 pt-3">
            {opps.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No signals yet — waiting for a basis above{' '}
                {config.entryBasisBps}bps.
              </p>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {opps.slice(0, 40).map((o) => (
                  <div
                    key={o.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 px-2.5 py-1 text-[11px]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{o.token}</span>
                      <span
                        className={
                          o.basisBps > 0 ? 'text-rose-400' : 'text-emerald-400'
                        }
                      >
                        {o.basisBps >= 0 ? '+' : ''}
                        {o.basisBps}bps
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-muted-foreground">
                      <span>{fmtUsd(o.notionalUsd)}</span>
                      <span className="text-emerald-400">
                        +{fmtUsd(o.profitUsd, 2)} est.
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="p-0">
            <CardTitle className="text-base">Log</CardTitle>
            <CardDescription>Scans, hedges, closes and any halt.</CardDescription>
          </CardHeader>
          <CardContent className="p-0 pt-3">
            {bybit.logs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Start the bot to see its log.
              </p>
            ) : (
              <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1 font-mono text-[10px]">
                {bybit.logs.map((l, i) => (
                  <div
                    key={`${l.time}-${i}`}
                    className={
                      l.level === 'trade'
                        ? 'text-orange-300'
                        : l.level === 'error'
                          ? 'text-rose-400'
                          : l.level === 'warn'
                            ? 'text-amber-400'
                            : 'text-muted-foreground'
                    }
                  >
                    {new Date(l.time).toLocaleTimeString()} {l.msg}
                  </div>
                ))}
              </div>
            )}
            {trades.length > 0 && (
              <p className="mt-2 text-[10px] text-muted-foreground">
                {trades.length} trade records this session.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function cxBadge(rich: boolean) {
  return rich
    ? 'gap-1 border-rose-500/40 text-rose-300'
    : 'gap-1 border-emerald-500/40 text-emerald-300'
}
