'use client'

import { useState } from 'react'
import {
  ArrowLeftRight,
  Building2,
  CircleDollarSign,
  Coins,
  Pause,
  Play,
  RefreshCw,
  Square,
  TrendingUp,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ExchangeKeysPanel } from '@/components/cex/ExchangeKeysPanel'
import { bybitVerifyKeys } from '@/lib/cex'
import { fmtBps, fmtUsd } from '@/lib/format'
import type { useBybitBot } from '@/hooks/use-bybit'

interface BybitTradingPanelProps {
  bybit: ReturnType<typeof useBybitBot>
}

interface NumericControl {
  key:
    | 'budgetPerTradeUsd'
    | 'maxHoldings'
    | 'entryBasisBps'
    | 'exitBasisBps'
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
  {
    key: 'budgetPerTradeUsd',
    label: 'Budget per hedge',
    min: 1,
    max: 100000,
    step: 5,
    format: (v) => fmtUsd(v),
  },
  { key: 'maxHoldings', label: 'Max open hedges', min: 1, max: 10, step: 1 },
  {
    key: 'entryBasisBps',
    label: 'Entry basis',
    min: 1,
    max: 200,
    step: 1,
    unit: 'bps',
    format: (v) => fmtBps(v),
  },
  {
    key: 'exitBasisBps',
    label: 'Exit basis',
    min: 0,
    max: 50,
    step: 1,
    unit: 'bps',
    format: (v) => (v === 0 ? 'converged' : fmtBps(v)),
  },
  {
    key: 'stopLossBps',
    label: 'Basis stop-loss',
    min: 1,
    max: 200,
    step: 1,
    unit: 'bps',
    format: (v) => `+${v}bps`,
  },
  {
    key: 'trailingBps',
    label: 'Trailing',
    min: 0,
    max: 100,
    step: 1,
    unit: 'bps',
    format: (v) => (v === 0 ? 'off' : `${v}bps`),
  },
  {
    key: 'tickIntervalMs',
    label: 'Scan interval',
    min: 3000,
    max: 20000,
    step: 500,
    unit: 'ms',
    format: (v) => `${(v / 1000).toFixed(1)}s`,
  },
]

export function BybitTradingPanel({ bybit }: BybitTradingPanelProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)
  const [capitalInput, setCapitalInput] = useState(String(bybit.config.capitalUsd))

  const stats = bybit.stats
  const equity = stats?.equityUsd ?? bybit.config.capitalUsd
  const realized = stats?.realizedPnlUsd ?? 0
  const winRate = stats?.winRate ?? 0
  const openHoldings = stats?.openHoldings ?? 0
  const pnlTone = realized >= 0 ? 'positive' : 'negative'
  const running = bybit.enabled
  const live = bybit.dataSource === 'live'
  const realMode = bybit.config.liveTrading

  const handleStart = () => {
    setConfirmedThisSession(true)
    bybit.start()
  }

  const handleReset = () => {
    bybit.resetAccount()
    setCapitalInput(String(bybit.config.capitalUsd))
  }

  const handleCapitalCommit = () => {
    const v = parseFloat(capitalInput)
    if (!isFinite(v) || v <= 0) {
      setCapitalInput(String(bybit.config.capitalUsd))
      return
    }
    bybit.updateConfig({ capitalUsd: v })
  }

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="size-4 text-orange-400" />
              Bybit RWA Basis Control
            </CardTitle>
            <CardDescription className="mt-1">
              xStocks spot vs TradFi perps &middot;{' '}
              {realMode ? (
                <span className="text-rose-400">real capital · live orders</span>
              ) : (
                <>
                  fictional USD &middot;{' '}
                  <span className="text-orange-400">
                    {live ? 'live api.bybit.com' : 'demo engine'}
                  </span>
                </>
              )}
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className={
              running
                ? 'gap-1 border-orange-500/40 bg-orange-500/15 text-orange-300'
                : 'gap-1 border-zinc-500/40 bg-zinc-500/10 text-zinc-300'
            }
          >
            {running ? <Pause className="size-3" /> : <Play className="size-3" />}
            {running ? 'scanning' : 'idle'}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-0 pt-3">
        {/* Start / Stop / Reset */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button
              size="lg"
              onClick={() => bybit.stop()}
              className="gap-2 bg-orange-600 text-white hover:bg-orange-500"
            >
              <Square className="size-4" /> Stop Bybit Bot
            </Button>
          ) : confirmedThisSession ? (
            <Button
              size="lg"
              onClick={handleStart}
              className="gap-2 bg-orange-600 text-white hover:bg-orange-500"
            >
              <Play className="size-4" /> Start Bybit Bot
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={handleStart}
              className="gap-2 bg-orange-600 text-white hover:bg-orange-500"
            >
              <Play className="size-4" /> Start Bybit Bot
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            onClick={handleReset}
            disabled={running}
            className="gap-2"
          >
            <RefreshCw className="size-4" /> Reset
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={() => void bybit.scan()}
            disabled={running}
            className="gap-2"
          >
            <ArrowLeftRight className="size-4" /> One scan
          </Button>
        </div>

        {/* Real-mode connection */}
        <ExchangeKeysPanel
          kind="bybit"
          verify={bybitVerifyKeys}
          liveEnabled={realMode}
          onLiveEnabledChange={(v) => bybit.updateConfig({ liveTrading: v })}
          running={running}
          onLog={bybit.log}
        />

        {/* Capital */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {realMode ? 'Real capital (USDT on Bybit)' : 'Fictional capital (USD)'}
            </Label>
            <div className="relative">
              <Input
                value={capitalInput}
                onChange={(e) => setCapitalInput(e.target.value)}
                onBlur={handleCapitalCommit}
                disabled={running || realMode}
                type="number"
                min="0.01"
                step="0.01"
                className="h-8 w-32 text-sm"
                placeholder="10000"
              />
            </div>
          </div>
          <p className="flex-1 text-[10px] text-muted-foreground">
            {realMode
              ? 'In real mode the capital is read from your Bybit USDT balance every scan — it cannot be edited.'
              : 'Starting fictional balance in USD. Works from cents up to large amounts. Editable only while stopped — changing it resets the cash balance.'}
          </p>
        </div>

        {/* Live stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile
            label="Equity"
            value={fmtUsd(equity)}
            sub={`Started ${fmtUsd(bybit.config.capitalUsd)}`}
          />
          <StatTile
            label="Realized P&L"
            value={fmtUsd(realized, 4)}
            sub={realMode ? 'real' : 'fictional'}
            tone={pnlTone}
          />
          <StatTile
            label="Cash"
            value={fmtUsd(bybit.cashUsd)}
            sub={realMode ? 'USDT real' : 'fictional'}
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
            label="Open Hedges"
            value={String(openHoldings)}
            sub={`Max ${bybit.config.maxHoldings}`}
          />
          <StatTile
            label="Invested"
            value={fmtUsd(stats?.investedUsd ?? 0)}
            sub={realMode ? 'USDT real' : 'fictional'}
          />
          <StatTile
            label="Signals"
            value={String(stats?.signalsDetected ?? 0)}
            sub={`≥ ${bybit.config.entryBasisBps}bps`}
          />
          <StatTile
            label="Compound"
            value={
              stats?.compound
                ? `×${(stats?.compoundFactor ?? 1).toFixed(3)}`
                : 'off'
            }
            sub={stats?.compound ? 'budget scales' : 'fixed budget'}
            tone={stats?.compound ? 'positive' : 'default'}
          />
        </div>

        <Separator />

        {/* Strategy sliders */}
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Basis-arb strategy</h3>
            <p className="text-[10px] text-muted-foreground">
              Hedge the perp against the spot xStock: perp rich → buy spot + short perp;
              perp cheap → sell spot + long perp. Market-neutral, only basis convergence
              pays.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONTROLS.map((c) => {
              const val = bybit.config[c.key] as number
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
                      bybit.updateConfig({ [c.key]: v } as never)
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
                    ? ` (×${stats.compoundFactor.toFixed(3)})`
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

        {/* Open hedges */}
        <Separator />
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Open hedges</h3>
          {bybit.holdings.filter((h) => h.status === 'open').length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No open hedges. The bot opens one when |basis| ≥{' '}
              {bybit.config.entryBasisBps}bps on any RWA pair.
            </p>
          ) : (
            <div className="space-y-1.5">
              {bybit.holdings
                .filter((h) => h.status === 'open')
                .map((h) => (
                  <div
                    key={h.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {h.token}
                      </Badge>
                      <span className="text-muted-foreground">{h.company}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {h.spotSide === 'buy' ? 'BUY spot' : 'SELL spot'} +{' '}
                        {h.perpSide === 'buy' ? 'LONG perp' : 'SHORT perp'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] tabular-nums">
                      <span className="text-muted-foreground">
                        entry {h.entryBasisBps >= 0 ? '+' : ''}
                        {h.entryBasisBps}bps
                      </span>
                      <span
                        className={
                          Math.abs(h.currentBasisBps) < Math.abs(h.entryBasisBps)
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                        }
                      >
                        now {h.currentBasisBps >= 0 ? '+' : ''}
                        {h.currentBasisBps}bps
                      </span>
                      <span className="text-muted-foreground">
                        {fmtUsd(h.notionalUsd)}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* Recent trades */}
        <Separator />
        <div className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <TrendingUp className="size-3.5 text-orange-400" /> Recent trades
          </h3>
          {bybit.trades.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No trades yet.</p>
          ) : (
            <div className="space-y-1">
              {bybit.trades.slice(0, 8).map((t) => (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 px-2.5 py-1 text-[11px]"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        t.type === 'open'
                          ? 'border-orange-500/40 text-orange-300'
                          : 'border-zinc-500/40 text-zinc-300'
                      }
                    >
                      {t.type === 'open' ? 'OPEN' : 'CLOSE'}
                    </Badge>
                    <span className="font-medium">{t.token}</span>
                    <span className="text-muted-foreground">
                      {t.basisBps >= 0 ? '+' : ''}
                      {t.basisBps}bps
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {fmtUsd(t.notionalUsd)}
                    </span>
                    {t.type === 'close' && (
                      <span
                        className={
                          t.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }
                      >
                        {t.pnlUsd >= 0 ? '+' : ''}
                        {fmtUsd(t.pnlUsd, 4)}
                      </span>
                    )}
                    <span className="hidden max-w-[220px] truncate text-muted-foreground md:inline">
                      {t.reason}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
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
        : ''
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`text-sm font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
