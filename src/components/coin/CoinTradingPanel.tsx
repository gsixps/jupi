'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Bitcoin,
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
import type { CoinBot } from '@/hooks/use-coin'
import { fmtUsd, fmtTime, fmtPct, fmtDuration, fmtBps } from '@/lib/format'

interface CoinTradingPanelProps {
  bot: CoinBot
}

interface NumericControl {
  key:
    | 'budgetPerTradeUsd'
    | 'maxHoldings'
    | 'minSpreadBps'
    | 'targetPct'
    | 'stopLossPct'
    | 'trailingPct'
    | 'tickIntervalMs'
  label: string
  min: number
  max: number
  step: number
  format?: (v: number) => string
  unit?: string
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    idle: { label: 'Idle', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300', icon: <Pause className="size-3" /> },
    scanning: { label: 'Scanning', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300', icon: <Radio className="size-3 animate-pulse" /> },
    executing: { label: 'Executing', cls: 'border-violet-500/40 bg-violet-500/10 text-violet-300', icon: <Loader2 className="size-3 animate-spin" /> },
    paused: { label: 'Paused', cls: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300', icon: <Pause className="size-3" /> },
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

function TradeRow({ t, symbol }: { t: CoinBot['trades'][number]; symbol: string }) {
  const isSell = t.type === 'sell'
  const win = t.pnlUsd >= 0
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, backgroundColor: isSell ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.10)' }}
      animate={{ opacity: 1, y: 0, backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.35 }}
      className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0"
    >
      <div className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
        {fmtTime(t.createdAt)}
      </div>
      <div className="hidden w-12 shrink-0 sm:block">
        <Badge
          variant="outline"
          className={
            isSell
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          }
        >
          {isSell ? 'SELL' : 'BUY'}
        </Badge>
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <div className="flex items-center gap-1 text-xs">
          <span className="font-medium">{symbol}</span>
          <span className="tabular-nums text-muted-foreground">{t.qty.toFixed(6)}</span>
          <span className="text-muted-foreground">@{t.pair}</span>
        </div>
        <span className="max-w-full truncate text-[10px] text-muted-foreground">
          {t.reason}
        </span>
      </div>
      <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {fmtUsd(t.priceUsd, 2)}
      </div>
      <div
        className={`flex w-28 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
          isSell ? (win ? 'text-emerald-400' : 'text-rose-400') : 'text-amber-300'
        }`}
      >
        {isSell ? (
          win ? (
            <TrendingUp className="size-3" />
          ) : (
            <TrendingDown className="size-3" />
          )
        ) : (
          <Zap className="size-3" />
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

export function CoinTradingPanel({ bot }: CoinTradingPanelProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)
  const [capitalInput, setCapitalInput] = useState(String(bot.capitalUsd))

  const stats = bot.stats
  const equity = stats?.equityUsd ?? bot.capitalUsd
  const realized = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const openHoldings = bot.holdings.filter((h) => h.status === 'open').length
  const uptimeMs = stats?.uptimeMs ?? 0
  const pnlTone = realized >= 0 ? 'positive' : 'negative'
  const running = bot.enabled
  const symbol = bot.asset.symbol
  const name = bot.asset.name
  const storedQty = stats?.storedQty ?? 0
  const storedUsd = stats?.bestStoredUsd ?? 0
  const accent = bot.asset.accent
  const btnCls =
    accent === 'indigo'
      ? 'bg-indigo-600 text-white hover:bg-indigo-500'
      : 'bg-amber-600 text-white hover:bg-amber-500'

  const handleStart = () => {
    setConfirmedThisSession(true)
    bot.start()
  }

  const handleReset = () => {
    bot.resetAccount()
    setCapitalInput(String(bot.capitalUsd))
  }

  const handleCapitalCommit = () => {
    const v = parseFloat(capitalInput)
    if (!isFinite(v) || v <= 0) {
      setCapitalInput(String(bot.capitalUsd))
      return
    }
    bot.updateConfig({ capitalUsd: v })
  }

  const controls: NumericControl[] = [
    { key: 'budgetPerTradeUsd', label: 'Budget per buy', min: 50, max: 5000, step: 50, format: (v) => fmtUsd(v) },
    { key: 'maxHoldings', label: 'Max lots', min: 1, max: 50, step: 1 },
    { key: 'minSpreadBps', label: 'Min pair spread', min: 1, max: 30, step: 1, unit: 'bps', format: (v) => fmtBps(v) },
    { key: 'targetPct', label: 'Take-profit', min: 0.2, max: 5, step: 0.1, unit: '%' },
    { key: 'stopLossPct', label: 'Stop-loss', min: 0.1, max: 2, step: 0.1, unit: '%' },
    { key: 'trailingPct', label: 'Trailing stop', min: 0, max: 2, step: 0.1, unit: '%', format: (v) => (v === 0 ? 'off' : `${v}%`) },
    { key: 'tickIntervalMs', label: 'Scan interval', min: 3000, max: 30000, step: 1000, unit: 'ms', format: (v) => `${(v / 1000).toFixed(1)}s` },
  ]

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bitcoin className={`size-4 ${accent === 'indigo' ? 'text-indigo-400' : 'text-amber-400'}`} />
              {name} Accumulation Bot
            </CardTitle>
            <CardDescription className="mt-1">
              Buy cheap / sell expensive &middot; store {symbol} &middot;{' '}
              <span className={accent === 'indigo' ? 'text-indigo-400' : 'text-amber-400'}>
                {bot.dataSource === 'live' ? 'live binance.com API' : 'demo engine'}
              </span>
            </CardDescription>
          </div>
          <StatusBadge status={bot.status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-0 pt-3">
        {/* Start / Stop / Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              size="lg"
              onClick={() => bot.stop()}
              className="gap-2 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-4" /> Stop {symbol} Bot
            </Button>
          ) : confirmedThisSession ? (
            <Button size="lg" onClick={handleStart} className={`gap-2 ${btnCls}`}>
              <Play className="size-4" /> Start {symbol} Bot
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="lg" className={`gap-2 ${btnCls}`}>
                  <Play className="size-4" /> Start {symbol} Bot
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <Bitcoin className={`size-5 ${accent === 'indigo' ? 'text-indigo-400' : 'text-amber-400'}`} />
                    Start the {name} bot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Buy {symbol} cheaply on the lowest-priced Binance pair and
                    sell on the dearest at take-profit / stop-loss / trailing
                    levels, accumulating coins across lots. If the API is
                    unreachable, a deterministic demo engine takes over.
                    Capital is fictional ({fmtUsd(bot.capitalUsd)}) — no real
                    funds at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleStart} className={btnCls}>
                    <Play className="size-4" /> Start {symbol} Bot
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
                min="100"
                step="100"
                className="h-8 w-32 text-sm"
                placeholder="10000"
              />
            </div>
          </div>
          <p className="flex-1 text-[10px] text-muted-foreground">
            Starting fictional balance in USD. Editable only while stopped —
            changing it resets the stored coins.
          </p>
        </div>

        {/* Live stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Equity" value={fmtUsd(equity)} sub={`Started ${fmtUsd(bot.capitalUsd)}`} />
          <StatTile label="Realized P&L" value={fmtUsd(realized)} sub="fictional" tone={pnlTone} />
          <StatTile label="Cash Balance" value={fmtUsd(bot.cashUsd)} sub="fictional" tone="positive" />
          <StatTile label="Win Rate" value={`${winRate.toFixed(1)}%`} sub={`${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`} tone={winRate >= 50 ? 'positive' : 'default'} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label={`Stored ${symbol}`} value={`${storedQty.toFixed(6)}`} sub={fmtUsd(storedUsd)} tone="positive" />
          <StatTile label="Open Lots" value={String(openHoldings)} sub={`Max ${bot.maxHoldings}`} />
          <StatTile label="Total Trades" value={String(stats?.totalTrades ?? 0)} sub={`${stats?.totalTrades ?? 0} sells`} />
          <StatTile label="Uptime" value={fmtDuration(uptimeMs)} sub={`${stats?.scanCount ?? 0} scans`} />
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
              className={`text-[10px] ${accent === 'indigo' ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}
            >
              buy low · sell high · accumulate
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {controls.map((c) => {
              const val = bot[c.key] as number
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
                    onValueChange={([v]) => bot.updateConfig({ [c.key]: v } as never)}
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
          </div>
        </div>

        <Separator />

        {/* Stored coins / open lots */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Stored {symbol} (open lots)
            </h3>
            <Badge
              variant="outline"
              className={`gap-1 text-[10px] ${accent === 'indigo' ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}
            >
              <Bitcoin className="size-3" /> {storedQty.toFixed(6)} {symbol}
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {openHoldings === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No coins stored yet — start the bot to accumulate {symbol}.
              </div>
            ) : (
              <div>
                {bot.holdings
                  .filter((h) => h.status === 'open')
                  .slice(0, 20)
                  .map((h) => {
                    const unrealized = (h.currentPriceUsd - h.buyPriceUsd) * h.qty
                    const unrealizedPct =
                      h.buyPriceUsd > 0 ? ((h.currentPriceUsd - h.buyPriceUsd) / h.buyPriceUsd) * 100 : 0
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
                            <span className="font-medium">{h.qty.toFixed(6)} {symbol}</span>
                            <span className="text-muted-foreground">bought @ {h.buyPair}</span>
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            target sell →
                            {(h.buyPriceUsd * (1 + bot.targetPct / 100)).toFixed(2)} USD
                          </span>
                        </div>
                        <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                          {fmtUsd(h.buyPriceUsd, 2)}
                        </div>
                        <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums sm:block">
                          {fmtUsd(h.currentPriceUsd, 2)}
                        </div>
                        <div
                          className={`flex w-28 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
                            up ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                          {`${up ? '+' : ''}${fmtUsd(unrealized, 2)}`}
                          <span className="text-[10px] font-normal opacity-70">({fmtPct(unrealizedPct)})</span>
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
            <Badge
              variant="outline"
              className={`gap-1 text-[10px] ${accent === 'indigo' ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}
            >
              <Bitcoin className="size-3" /> {symbol} pairs
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {bot.trades.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No trades yet — start the bot to begin accumulating.
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {bot.trades.slice(0, 30).map((t, i) => (
                  <TradeRow key={`${t.id}-${i}`} t={t} symbol={symbol} />
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
              onClick={() => bot.scan()}
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
            {bot.logs.length === 0 ? (
              <div className="text-muted-foreground">
                No logs yet — start the bot to begin.
              </div>
            ) : (
              bot.logs.slice(0, 50).map((l, i) => (
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
            <Zap className={`size-3 ${accent === 'indigo' ? 'text-indigo-400' : 'text-amber-400'}`} />
            Bot stopped — Start to scan {symbol} pairs &amp; accumulate coins.
          </div>
        )}
      </CardContent>
    </Card>
  )
}