'use client'

import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useTradingStore } from '@/lib/store'
import { fmtUsd, fmtTime } from '@/lib/format'
import { Activity } from 'lucide-react'

interface TooltipPayload {
  payload: { time: number; equity: number; balance: number; openPnl: number }
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload || payload.length === 0) return null
  const p = payload[0].payload
  return (
    <div className="rounded-lg border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      <div className="text-muted-foreground">{fmtTime(p.time)}</div>
      <div className="font-semibold text-emerald-400">Equity: {fmtUsd(p.equity)}</div>
      <div className="text-muted-foreground">Balance: {fmtUsd(p.balance)}</div>
      <div className={p.openPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
        Open P&amp;L: {fmtUsd(p.openPnl)}
      </div>
    </div>
  )
}

export function EquityChart() {
  const equity = useTradingStore((s) => s.equity)
  const stats = useTradingStore((s) => s.stats)
  const config = useTradingStore((s) => s.config)

  const data = useMemo(
    () =>
      equity.map((p) => ({
        time: p.timestamp,
        equity: p.equity,
        balance: p.balance,
        openPnl: p.openPnl,
      })),
    [equity],
  )

  const currentEquity = stats?.equity ?? config.capital
  const capital = stats?.capital ?? config.capital
  const pnl = currentEquity - capital
  const pnlPct = capital > 0 ? (pnl / capital) * 100 : 0
  const pnlPositive = pnl >= 0

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4 text-emerald-400" />
              Equity Curve
            </CardTitle>
            <CardDescription className="mt-1">
              {data.length} points &middot; live since bot start
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums">{fmtUsd(currentEquity)}</div>
            <div className={`text-xs font-medium ${pnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {pnlPositive ? '+' : ''}
              {fmtUsd(pnl)} ({pnlPositive ? '+' : ''}
              {pnlPct.toFixed(2)}%)
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        <div className="h-64 w-full md:h-72">
          {data.length < 2 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Skeleton className="h-56 w-full" />
              <p className="text-xs">
                {data.length === 0
                  ? 'Waiting for equity data… start the bot to begin.'
                  : 'Collecting data…'}
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 8%)" vertical={false} />
                <XAxis
                  dataKey="time"
                  tickFormatter={fmtTime}
                  tick={{ fill: 'oklch(0.708 0 0)', fontSize: 11 }}
                  axisLine={{ stroke: 'oklch(1 0 0 / 10%)' }}
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={(v: number) => fmtUsd(v)}
                  tick={{ fill: 'oklch(0.708 0 0)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                  domain={['auto', 'auto']}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke="rgb(16 185 129)"
                  strokeWidth={2}
                  fill="url(#equityGradient)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
