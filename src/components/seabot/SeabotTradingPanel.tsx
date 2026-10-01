'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowRight,
  Boxes,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Ship,
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
import type { useSeabot } from '@/hooks/use-seabot'
import { fmtEth, fmtEthUsd, fmtNum, fmtTime, fmtPct, fmtDuration } from '@/lib/format'
import { ETH_USD_PRICE } from '@/lib/seabot'

interface SeabotTradingPanelProps {
  seabot: ReturnType<typeof useSeabot>
}

interface NumericControl {
  key:
    | 'budgetPerTradeEth'
    | 'maxHoldings'
    | 'globalTargetPct'
    | 'globalStopLossPct'
    | 'trailingStopPct'
    | 'tickIntervalMs'
  label: string
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
}

const CONTROLS: NumericControl[] = [
  { key: 'budgetPerTradeEth', label: 'Budget per buy', min: 0.0001, max: 50, step: 0.0005, format: (v) => `${v.toFixed(3)} ETH ≈ ${fmtEthUsd(v, ETH_USD_PRICE)}` },
  { key: 'maxHoldings', label: 'Max holdings', min: 1, max: 30, step: 1 },
  { key: 'globalTargetPct', label: 'Take-profit', min: 1, max: 25, step: 1, unit: '%' },
  { key: 'globalStopLossPct', label: 'Stop-loss', min: 1, max: 25, step: 1, unit: '%' },
  { key: 'trailingStopPct', label: 'Trailing stop', min: 0, max: 25, step: 1, unit: '%', format: (v) => (v === 0 ? 'off' : `${v}%`) },
  { key: 'tickIntervalMs', label: 'Scan interval', min: 3000, max: 20000, step: 500, unit: 'ms', format: (v) => `${(v / 1000).toFixed(1)}s` },
]

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    idle: { label: 'Idle', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300', icon: <Pause className="size-3" /> },
    scanning: { label: 'Scanning', cls: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300', icon: <Radio className="size-3 animate-pulse" /> },
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

function TradeRow({
  t,
}: {
  t: ReturnType<typeof useSeabot>['trades'][number]
}) {
  const isSell = t.type === 'sell'
  const win = t.pnlEth >= 0
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, backgroundColor: isSell ? 'rgba(16,185,129,0.10)' : 'rgba(34,211,238,0.10)' }}
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
      <div className="flex min-w-0 flex-1 items-center gap-1 text-xs">
        <span className="font-medium">{t.collectionName}</span>
        <span className="text-muted-foreground">{t.tokenId}</span>
      </div>
      <div className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {fmtEth(t.priceEth)}
      </div>
      <div
        className={`flex w-24 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
          isSell ? (win ? 'text-emerald-400' : 'text-rose-400') : 'text-cyan-300'
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
        {isSell ? `${win ? '+' : ''}${fmtEth(t.pnlEth)}` : '—'}
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

export function SeabotTradingPanel({ seabot }: SeabotTradingPanelProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)
  const [capitalInput, setCapitalInput] = useState(String(seabot.config.capitalEth))

  const stats = seabot.stats
  const equity = stats?.equityEth ?? seabot.config.capitalEth
  const realized = stats?.realizedPnlEth ?? 0
  const winRate = stats?.winRate ?? 0
  const openHoldings = stats?.openHoldings ?? 0
  const uptimeMs = stats?.uptimeMs ?? 0
  const pnlTone = realized >= 0 ? 'positive' : 'negative'
  const running = seabot.enabled

  const handleStart = () => {
    setConfirmedThisSession(true)
    seabot.start()
  }

  const handleReset = () => {
    seabot.resetAccount()
    setCapitalInput(String(seabot.config.capitalEth))
  }

  const handleCapitalCommit = () => {
    const v = parseFloat(capitalInput)
    if (!isFinite(v) || v <= 0) {
      setCapitalInput(String(seabot.config.capitalEth))
      return
    }
    seabot.updateConfig({ capitalEth: v })
  }

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Ship className="size-4 text-cyan-400" />
              SeaBot Control
            </CardTitle>
            <CardDescription className="mt-1">
              NFT buy-low / sell-high &middot; fictional ETH &middot;{' '}
              <span className="text-cyan-400">{seabot.config.dataMode === 'live' ? 'floors reales de OpenSea' : 'SIMULACIÓN (floors sintéticos)'}</span>
            </CardDescription>
          </div>
          <StatusBadge status={seabot.status} />
        </div>
      </CardHeader>

      <CardContent className="p-0 pt-3 space-y-4">
        {/* Start / Stop / Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              size="lg"
              onClick={() => seabot.stop()}
              className="gap-2 bg-amber-600 text-white hover:bg-amber-500"
            >
              <Square className="size-4" /> Stop SeaBot
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="lg"
              onClick={handleStart}
              className="gap-2 bg-cyan-600 text-white hover:bg-cyan-500"
            >
              <Play className="size-4" /> Start SeaBot
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="lg"
                  className="gap-2 bg-cyan-600 text-white hover:bg-cyan-500"
                >
                  <Play className="size-4" /> Start SeaBot
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <Ship className="size-5 text-cyan-400" />
                    Start the SeaBot?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot trades NFTs in your browser using the deterministic
                    floor-price engine — buys cheap collections and sells at
                    take-profit / stop-loss / trailing-stop levels. Capital is
                    fictional ({fmtEth(seabot.config.capitalEth)}), so no real
                    funds are at risk.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleStart}
                    className="bg-cyan-600 text-white hover:bg-cyan-500"
                  >
                    <Play className="size-4" /> Start SeaBot
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
              Fictional capital (ETH)
            </Label>
            <div className="relative">
              <Input
                value={capitalInput}
                onChange={(e) => setCapitalInput(e.target.value)}
                onBlur={handleCapitalCommit}
                disabled={running}
                type="number"
                min="0.0001"
                step="0.0001"
                className="h-8 w-32 text-sm"
                placeholder="10"
              />
            </div>
          </div>
          <p className="flex-1 text-[10px] text-muted-foreground">
            Starting fictional balance in ETH (≈ $3,247 / ETH). Editable only
            while stopped — changing it resets the cash balance.
          </p>
        </div>

        {/* Live stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Equity"
            value={fmtEth(equity)}
            sub={`Started ${fmtEth(seabot.config.capitalEth)}`}
          />
          <StatTile
            label="Realized P&L"
            value={fmtEth(realized)}
            sub={`${fmtEthUsd(realized, seabot.ethUsd)}`}
            tone={pnlTone}
          />
          <StatTile
            label="Cash Balance"
            value={fmtEth(seabot.cashEth)}
            sub={`${fmtEthUsd(seabot.cashEth, seabot.ethUsd)}`}
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
            label="Open Holdings"
            value={String(openHoldings)}
            sub={`Max ${seabot.config.maxHoldings}`}
          />
          <StatTile
            label="Invested"
            value={fmtEth(stats?.investedEth ?? 0)}
            sub="fictional"
          />
          <StatTile
            label="Total Trades"
            value={String(stats?.totalTrades ?? 0)}
            sub={`${stats?.totalTrades ?? 0} sells`}
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
              className="text-[10px] border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
            >
              buy low · sell high
            </Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONTROLS.map((c) => {
              const val = seabot.config[c.key] as number
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
                      seabot.updateConfig({ [c.key]: v } as never)
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
                  {seabot.stats?.compound && seabot.stats.compoundFactor > 0
                    ? ` (×${seabot.stats.compoundFactor.toFixed(2)})`
                    : ' (fixed budget)'}
                </p>
              </div>
              <Switch
                checked={seabot.config.compound}
                onCheckedChange={(v) => seabot.updateConfig({ compound: v })}
              />
            </div>
          </div>
        </div>

        <Separator />

        {/* Holdings */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Open Holdings
            </h3>
            <Badge variant="outline" className="text-[10px] gap-1 border-cyan-500/40 bg-cyan-500/10 text-cyan-300">
              <Boxes className="size-3" /> {openHoldings} open
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {seabot.holdings.filter((h) => h.status === 'open').length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No open holdings yet — start the bot to begin.
              </div>
            ) : (
              <div>
                {seabot.holdings
                  .filter((h) => h.status === 'open')
                  .slice(0, 20)
                  .map((h) => {
                    const unrealized = h.currentPriceEth - h.buyPriceEth
                    const unrealizedPct =
                      h.buyPriceEth > 0 ? (unrealized / h.buyPriceEth) * 100 : 0
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
                        <div className="flex min-w-0 flex-1 items-center gap-1 text-xs">
                          <span className="font-medium">{h.collectionName}</span>
                          <span className="text-muted-foreground">{h.tokenId}</span>
                        </div>
                        <div className="hidden w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                          {fmtEth(h.buyPriceEth)}
                        </div>
                        <div className="hidden w-16 shrink-0 text-right text-xs tabular-nums sm:block">
                          {fmtEth(h.currentPriceEth)}
                        </div>
                        <div
                          className={`flex w-24 shrink-0 items-center justify-end gap-1 text-xs font-semibold tabular-nums ${
                            up ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                          {`${up ? '+' : ''}${fmtEth(unrealized)}`}
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
            <Badge variant="outline" className="text-[10px] gap-1 border-cyan-500/40 bg-cyan-500/10 text-cyan-300">
              <Ship className="size-3" /> floor engine
            </Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {seabot.trades.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No trades yet — start the bot to begin scanning.
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {seabot.trades.slice(0, 30).map((t, i) => (
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
              onClick={() => seabot.scan()}
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
            {seabot.logs.length === 0 ? (
              <div className="text-muted-foreground">
                No logs yet — start the bot to begin.
              </div>
            ) : (
              seabot.logs.slice(0, 50).map((l, i) => (
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
            <Zap className="size-3 text-cyan-400" />
            Bot stopped — Start to scan NFT floors &amp; trade.
          </div>
        )}
      </CardContent>
    </Card>
  )
}