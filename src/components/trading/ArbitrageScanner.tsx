'use client'

import { motion } from 'framer-motion'
import { ArrowRight, Crosshair, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useTradingStore } from '@/lib/store'
import { fmtUsd, fmtBps, fmtTime } from '@/lib/format'
import type { ArbitrageOpportunity } from '@/lib/trading-types'

function ArbRow({ a, index }: { a: ArbitrageOpportunity; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.02, 0.25) }}
      className="border-b border-border/60 px-3 py-2.5 last:border-0"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs">
          {a.symbols?.length ? (
            a.symbols.map((sym, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="font-medium">{sym}</span>
                {i < a.symbols.length - 1 && (
                  <ArrowRight className="size-3 text-muted-foreground" />
                )}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">cycle</span>
          )}
        </div>
        <Badge
          variant="outline"
          className={
            a.executed
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
          }
        >
          {a.executed ? <Zap className="size-3" /> : <Crosshair className="size-3" />}
          {a.executed ? 'Executed' : 'Passed'}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">{fmtTime(a.detectedAt)}</span>
          <span className="font-medium text-violet-300">{fmtBps(a.profitBps)}</span>
        </div>
        <div
          className={`text-xs font-semibold tabular-nums ${
            a.profitUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
          }`}
        >
          {fmtUsd(a.profitUsd)}
        </div>
      </div>
    </motion.div>
  )
}

export function ArbitrageScanner() {
  const arbitrage = useTradingStore((s) => s.arbitrage)
  const stats = useTradingStore((s) => s.stats)
  const detected = stats?.arbOpportunitiesDetected ?? arbitrage.length
  const executed = stats?.arbTradesExecuted ?? arbitrage.filter((a) => a.executed).length

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Crosshair className="size-4 text-violet-400" />
              Arbitrage Scanner
            </CardTitle>
            <CardDescription className="mt-1">
              Detected triangular arb opportunities
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-xs text-muted-foreground">
              {executed} / {detected} executed
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3">
        <div className="max-h-80 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
          {arbitrage.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Crosshair className="size-5 opacity-40" />
              <span>Scanning for opportunities…</span>
              {stats && stats.lastScanAt && (
                <span className="text-[11px] opacity-70">
                  Last scan {fmtTime(stats.lastScanAt)} · {stats.scanCount} total
                </span>
              )}
            </div>
          ) : (
            arbitrage.slice(0, 50).map((a, i) => (
              <ArbRow key={a.id || `${a.detectedAt}-${i}`} a={a} index={i} />
            ))
          )}
        </div>
        {arbitrage.length === 0 && stats && stats.lastScanAt === null && (
          <Skeleton className="mt-3 h-8 w-full" />
        )}
      </CardContent>
    </Card>
  )
}
