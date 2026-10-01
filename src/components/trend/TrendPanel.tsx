'use client'

import { Activity, FlaskConical, Pause, Play, RotateCcw, TrendingDown, TrendingUp } from 'lucide-react'

import { ExchangeKeysPanel } from '@/components/cex/ExchangeKeysPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type { TrendBot } from '@/hooks/use-trend'
import { verifyBinanceKeys } from '@/lib/cex'
import type { TrendParams } from '@/lib/trend'

const usd = (n: number, d = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const when = (t: number) => new Date(t).toLocaleString()

const SLIDERS: { key: keyof TrendParams; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'entryBars', label: 'Ruptura de entrada (velas)', min: 10, max: 100, step: 1, fmt: (v) => `${v}` },
  { key: 'exitBars', label: 'Ruptura de salida (velas)', min: 5, max: 50, step: 1, fmt: (v) => `${v}` },
  { key: 'trendEma', label: 'Filtro de tendencia (EMA)', min: 20, max: 300, step: 10, fmt: (v) => `EMA ${v}` },
  { key: 'atrMult', label: 'Stop dinámico (× ATR)', min: 1, max: 6, step: 0.5, fmt: (v) => `${v} × ATR` },
  { key: 'riskPct', label: 'Riesgo por operación', min: 0.25, max: 3, step: 0.25, fmt: (v) => `${v}% del capital` },
]

export function TrendPanel({ bot }: { bot: TrendBot }) {
  const { config, stats, position, backtest: bt } = bot
  const running = bot.enabled
  const p = config.params
  const pnlOpen = position ? stats.positionUsd - position.costUsd : 0

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="size-4 text-amber-400" />
                Tendencia {bot.meta.name}
                <Badge variant="outline" className={config.liveTrading ? 'text-red-400' : 'text-emerald-400'}>
                  {config.liveTrading ? 'REAL' : 'DEMO · precios reales'}
                </Badge>
              </CardTitle>
              <CardDescription className="mt-1 text-xs">
                {bot.meta.symbol} · velas de {p.interval} · ruptura {p.entryBars}/{p.exitBars} · EMA{p.trendEma} ·
                stop {p.atrMult}×ATR · comisión {(p.feeRate * 100).toFixed(2)}% + deslizamiento {(p.slippage * 100).toFixed(2)}%
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {running ? (
                <Button size="sm" variant="outline" onClick={bot.stop}>
                  <Pause className="size-3.5" /> Detener
                </Button>
              ) : (
                <Button size="sm" onClick={() => void bot.start()}>
                  <Play className="size-3.5" /> Arrancar
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={bot.resetAccount} disabled={running}>
                <RotateCcw className="size-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Capital" value={`${usd(stats.equityUsd)} USD`} />
            <Stat label="Efectivo" value={`${usd(stats.cashUsd)} USD`} />
            <Stat
              label="P&L realizado"
              value={`${stats.realizedPnlUsd >= 0 ? '+' : ''}${usd(stats.realizedPnlUsd)} USD`}
              tone={stats.realizedPnlUsd >= 0 ? 'up' : 'down'}
            />
            <Stat label="Operaciones" value={`${stats.totalTrades} · ${stats.winRate.toFixed(0)}% acierto`} />
          </div>

          <div className="rounded-md border border-border/60 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">
                Precio {bot.lastPrice > 0 ? `${usd(bot.lastPrice)} USD` : '—'} · datos{' '}
                {bot.dataSource === 'live' ? 'Binance en vivo' : 'sin conexión'}
              </span>
              <span className="text-muted-foreground">Última decisión: {bot.lastDecision}</span>
            </div>
            {position ? (
              <p className="mt-2">
                Posición: <strong>{position.qty.toFixed(6)} {bot.meta.base}</strong> desde {usd(position.entryPrice)} ·
                stop {usd(position.stop)} · abierta {pnlOpen >= 0 ? '+' : ''}
                {usd(pnlOpen)} USD
              </p>
            ) : (
              <p className="mt-2 text-muted-foreground">Sin posición: esperando una ruptura alcista con tendencia a favor.</p>
            )}
          </div>

          {bot.halted && <p className="rounded-md bg-red-500/10 p-2 text-xs text-red-400">⛔ {bot.halted}</p>}

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            {SLIDERS.map((s) => (
              <div key={s.key} className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <Label className="text-xs">{s.label}</Label>
                  <span className="text-muted-foreground">{s.fmt(p[s.key] as number)}</span>
                </div>
                <Slider
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={[p[s.key] as number]}
                  disabled={running}
                  onValueChange={([v]) => bot.updateConfig({ params: { ...p, [s.key]: v } })}
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <Label className="text-xs">Capital asignado</Label>
                <span className="text-muted-foreground">{usd(config.capitalUsd, 0)} USD</span>
              </div>
              <Slider
                min={10}
                max={10000}
                step={10}
                value={[config.capitalUsd]}
                disabled={running || !!position}
                onValueChange={([v]) => bot.updateConfig({ capitalUsd: v })}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-2">
              <Switch
                checked={p.interval === '1h'}
                disabled={running || !!position}
                onCheckedChange={(v) => bot.updateConfig({ params: { ...p, interval: v ? '1h' : '4h' } })}
              />
              Velas de 1 h (más operaciones y más comisiones; por defecto 4 h)
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={config.compound} disabled={running} onCheckedChange={(v) => bot.updateConfig({ compound: v })} />
              Interés compuesto (el riesgo se calcula sobre el capital actual)
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="size-4 text-violet-400" /> Backtest con las mismas reglas
              </CardTitle>
              <CardDescription className="mt-1 text-xs">
                ~2.7 años de velas reales de Binance, comisiones y deslizamiento incluidos. El pasado no garantiza resultados futuros.
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => void bot.runBacktest()} disabled={bot.backtestBusy}>
              {bot.backtestBusy ? 'Calculando…' : bt ? 'Recalcular' : 'Ejecutar backtest'}
            </Button>
          </div>
        </CardHeader>
        {bt && (
          <CardContent className="space-y-2 text-xs">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Resultado" value={`${bt.returnPct >= 0 ? '+' : ''}${bt.returnPct.toFixed(1)}%`} tone={bt.returnPct >= 0 ? 'up' : 'down'} />
              <Stat label="Comprar y mantener" value={`${bt.buyHoldPct >= 0 ? '+' : ''}${bt.buyHoldPct.toFixed(1)}%`} />
              <Stat label="Caída máxima" value={`−${bt.maxDrawdownPct.toFixed(1)}%`} tone="down" />
              <Stat label="Operaciones" value={`${bt.trades.length} · ${bt.winRatePct.toFixed(0)}% acierto · PF ${Number.isFinite(bt.profitFactor) ? bt.profitFactor.toFixed(2) : '∞'}`} />
            </div>
            <p className="text-muted-foreground">
              {new Date(bt.fromTime).toLocaleDateString()} → {new Date(bt.toTime).toLocaleDateString()} · invertido el{' '}
              {bt.exposurePct.toFixed(0)}% del tiempo · capital {usd(bt.startEquity, 0)} → {usd(bt.endEquity)} USD
            </p>
          </CardContent>
        )}
      </Card>

      <ExchangeKeysPanel
        kind="binance"
        verify={verifyBinanceKeys}
        liveEnabled={config.liveTrading}
        onLiveEnabledChange={(v) => bot.updateConfig({ liveTrading: v })}
        running={running}
        disabled={!!position}
        onLog={bot.log}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Operaciones</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {bot.trades.length === 0 && <p className="text-muted-foreground">Todavía no hay operaciones cerradas.</p>}
          {bot.trades.slice(0, 30).map((t) => (
            <div key={`${t.entryTime}-${t.exitTime}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 py-1 last:border-0">
              <span className="text-muted-foreground">{when(t.exitTime)}</span>
              <span>
                {usd(t.entryPrice)} → {usd(t.exitPrice)}
              </span>
              <span className={t.pnlUsd >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {t.pnlUsd >= 0 ? <TrendingUp className="mr-1 inline size-3" /> : <TrendingDown className="mr-1 inline size-3" />}
                {t.pnlUsd >= 0 ? '+' : ''}
                {usd(t.pnlUsd)} USD ({t.pnlPct.toFixed(2)}%)
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Registro</CardTitle>
        </CardHeader>
        <CardContent className="max-h-72 space-y-1 overflow-y-auto font-mono text-[11px]">
          {bot.logs.map((l, i) => (
            <p
              key={`${l.time}-${i}`}
              className={
                l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : l.level === 'trade' ? 'text-emerald-400' : 'text-muted-foreground'
              }
            >
              {new Date(l.time).toLocaleTimeString()} {l.msg}
            </p>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${tone === 'up' ? 'text-emerald-400' : tone === 'down' ? 'text-red-400' : ''}`}>{value}</p>
    </div>
  )
}
