'use client'

import { Pause, PiggyBank, Play, RotateCcw } from 'lucide-react'

import { BotTabs } from '@/components/trading/BotTabs'
import { useCarryBotContext } from '@/components/trading/BotsProvider'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CompoundEvery } from '@/hooks/use-carry'

const usd = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const pct = (f: number, d = 1) => `${(f * 100).toFixed(d)}%`

function CarryInner() {
  const bot = useCarryBotContext()
  const cfg = bot.config
  const p = bot.position
  const pnl = bot.equityUsd - cfg.capitalUsd

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">
              Rendimiento · Aave USDC + funding carry en Bybit · {bot.dataOk ? 'datos reales' : 'esperando datos'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <PiggyBank className="size-4 text-emerald-400" /> Bot de rendimiento
                        <Badge variant="outline" className="text-emerald-400">DEMO · datos reales</Badge>
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">
                        El capital libre cobra el interés real de Aave (USDC en Base). Cuando un perpetuo de Bybit paga
                        un funding alto y estable, una parte entra en carry (spot comprado + perpetuo en corto) y cobra
                        el funding. Comisiones y spreads reales.
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      {bot.enabled ? (
                        <Button size="sm" variant="outline" onClick={bot.stop}>
                          <Pause className="size-3.5" /> Detener
                        </Button>
                      ) : (
                        <Button size="sm" onClick={bot.start}>
                          <Play className="size-3.5" /> Arrancar
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={bot.reset} disabled={bot.enabled}>
                        <RotateCcw className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Capital" value={`${usd(bot.equityUsd)} USD`} />
                    <Stat label="Resultado" value={`${pnl >= 0 ? '+' : ''}${usd(pnl, 4)} USD`} tone={pnl >= 0 ? 'up' : 'down'} />
                    <Stat label="En Aave" value={`${usd(bot.aaveUsd)} USD · ${bot.aaveApy ? pct(bot.aaveApy, 2) : '—'}`} />
                    <Stat label="Interés Aave cobrado" value={`+${usd(bot.aaveInterestUsd, 4)} USD`} tone="up" />
                  </div>
                  <div className="rounded-md border border-border/60 p-3 text-xs">
                    {p ? (
                      <p>
                        Carry abierto en <strong>{p.label}</strong>: {p.qty.toFixed(6)} spot + corto perp · valor{' '}
                        {usd(bot.positionValueUsd)} USD · funding cobrado {usd(p.fundingTotalUsd, 4)} USD
                      </p>
                    ) : (
                      <p className="text-muted-foreground">Sin carry: todo el capital está en Aave.</p>
                    )}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <SliderRow
                      label="Capital (demo)"
                      value={cfg.capitalUsd}
                      fmt={(v) => `${usd(v, 0)} USD`}
                      min={10}
                      max={20000}
                      step={10}
                      disabled={bot.enabled || !!p}
                      onChange={(v) => bot.updateConfig({ capitalUsd: v })}
                    />
                    <SliderRow
                      label="Máximo en carry"
                      value={cfg.carryPct}
                      fmt={(v) => `${v}% del capital`}
                      min={0}
                      max={100}
                      step={5}
                      disabled={bot.enabled}
                      onChange={(v) => bot.updateConfig({ carryPct: v })}
                    />
                    <SliderRow
                      label="Horizonte para amortizar costes"
                      value={cfg.rules.horizonDays}
                      fmt={(v) => `${v} días`}
                      min={7}
                      max={90}
                      step={1}
                      disabled={bot.enabled}
                      onChange={(v) => bot.updateConfig({ rules: { ...cfg.rules, horizonDays: v } })}
                    />
                    <SliderRow
                      label="Funding positivo mínimo (7 días)"
                      value={cfg.rules.minPositiveShare * 100}
                      fmt={(v) => `${v.toFixed(0)}% de las liquidaciones`}
                      min={50}
                      max={100}
                      step={5}
                      disabled={bot.enabled}
                      onChange={(v) => bot.updateConfig({ rules: { ...cfg.rules, minPositiveShare: v / 100 } })}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Reinvertir el funding cobrado:</span>
                    {(['hour', 'day', 'week'] as CompoundEvery[]).map((k) => (
                      <Button
                        key={k}
                        size="sm"
                        variant={cfg.compoundEvery === k ? 'default' : 'outline'}
                        disabled={bot.enabled}
                        onClick={() => bot.updateConfig({ compoundEvery: k })}
                      >
                        {k === 'hour' ? 'Cada hora' : k === 'day' ? 'Cada día' : 'Cada semana'}
                      </Button>
                    ))}
                    <span className="text-muted-foreground">
                      (Aave ya compone solo; el funding se reinvierte cuando suma ≥ 5 USD, el mínimo de Bybit)
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Candidatos (funding real de Bybit)</CardTitle>
                  <CardDescription className="text-xs">
                    Se planifica con la media de 7 días (nunca por encima de la tasa actual) menos Aave, y debe cubrir
                    {` ${cfg.rules.costCover}× `}los costes de entrar y salir en {cfg.rules.horizonDays} días.
                  </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto text-xs">
                  <table className="w-full">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-2">Activo</th>
                        <th className="pr-2 text-right">Actual</th>
                        <th className="pr-2 text-right">Media 7 d</th>
                        <th className="pr-2 text-right">% positivo</th>
                        <th className="pr-2 text-right">Coste ida y vuelta</th>
                        <th className="pr-2 text-right">Sobre Aave</th>
                        <th className="pl-2">Decisión</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bot.candidates.map((c) => (
                        <tr key={c.id} className="border-t border-border/40">
                          <td className="py-1 pr-2">{c.label}</td>
                          <td className="pr-2 text-right tabular-nums">{pct(c.currentApr)}</td>
                          <td className="pr-2 text-right tabular-nums">{pct(c.funding?.avgApr ?? 0)}</td>
                          <td className="pr-2 text-right tabular-nums">{Math.round((c.funding?.positiveShare ?? 0) * 100)}%</td>
                          <td className="pr-2 text-right tabular-nums">{pct(c.roundTripCost, 2)}</td>
                          <td className={`pr-2 text-right tabular-nums ${c.edgeApr > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{pct(c.edgeApr)}</td>
                          <td className={`pl-2 ${c.eligible ? 'text-emerald-400' : 'text-muted-foreground'}`}>{c.why}</td>
                        </tr>
                      ))}
                      {bot.candidates.length === 0 && (
                        <tr>
                          <td colSpan={7} className="py-2 text-muted-foreground">Pulsa Arrancar para leer los datos.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
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
                      className={l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : l.level === 'trade' ? 'text-emerald-400' : 'text-muted-foreground'}
                    >
                      {new Date(l.time).toLocaleTimeString()} {l.msg}
                    </p>
                  ))}
                </CardContent>
              </Card>
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveEquityChart equity={bot.equityCurve} currentEquity={bot.equityUsd} capital={cfg.capitalUsd} />
              <Card>
                <CardContent className="space-y-2 p-4 text-[11px] leading-relaxed text-muted-foreground">
                  <p>
                    <strong className="text-foreground">Modo real:</strong> todavía no está conectado. Necesita USDC en
                    Aave desde una wallet (MetaMask) y el carry en Bybit con tus claves, moviendo fondos entre los dos.
                    Valida primero la demo unas semanas.
                  </p>
                  <p>
                    <strong className="text-foreground">Riesgos:</strong> el funding cambia cada liquidación y puede
                    volverse negativo; el corto del perpetuo puede liquidarse en una subida brusca si no tiene margen;
                    Aave y Bybit tienen riesgo de plataforma.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </main>
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

function SliderRow(props: {
  label: string
  value: number
  fmt: (v: number) => string
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <Label className="text-xs">{props.label}</Label>
        <span className="text-muted-foreground">{props.fmt(props.value)}</span>
      </div>
      <Slider
        min={props.min}
        max={props.max}
        step={props.step}
        value={[props.value]}
        disabled={props.disabled}
        onValueChange={([v]) => props.onChange(v)}
      />
    </div>
  )
}

export default function CarryPage() {
  return (
    <TooltipProvider delayDuration={200}>
      <CarryInner />
    </TooltipProvider>
  )
}
