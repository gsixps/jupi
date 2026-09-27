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
import { Switch } from '@/components/ui/switch'
import type { useBinanceBot } from '@/hooks/use-binance'
import { ExchangeKeysPanel } from '@/components/cex/ExchangeKeysPanel'
import { verifyBinanceKeys } from '@/lib/cex'
import { fmtUsd, fmtTime, fmtPct, fmtDuration, fmtBps } from '@/lib/format'

interface BinanceTradingPanelProps {
  binance: ReturnType<typeof useBinanceBot>
}

interface NumericControl {
  key:
    | 'budgetPerTradeUsd'
    | 'maxHoldings'
    | 'minSpreadBps'
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
  { key: 'minSpreadBps', label: 'Min divergence', min: 1, max: 50, step: 1, unit: 'bps', format: (v) => fmtBps(v) },
  { key: 'stopLossBps', label: 'Stop-loss', min: 1, max: 50, step: 1, unit: 'bps', format: (v) => fmtBps(v) },
  { key: 'trailingBps', label: 'Trailing stop', min: 0, max: 50, step: 1, unit: 'bps', format: (v) => (v === 0 ? 'off' : fmtBps(v)) },
  { key: 'tickIntervalMs', label: 'Scan interval', min: 3000, max: 20000, step: 500, unit: 'ms', format: (v) => `${(v / 1000).toFixed(1)}s` },
]

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

function SideBadge({ type }: { type: 'buy' | 'sell' }) {
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

function TradeRow({ t }: { t: ReturnType<typeof useBinanceBot>['trades'][number] }) {
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
      <div className="hidden w-14 shrink-0 sm:block">
        <SideBadge type={t.type} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
        <div className="flex items-center gap-1 text-xs">
          <span className="font-medium">{t.token}</span>
          <span className="text-muted-foreground">{t.routeName}</span>
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

export function BinanceTradingPanel({ binance }: BinanceTradingPanelProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)
  const [capitalInput, setCapitalInput] = useState(String(binance.config.capitalUsd))

  const stats = binance.stats
  const equity = stats?.equityUsd ?? binance.config.capitalUsd
  const realized = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const openHoldings = stats?.openHoldings ?? 0
  const uptimeMs = stats?.uptimeMs ?? 0
  const pnlTone = realized >= 0 ? 'positive' : 'negative'
  const running = binance.enabled
  const live = binance.dataSource === 'live'

  const handleStart = () => {
    setConfirmedThisSession(true)
    binance.start()
  }

  const handleReset = () => {
    binance.resetAccount()
    setCapitalInput(String(binance.config.capitalUsd))
  }

  const handleCapitalCommit = () => {
    const v = parseFloat(capitalInput)
    if (!isFinite(v) || v <= 0) {
      setCapitalInput(String(binance.config.capitalUsd))
      return
    }
    binance.updateConfig({ capitalUsd: v })
  }

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bitcoin className="size-4 text-amber-400" />
              Binance Arb Control
            </CardTitle>
            <CardDescription className="mt-1">
              Triangle arbitrage &middot; fictional USD &middot;{' '}
              <span className="text-amber-400">
                {live ? 'live binance.com API' : 'demo engine'}
              </span>
            </CardDescription>
          </div>
          <StatusBadge status={binance.status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-0 pt-3">
        {/* Start / Stop / Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              size="lg"
              onClick={() => binance.stop()}
              className="gap-2 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-4" /> Stop Binance Bot
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="lg"
              onClick={handleStart}
              className="gap-2 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Play className="size-4" /> Start Binance Bot
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="lg"
                  className="gap-2 bg-amber-600 text-white hover:bg-amber-500"
                >
                  <Play className="size-4" /> Start Binance Bot
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <Bitcoin className="size-5 text-amber-400" />
                    Start the Binance arb bot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Buy cheap / sell expensive by crossing Binance spot pairs:
                    the bot detects when a token&apos;s direct USD price diverges
                    from its implied price through a cross leg (e.g. SOLUSDT vs
                    SOLBTC × BTCUSDT) and opens a triangle arb. If the API is
                    unreachable, a deterministic demo engine takes over.
                    Capital is fictional (
                    {fmtUsd(binance.config.capitalUsd)}) — no real funds at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="bg-amber-600 text-white hover:bg-amber-500"
                  >
                    <Play className="size-4" /> Start Binance Bot
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
            sub={`Started ${fmtUsd(binance.config.capitalUsd)}`}
          />
          <StatTile
            label="Realized P&L"
            value={fmtUsd(realized)}
            sub={`${fmtUsd(realized, 4)}`}
            tone={pnlTone}
          />
          <StatTile
            label="Cash Balance"
            value={fmtUsd(binance.cashUsd)}
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
            sub={`Max ${binance.config.maxHoldings}`}
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
              className="border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]"
            >
              buy cheap · sell expensive
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONTROLS.map((c) => {
              const val = binance.config[c.key] as number
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
                      binance.updateConfig({ [c.key]: v } as never)
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
                    : ''}
                </p>
              </div>
              <Switch
                checked
                disabled
                title="Interest compounding is always on"
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Real-mode connection */}
        <ExchangeKeysPanel
          kind="binance"
          verify={verifyBinanceKeys}
          liveEnabled={binance.config.liveTrading}
          onLiveEnabledChange={(v) => binance.updateConfig({ liveTrading: v })}
          running={running}
          onLog={binance.log}
        />

        {binance.halted && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5">
            <p className="text-xs font-semibold text-rose-300">
              Bot detenido por seguridad
            </p>
            <p className="text-[11px] text-rose-200/80">{binance.haltReason}</p>
            <p className="text-[10px] text-muted-foreground">
              No se simuló ninguna orden. Revisa el saldo y las claves, y vuelve a
              pulsar Start.
            </p>
          </div>
        )}

        {/* Open arbs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Open Arbitrages
            </h3>
            <Badge variant="outline" className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]">
              <Bitcoin className="size-3" /> {openHoldings} open
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {binance.holdings.filter((h) => h.status === 'open').length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No open arbitrages yet — start the bot to begin.
              </div>
            ) : (
              <div>
                {binance.holdings
                  .filter((h) => h.status === 'open')
                  .slice(0, 20)
                  .map((h) => {
                    const unrealized = (h.currentPrice - h.buyPrice) * (h.notionalUsd / h.buyPrice)
                    const unrealizedPct =
                      h.buyPrice > 0 ? ((h.currentPrice - h.buyPrice) / h.buyPrice) * 100 : 0
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
                            <span className="font-medium">{h.routeName}</span>
                            <span className="text-muted-foreground">
                              {h.side === 'cross_cheap' ? 'via cross leg' : 'direct buy'}
                            </span>
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            buy @ {h.buyPrice.toFixed(6)} USD → target sell @ {' '}
                            {(h.buyPrice * (1 + binance.config.minSpreadBps / 10000)).toFixed(6)} USD
                          </span>
                        </div>
                        <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                          {fmtUsd(h.notionalUsd)}
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
            <Badge variant="outline" className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-300 text-[10px]">
              <Bitcoin className="size-3" /> binance pairs
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {binance.trades.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No trades yet — start the bot to begin scanning.
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {binance.trades.slice(0, 30).map((t, i) => (
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
              onClick={() => binance.scan()}
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
            {binance.logs.length === 0 ? (
              <div className="text-muted-foreground">
                No logs yet — start the bot to begin.
              </div>
            ) : (
              binance.logs.slice(0, 50).map((l, i) => (
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
            <Zap className="size-3 text-amber-400" />
            Bot stopped — Start to scan Binance pairs &amp; arb triangles.
          </div>
        )}
      </CardContent>
    </Card>
  )
}