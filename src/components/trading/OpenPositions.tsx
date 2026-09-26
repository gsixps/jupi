'use client'

import { useMemo } from 'react'
import { Boxes } from 'lucide-react'
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
import { useTradingStore } from '@/lib/store'
import { fmtUsd, fmtUsdFull, fmtDuration, fmtNum } from '@/lib/format'

export function OpenPositions() {
  const positions = useTradingStore((s) => s.positions)
  const prices = useTradingStore((s) => s.prices)

  const sorted = useMemo(
    () => [...positions].sort((a, b) => b.openedAt - a.openedAt),
    [positions],
  )

  const totalValue = sorted.reduce((acc, p) => {
    const px = prices[p.mint] ?? p.entryPrice
    return acc + px * p.amount
  }, 0)
  const totalCost = sorted.reduce((acc, p) => acc + p.costUsd, 0)
  const totalPnl = totalValue - totalCost

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="size-4 text-emerald-400" />
              Open Positions
            </CardTitle>
            <CardDescription className="mt-1">
              {sorted.length} open · {fmtUsd(totalValue)} value
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Unrealized
            </div>
            <div
              className={`text-sm font-semibold tabular-nums ${
                totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {totalPnl >= 0 ? '+' : ''}
              {fmtUsd(totalPnl)}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        {sorted.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 text-sm text-muted-foreground">
            <Boxes className="size-5 opacity-40" />
            <span>No open positions</span>
            <span className="text-[11px] opacity-70">
              Bot will open positions when conditions are met
            </span>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto scrollbar-thin pr-1">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs">Token</TableHead>
                  <TableHead className="text-right text-xs">Entry</TableHead>
                  <TableHead className="text-right text-xs">Now</TableHead>
                  <TableHead className="text-right text-xs">Amount</TableHead>
                  <TableHead className="text-right text-xs">Value</TableHead>
                  <TableHead className="text-right text-xs">uPnL</TableHead>
                  <TableHead className="text-right text-xs">Held</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((p) => {
                  const currentPrice = prices[p.mint] ?? p.entryPrice
                  const valueUsd = currentPrice * p.amount
                  const unrealized = valueUsd - p.costUsd
                  const unrealizedPct = p.costUsd > 0 ? (unrealized / p.costUsd) * 100 : 0
                  const up = unrealized >= 0
                  const heldMs = Date.now() - p.openedAt
                  // bulletproof unique key
                  const key = p.id || p.mint || `pos-${p.openedAt}`
                  return (
                    <TableRow key={key}>
                      <TableCell className="py-2 font-semibold">{p.symbol}</TableCell>
                      <TableCell className="py-2 text-right tabular-nums text-muted-foreground">
                        {fmtUsdFull(p.entryPrice)}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums">
                        {fmtUsdFull(currentPrice)}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums">
                        {fmtNum(p.amount, 4)}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums">
                        {fmtUsd(valueUsd)}
                      </TableCell>
                      <TableCell
                        className={`py-2 text-right tabular-nums ${
                          up ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {up ? '+' : ''}
                        {fmtUsd(unrealized)}
                        <span className="ml-1 text-[10px] opacity-70">
                          ({up ? '+' : ''}
                          {unrealizedPct.toFixed(2)}%)
                        </span>
                      </TableCell>
                      <TableCell className="py-2 text-right text-xs text-muted-foreground">
                        {fmtDuration(heldMs)}
                      </TableCell>
                    </TableRow>
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
