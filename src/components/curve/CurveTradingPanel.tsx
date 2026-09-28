'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowRight,
  ChartNoAxesCombined,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Square,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Switch } from '@/components/ui/switch'
import type { useCurveBot } from '@/hooks/use-curve'
import { fmtUsd, fmtTime, fmtPct, fmtDuration, fmtBps } from '@/lib/format'

interface CurveTradingPanelProps {
  curve: ReturnType<typeof useCurveBot>
}

interface NumericControl {
  key:
    | 'budgetPerTradeUsd'
    | 'maxHoldings'
    | 'globalTargetBps'
    | 'stopLossBps'
    | 'trailingBps'
    | 'tickIntervalMs'
  label: string
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
}

const CONTROLS: NumericControl[] = [
  { key: 'budgetPerTradeUsd', label: 'Budget per arb', min: 1, max: 100000, step: 5, format: (v) => fmtUsd(v) },
  { key: 'maxHoldings', label: 'Max open arbs', min: 1, max: 20, step: 1 },
  { key: 'globalTargetBps', label: 'Min spread', min: 5, max: 200, step: 5, unit: 'bps', format: (v) => fmtBps(v) },
  { key: 'stopLossBps', label: 'Stop-loss', min: 1, max: 100, step: 1, unit: 'bps', format: (v) => fmtBps(v) },
  { key: 'trailingBps', label: 'Trailing stop', min: 0, max: 100, step: 1, unit: 'bps', format: (v) => (v === 0 ? 'off' : fmtBps(v)) },
  { key: 'tickIntervalMs', label: 'Scan interval', min: 3000, max: 20000, step: 500, unit: 'ms', format: (v) => `${(v / 1000).toFixed(1)}s` },
]

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    idle: { label: 'Idle', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300', icon: <Pause className="size-3" /> },
    scanning: { label: 'Scanning', cls: 'border-blue-500/40 bg-blue-500/10 text-blue-300', icon: <Radio className="size-3 animate-pulse" /> },
    executing: { label: 'Executing', cls: 'border-violet-500/40 bg-violet-500/10 text-violet-300', icon: <Loader2 className="size-3 animate-spin" /> },
    paused: { label: 'Paused', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300', icon: <Pause className="size-3" /> },
  }
  const cfg = map[status] ?? map.idle
  return (
    <Badge variant="outline" className={`gap-1 ${cfg.cls}`}>
      {cfg.icon}
      {cfg.label}
    </Badge>
  )
}

function StatTile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'positive' | 'negative'
}) {
  const toneCls =
    tone === 'positive'
      ? 'text-emerald-400'
      : tone === 'negative'
        ? 'text-rose-400'
        : 'text-foreground'
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`text-sm font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub && (
        <div className="text-[10px] text-muted-foreground tabular-nums">{sub}</div>
      )}
    </div>
  )
}

function SideBadge({ type }: { type: 'buy' | 'sell' | 'arb' }) {
  if (type === 'arb') {
    return (
      <Badge
        variant="outline"
        className="border-blue-500/40 bg-blue-500/10 text-blue-300"
      >
        ARB
      </Badge>
    )
  }
  if (type === 'buy') {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      >
        BUY
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="border-rose-500/40 bg-rose-500/10 text-rose-300"
    >
      SELL
    </Badge>
  )
}

function TradeRow({ t }: { t: ReturnType<typeof useCurveBot>['trades'][number] }) {
  const isSell = t.type === 'sell'
  const win = t.pnlUsd >= 0
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, backgroundColor: isSell ? 'rgba(16,185,129,0.10)' : 'rgba(59,130,246,0.10)' }}
      animate={{ opacity: 1, y: 0, backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.35 }}
      className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0"
    >
      <div className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
        {fmtTime(t.createdAt)}
      </div>
      <div className="hidden w-14 shrink-0 sm:block">
        <SideBadge type={t.type} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <div className="flex items-center gap-1 text-xs">
          <span className="font-medium">{t.coinSymbol}</span>
          <span className="text-muted-foreground">{arbLabel(t)}</span>
        </div>
        <span className="max-w-full truncate text-[10px] text-muted-foreground">
          {t.reason}
        </span>
      </div>
      <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {fmtUsd(t.priceUsd, 6)}
      </div>
      <div
        className={`flex w-28 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
          isSell ? (win ? 'text-emerald-400' : 'text-rose-400') : 'text-blue-300'
        }`}
      >
        {isSell ? (
          win ? (
            <TrendingUp className="size-3" />
          ) : (
            <TrendingDown className="size-3" />
          )
        ) : (
          <ArrowRight className="size-3" />
        )}
        {isSell
          ? `${win ? '+' : ''}${fmtUsd(t.pnlUsd, 2)}`
          : `${t.profitBps >= 0 ? '+' : ''}${fmtBps(t.profitBps)}`}
      </div>
      {isSell && (
        <Badge
          variant="outline"
          className={`gap-1 ${win ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300'}`}
        >
          {win ? 'profit' : 'loss'}
        </Badge>
      )}
    </motion.div>
  )
}

function arbLabel(t: ReturnType<typeof useCurveBot>['trades'][number]): string {
  return `@ ${t.priceUsd.toFixed(6)}`
}

export function CurveTradingPanel({ curve }: CurveTradingPanelProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)
  const [capitalInput, setCapitalInput] = useState(String(curve.config.capitalUsd))

  const stats = curve.stats
  const equity = stats?.equityUsd ?? curve.config.capitalUsd
  const realized = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const openHoldings = stats?.openHoldings ?? 0
  const uptimeMs = stats?.uptimeMs ?? 0
  const pnlTone = realized >= 0 ? 'positive' : 'negative'
  const running = curve.enabled
  const live = curve.dataSource === 'live'

  const handleStart = () => {
    setConfirmedThisSession(true)
    curve.start()
  }

  const handleReset = () => {
    curve.resetAccount()
    setCapitalInput(String(curve.config.capitalUsd))
  }

  const handleCapitalCommit = () => {
    const v = parseFloat(capitalInput)
    if (!isFinite(v) || v <= 0) {
      setCapitalInput(String(curve.config.capitalUsd))
      return
    }
    curve.updateConfig({ capitalUsd: v })
  }

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ChartNoAxesCombined className="size-4 text-blue-400" />
              Curve Arb Control
            </CardTitle>
            <CardDescription className="mt-1">
              Stablecoin arbitrage &middot; fictional USD &middot;{' '}
              <span className="text-blue-400">
                {live ? 'live curve.finance API' : 'demo engine'}
              </span>
            </CardDescription>
          </div>
          <StatusBadge status={curve.status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-0 pt-3">
        {/* Start / Stop / Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              size="lg"
              onClick={() => curve.stop()}
              className="gap-2 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-4" /> Stop Curve Bot
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="lg"
              onClick={handleStart}
              className="gap-2 bg-blue-600 text-white hover:bg-blue-500"
            >
              <Play className="size-4" /> Start Curve Bot
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="lg"
                  className="gap-2 bg-blue-600 text-white hover:bg-blue-500"
                >
                  <Play className="size-4" /> Start Curve Bot
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <ChartNoAxesCombined className="size-5 text-blue-400" />
                    Start the Curve arb bot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Buy cheap / sell expensive across Curve stablecoin pools
                    using live implied USD prices from curve.finance. If the API
                    is unreachable, a deterministic demo engine takes over.
                    Capital is fictional ({fmtUsd(curve.config.capitalUsd)}), so
                    no real funds are at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="bg-blue-600 text-white hover:bg-blue-500"
                  >
                    <Play className="size-4" /> Start Curve Bot
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Button
            onClick={handleReset}
            variant="outline"
            size="sm"
            disabled={running}
            className="gap-1.5 h-9 border-zinc-500/40 bg-zinc-500/10 text-zinc-200 hover:bg-zinc-500/20"
            title="Reset balance to capital, clear holdings & trades"
          >
            <RotateCcw className="size-3.5" /> Reset Account
          </Button>
        </div>

        {/* Capital input (only editable when stopped) */}
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border/60 p-2.5">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Fictional capital (USD)
            </Label>
            <div className="relative">
              <Input
                value={capitalInput}
                onChange={(e) => setCapitalInput(e.target.value)}
                onBlur={handleCapitalCommit}
                disabled={running}
                type="number"
                min="0.01"
                step="0.01"
                className="h-8 w-32 text-sm"
                placeholder="10000"
              />
            </div>
          </div>
          <p className="flex-1 text-[10px] text-muted-foreground">
            Starting fictional balance in USD. Editable only while stopped —
            changing it resets the cash balance.
          </p>
        </div>

        {/* Live stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Equity"
            value={fmtUsd(equity)}
            sub={`Started ${fmtUsd(curve.config.capitalUsd)}`}
          />
          <StatTile
            label="Realized P&L"
            value={fmtUsd(realized)}
            sub={`${fmtUsd(realized, 4)}`}
            tone={pnlTone}
          />
          <StatTile
            label="Cash Balance"
            value={fmtUsd(curve.cashUsd)}
            sub="fictional"
            tone="positive"
          />
          <StatTile
            label="Win Rate"
            value={`${winRate.toFixed(1)}%`}
            sub={`${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`}
            tone={winRate >= 50 ? 'positive' : 'default'}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Open Arbs"
            value={String(openHoldings)}
            sub={`Max ${curve.config.maxHoldings}`}
          />
          <StatTile
            label="Invested"
            value={fmtUsd(stats?.investedUsd ?? 0)}
            sub="fictional"
          />
          <StatTile
            label="Arbs Detected"
            value={String(stats?.arbsDetected ?? 0)}
            sub="this session"
          />
          <StatTile
            label="Uptime"
            value={fmtDuration(uptimeMs)}
            sub={`${stats?.scanCount ?? 0} scans`}
          />
        </div>

        <Separator />

        {/* Config quick controls */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Strategy Config
            </h3>
            <Badge
              variant="outline"
              className="border-blue-500/40 bg-blue-500/10 text-blue-300 text-[10px]"
            >
              buy cheap · sell expensive
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONTROLS.map((c) => {
              const val = curve.config[c.key] as number
              return (
                <div key={c.key} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">{c.label}</Label>
                    <Badge variant="outline" className="tabular-nums text-[10px]">
                      {c.format
                        ? c.format(val)
                        : `${val}${c.unit ? ` ${c.unit}` : ''}`}
                    </Badge>
                  </div>
                  <Slider
                    value={[val]}
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    onValueChange={([v]) =>
                      curve.updateConfig({ [c.key]: v } as never)
                    }
                    disabled={running}
                  />
                  {running && (
                    <p className="text-[10px] text-muted-foreground">
                      Stop the bot to adjust.
                    </p>
                  )}
                </div>
              )
            })}
            {/* Compound interest toggle */}
            <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border/60 p-2.5 sm:col-span-2">
              <div className="space-y-0.5">
                <Label className="text-xs">Compound interest</Label>
                <p className="text-[10px] text-muted-foreground">
                  Reinvest profits: per-trade budget scales with equity
                  {stats?.compound && stats.compoundFactor > 0
                    ? ` (×${stats.compoundFactor.toFixed(2)})`
                    : ' (fixed budget)'}
                </p>
              </div>
              <Switch
                checked={curve.config.compound}
                onCheckedChange={(v) => curve.updateConfig({ compound: v })}
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Open arbs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Open Arbitrages
            </h3>
            <Badge variant="outline" className="gap-1 border-blue-500/40 bg-blue-500/10 text-blue-300 text-[10px]">
              <ChartNoAxesCombined className="size-3" /> {openHoldings} open
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {curve.holdings.filter((h) => h.status === 'open').length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No open arbitrages yet — start the bot to begin.
              </div>
            ) : (
              <div>
                {curve.holdings
                  .filter((h) => h.status === 'open')
                  .slice(0, 20)
                  .map((h) => {
                    const unrealized = h.currentPrice - h.buyPrice
                    const unrealizedPct =
                      h.buyPrice > 0 ? (unrealized / h.buyPrice) * 100 : 0
                    const up = unrealized >= 0
                    const heldMs = Date.now() - h.boughtAt
                    return (
                      <motion.div
                        key={h.id}
                        layout
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3 }}
                        className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0"
                      >
                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex items-center gap-1 text-xs">
                            <span className="font-medium">{h.coinSymbol}</span>
                            <span className="text-muted-foreground">buy @ {h.buyPool}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            sell target → {h.buyPrice.toFixed(6)} × 1 + {curve.config.globalTargetBps}bps
                          </span>
                        </div>
                        <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                          {fmtUsd(h.buyPrice, 6)}
                        </div>
                        <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums sm:block">
                          {fmtUsd(h.currentPrice, 6)}
                        </div>
                        <div
                          className={`flex w-28 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
                            up ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                          {`${up ? '+' : ''}${fmtUsd(unrealized, 2)}`}
                          <span className="text-[10px] font-normal opacity-70">({fmtPct(unrealizedPct, 3)})</span>
                        </div>
                        <div className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">
                          {fmtDuration(heldMs)}
                        </div>
                      </motion.div>
                    )
                  })}
              </div>
            )}
          </div>
        </div>

        <Separator />

        {/* Recent trades */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent Trades
            </h3>
            <Badge variant="outline" className="gap-1 border-blue-500/40 bg-blue-500/10 text-blue-300 text-[10px]">
              <ChartNoAxesCombined className="size-3" /> curve pools
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {curve.trades.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No trades yet — start the bot to begin scanning.
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {curve.trades.slice(0, 30).map((t, i) => (
                  <TradeRow key={`${t.id}-${i}`} t={t} />
                ))}
              </AnimatePresence>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Engine Log
            </h3>
            <Button
              onClick={() => curve.scan()}
              variant="outline"
              size="sm"
              disabled={running}
              className="gap-1.5 h-7 text-[11px]"
              title="Run a single scan now (manual)"
            >
              <RefreshCw className="size-3" /> Scan now
            </Button>
          </div>
          <div className="max-h-40 overflow-y-auto scrollbar-thin rounded-md border border-border/60 bg-black/40 p-2 font-mono text-[10px] leading-relaxed">
            {curve.logs.length === 0 ? (
              <div className="text-muted-foreground">
                No logs yet — start the bot to begin.
              </div>
            ) : (
              curve.logs.slice(0, 50).map((l, i) => (
                <div
                  key={`${l.time}-${i}`}
                  className={
                    l.level === 'error'
                      ? 'text-rose-400'
                      : l.level === 'warn'
                        ? 'text-amber-300'
                        : l.level === 'trade'
                          ? 'text-emerald-300'
                          : 'text-muted-foreground'
                  }
                >
                  <span className="opacity-50">{fmtTime(l.time)}</span> {l.msg}
                </div>
              ))
            )}
          </div>
        </div>

        {!running && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Zap className="size-3 text-blue-400" />
            Bot stopped — Start to scan Curve pools &amp; arb stablecoins.
          </div>
        )}
      </CardContent>
    </Card>
  )
}