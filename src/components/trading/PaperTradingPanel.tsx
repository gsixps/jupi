'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Crosshair,
  FlaskConical,
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
import { Switch } from '@/components/ui/switch'
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
import type { usePaperTrading } from '@/hooks/use-paper-trading'
import { fmtUsd, fmtPct, fmtNum, fmtTime, fmtDuration } from '@/lib/format'

interface PaperTradingPanelProps {
  paper: ReturnType<typeof usePaperTrading>
}

interface NumericControl {
  key:
    | 'tradeSizePct'
    | 'buyThreshold'
    | 'sellThreshold'
    | 'stopLossPct'
    | 'arbMinProfitBps'
    | 'slippageBps'
    | 'scanIntervalMs'
  label: string
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
}

const CONTROLS: NumericControl[] = [
  { key: 'tradeSizePct', label: 'Trade Size (compound)', min: 5, max: 50, step: 1, unit: '%' },
  { key: 'buyThreshold', label: 'Buy Threshold', min: 0.1, max: 5, step: 0.1, unit: '%' },
  { key: 'sellThreshold', label: 'Sell Threshold', min: 0.1, max: 5, step: 0.1, unit: '%' },
  { key: 'stopLossPct', label: 'Stop Loss', min: 1, max: 10, step: 0.5, unit: '%' },
  { key: 'arbMinProfitBps', label: 'Arb Min Profit', min: 5, max: 100, step: 5, unit: 'bps' },
  { key: 'slippageBps', label: 'Slippage', min: 10, max: 500, step: 5, unit: 'bps' },
  { key: 'scanIntervalMs', label: 'Scan Interval', min: 3000, max: 15000, step: 500, unit: 'ms', format: (v) => `${(v / 1000).toFixed(1)}s` },
]

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    idle: { label: 'Idle', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300', icon: <Pause className="size-3" /> },
    scanning: { label: 'Scanning', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300', icon: <Radio className="size-3 animate-pulse" /> },
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
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {sub}
        </div>
      )}
    </div>
  )
}

type PaperTrade = ReturnType<typeof usePaperTrading>['trades'][number]

function StrategyBadge({ strategy }: { strategy: PaperTrade['strategy'] }) {
  if (strategy === 'arbitrage') {
    return (
      <Badge
        variant="outline"
        className="border-violet-500/40 bg-violet-500/10 text-violet-300"
      >
        <Crosshair className="size-3" /> Arb
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 text-amber-300"
    >
      <FlaskConical className="size-3" /> MR
    </Badge>
  )
}

function SideBadge({ side }: { side: PaperTrade['side'] }) {
  if (side === 'BUY') {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      >
        BUY
      </Badge>
    )
  }
  if (side === 'SELL') {
    return (
      <Badge
        variant="outline"
        className="border-rose-500/40 bg-rose-500/10 text-rose-300"
      >
        SELL
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="border-violet-500/40 bg-violet-500/10 text-violet-300"
    >
      ARB
    </Badge>
  )
}

function PaperTradeRow({ trade }: { trade: PaperTrade }) {
  const win = trade.win
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, backgroundColor: 'rgba(16,185,129,0.10)' }}
      animate={{ opacity: 1, y: 0, backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.35 }}
      className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0"
    >
      <div className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
        {fmtTime(trade.closedAt ?? trade.openedAt)}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <StrategyBadge strategy={trade.strategy} />
      </div>
      <div className="hidden w-14 shrink-0 sm:block">
        <SideBadge side={trade.side} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1 text-xs">
        <span className="font-medium">{trade.inputSymbol}</span>
        <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
        <span className="font-medium">{trade.outputSymbol}</span>
      </div>
      <div className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {fmtNum(trade.inputAmount, 4)} {trade.inputSymbol}
      </div>
      <div
        className={`flex w-24 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
          win ? 'text-emerald-400' : 'text-rose-400'
        }`}
      >
        {win ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
        {fmtUsd(trade.pnl)}
        <span className="text-[10px] font-normal opacity-70">
          ({fmtPct(trade.pnlPct)})
        </span>
      </div>
      {/* "real quote" badge — these are at REAL Jupiter prices */}
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
        title="Executed at the REAL Jupiter swap-quote rate (no on-chain swap; capital is fictional)"
      >
        <CheckCircle2 className="size-3" /> real quote
      </Badge>
    </motion.div>
  )
}

export function PaperTradingPanel({ paper }: PaperTradingPanelProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)
  const [capitalInput, setCapitalInput] = useState(String(paper.config.capital))

  const stats = paper.stats
  const totalPnl = stats?.totalPnl ?? 0
  const totalPnlPct = stats?.totalPnlPct ?? 0
  const winRate = stats?.winRate ?? 0
  const equity = stats?.equity ?? paper.config.capital
  const openPositions = stats?.openPositions ?? 0
  const uptimeMs = stats?.uptimeMs ?? 0
  const pnlTone = totalPnl >= 0 ? 'positive' : 'negative'

  const running = paper.enabled
  // Next-trade size = tradeSizePct% of the CURRENT (fictional) USDC balance when
  // compounding is on, or of the original capital when it is off.
  const compoundOn = paper.config.compoundInterest
  const compoundBase = compoundOn ? paper.balance : paper.config.capital
  const nextTradeUsd = compoundBase * (paper.config.tradeSizePct / 100)

  const handleStart = () => {
    setConfirmedThisSession(true)
    paper.start()
  }

  const handleReset = () => {
    paper.resetAccount()
    setCapitalInput(String(paper.config.capital))
  }

  const handleCapitalCommit = () => {
    const v = parseFloat(capitalInput)
    if (!isFinite(v) || v <= 0) {
      setCapitalInput(String(paper.config.capital))
      return
    }
    paper.updateConfig({ capital: v })
  }

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="size-4 text-emerald-400" />
              Demo Control
            </CardTitle>
            <CardDescription className="mt-1">
              Real Jupiter market data &middot; fictional capital &middot;{' '}
              <span className="text-emerald-400">real P&amp;L</span>
            </CardDescription>
          </div>
          <StatusBadge status={paper.status} />
        </div>
      </CardHeader>

      <CardContent className="p-0 pt-3 space-y-4">
        {/* Start / Stop / Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              size="lg"
              onClick={() => paper.stop()}
              className="gap-2 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-4" /> Stop Paper Bot
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="lg"
              onClick={handleStart}
              className="gap-2 bg-emerald-600 text-white hover:bg-emerald-500"
            >
              <Play className="size-4" /> Start Paper Bot
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="lg"
                  className="gap-2 bg-emerald-600 text-white hover:bg-emerald-500"
                >
                  <Play className="size-4" /> Start Paper Bot
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <FlaskConical className="size-5 text-emerald-400" />
                    Start paper trading?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot will run entirely in your browser, fetching REAL
                    prices and REAL swap quotes from Jupiter. Capital is
                    fictional (${paper.config.capital.toFixed(2)}) so{' '}
                    <strong>no real funds are at risk</strong>. Every P&amp;L
                    figure reflects what would have happened at the real market
                    rate. Stop the bot anytime.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="bg-emerald-600 text-white hover:bg-emerald-500"
                  >
                    <Play className="size-4" /> Start paper bot
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
            title="Reset balance to capital, clear positions & trades"
          >
            <RotateCcw className="size-3.5" /> Reset Account
          </Button>
        </div>

        {/* Capital input (only editable when stopped) */}
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border/60 p-2.5">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Fictional capital (USDC)
            </Label>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                $
              </span>
              <Input
                value={capitalInput}
                onChange={(e) => setCapitalInput(e.target.value)}
                onBlur={handleCapitalCommit}
                disabled={running}
                type="number"
                min="1"
                step="1"
                className="pl-5 h-8 w-32 text-sm"
                placeholder="1000"
              />
            </div>
          </div>
          <p className="flex-1 text-[10px] text-muted-foreground">
            Starting fictional balance. Bot starts with this USDC &amp; compounds
            from here. Editable only while stopped (changing it resets the
            balance to the new value).
          </p>
        </div>

        {/* Live stats grid (2 rows × 4 tiles) */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Equity"
            value={fmtUsd(equity)}
            sub={`Started ${fmtUsd(paper.config.capital)}`}
          />
          <StatTile
            label="Growth"
            value={fmtPct(totalPnlPct)}
            sub={`${fmtUsd(totalPnl)} profit`}
            tone={pnlTone}
          />
          <StatTile
            label="Next Trade Size"
            value={fmtUsd(nextTradeUsd)}
            sub={`${paper.config.tradeSizePct}% of $${(compoundOn ? paper.balance : paper.config.capital).toFixed(2)}${compoundOn ? ' (crece)' : ' (fijo)'}`}
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
            label="Open Positions"
            value={String(openPositions)}
            sub={`Max ${paper.config.maxPositions}`}
          />
          <StatTile
            label="USDC Balance"
            value={fmtUsd(paper.balance)}
            sub="fictional"
            tone="positive"
          />
          <StatTile
            label="Total Trades"
            value={String(stats?.totalTrades ?? 0)}
            sub={`${stats?.arbTradesExecuted ?? 0} arb`}
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
              className="text-[10px] border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            >
              ↗ compound interest
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONTROLS.map((c) => {
              const val = paper.config[c.key] as number
              const maxTradeUsd =
                c.key === 'tradeSizePct'
                  ? (val / 100) * compoundBase
                  : 0
              return (
                <div key={c.key} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">{c.label}</Label>
                    <Badge
                      variant="outline"
                      className="tabular-nums text-[10px]"
                    >
                      {c.format
                        ? c.format(val)
                        : c.key === 'tradeSizePct'
                          ? `${val}${c.unit} ≈ ${fmtUsd(maxTradeUsd)}`
                          : `${val}${c.unit ? ` ${c.unit}` : ''}`}
                    </Badge>
                  </div>
                  <Slider
                    value={[val]}
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    onValueChange={([v]) =>
                      paper.updateConfig({ [c.key]: v } as never)
                    }
                    disabled={running}
                  />
                  {c.key === 'tradeSizePct' && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-border/60 px-2 py-1.5">
                        <div className="space-y-0.5">
                          <Label className="text-[11px]">Compound interest</Label>
                          <p className="text-[10px] text-muted-foreground">
                            {compoundOn
                              ? '↗ Reinvests profits: bigger trades as equity grows.'
                              : '→ Fixed size from the starting capital.'}
                          </p>
                        </div>
                        <Switch
                          checked={compoundOn}
                          onCheckedChange={(v) =>
                            paper.updateConfig({ compoundInterest: v })
                          }
                        />
                      </div>
                    </div>
                  )}
                  {running && c.key !== 'tradeSizePct' && (
                    <p className="text-[10px] text-muted-foreground">
                      Stop the bot to adjust.
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <Separator />

        {/* Recent trades (paper-specific row with "real quote" badge) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent Paper Trades
            </h3>
            <Badge variant="outline" className="text-[10px] gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
              <CheckCircle2 className="size-3" /> real Jupiter quotes
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {paper.trades.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No paper trades yet — start the bot to begin scanning.
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {paper.trades.slice(0, 30).map((t, i) => (
                  <PaperTradeRow key={t.id || `pt-${i}`} trade={t} />
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
              onClick={() => paper.scan()}
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
            {paper.logs.length === 0 ? (
              <div className="text-muted-foreground">
                No logs yet — start the bot to begin.
              </div>
            ) : (
              paper.logs.slice(0, 50).map((l, i) => (
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

        {/* small mode indicator */}
        {!running && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Zap className="size-3 text-emerald-400" />
            Bot stopped — Start to fetch real Jupiter prices &amp; trade.
          </div>
        )}
      </CardContent>
    </Card>
  )
}
