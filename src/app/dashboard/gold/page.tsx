'use client'

import { useEffect, useState } from 'react'
import { FlaskConical, KeyRound, Landmark, Pause, Play, RotateCcw, ShieldAlert } from 'lucide-react'

import { BotTabs } from '@/components/trading/BotTabs'
import { useGoldBotContext } from '@/components/trading/BotsProvider'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GoldBot } from '@/hooks/use-gold'
import { clearOandaCreds, loadOandaCreds, oandaSummary, saveOandaCreds, type OandaCreds } from '@/lib/oanda'
import type { TrendParams } from '@/lib/trend'

const usd = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

const SLIDERS: { key: keyof TrendParams; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: 'entryBars', label: 'Ruptura de entrada (velas)', min: 10, max: 100, step: 1, fmt: (v) => `${v}` },
  { key: 'exitBars', label: 'Ruptura de salida (velas)', min: 5, max: 50, step: 1, fmt: (v) => `${v}` },
  { key: 'trendEma', label: 'Filtro de tendencia (EMA)', min: 20, max: 300, step: 10, fmt: (v) => `EMA ${v}` },
  { key: 'atrMult', label: 'Stop (× ATR)', min: 1, max: 6, step: 0.5, fmt: (v) => `${v} × ATR` },
  { key: 'riskPct', label: 'Riesgo por operación', min: 0.25, max: 3, step: 0.25, fmt: (v) => `${v}% del capital` },
]

function OandaConnect({ bot }: { bot: GoldBot }) {
  const [creds, setCreds] = useState<OandaCreds | null>(null)
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [env, setEnv] = useState<'practice' | 'live'>('practice')
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [askConfirm, setAskConfirm] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setCreds(loadOandaCreds()), 0)
    return () => clearTimeout(t)
  }, [])

  const verify = async (c: OandaCreds) => {
    setBusy(true)
    setStatus(null)
    try {
      const s = await oandaSummary(c)
      setStatus({ ok: true, msg: `Cuenta ${c.env === 'live' ? 'REAL' : 'de práctica'} verificada · saldo ${usd(s.balance)} ${s.currency}` })
      bot.log(`OANDA verificada (${c.env}): saldo ${usd(s.balance)} ${s.currency}`)
    } catch (e) {
      setStatus({ ok: false, msg: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <KeyRound className="size-4" /> Cuenta de OANDA
          {creds && (
            <Badge variant="outline" className={creds.env === 'live' ? 'text-red-400' : 'text-emerald-400'}>
              {creds.env === 'live' ? 'REAL' : 'práctica'} · {creds.accountId}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          Crea una cuenta de práctica gratis en OANDA y genera un token en tu perfil (Manage API Access). El token se guarda solo
          en este navegador; el servidor solo lo reenvía a OANDA. Sin cuenta, la demo usa el precio de PAXG (1 PAXG = 1 onza de oro).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {creds ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void verify(creds)}>
              {busy ? 'Verificando…' : 'Verificar cuenta'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={bot.enabled || !!bot.position?.tradeId}
              onClick={() => {
                clearOandaCreds()
                setCreds(null)
                bot.updateConfig({ liveTrading: false })
              }}
            >
              Borrar credenciales
            </Button>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase text-muted-foreground">Token de API</Label>
              <Input value={token} onChange={(e) => setToken(e.target.value.trim())} type="password" className="h-8 text-xs" autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase text-muted-foreground">ID de cuenta (p. ej. 101-004-1234567-001)</Label>
              <Input value={accountId} onChange={(e) => setAccountId(e.target.value.trim())} className="h-8 text-xs" autoComplete="off" />
            </div>
            <div className="flex items-center gap-3 sm:col-span-2">
              <label className="flex items-center gap-2">
                <Switch checked={env === 'live'} onCheckedChange={(v) => setEnv(v ? 'live' : 'practice')} />
                Cuenta real (fxTrade) — si no, práctica (fxPractice)
              </label>
              <Button
                size="sm"
                disabled={!token || !accountId || busy}
                onClick={() => {
                  const c = { token, accountId, env }
                  saveOandaCreds(c)
                  setCreds(c)
                  setToken('')
                  void verify(c)
                }}
              >
                Guardar y verificar
              </Button>
            </div>
          </div>
        )}
        {status && <p className={status.ok ? 'text-emerald-400' : 'text-red-400'}>{status.msg}</p>}

        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div>
            <p className="flex items-center gap-1.5 font-medium">
              <ShieldAlert className="size-3.5 text-amber-400" /> Operar en la cuenta de OANDA
            </p>
            <p className="text-[10px] text-muted-foreground">
              Envía órdenes reales a la cuenta conectada ({creds?.env === 'live' ? 'DINERO REAL' : 'práctica: dinero ficticio de OANDA'}),
              con el stop puesto en OANDA. Recomendado: semanas en práctica antes de una cuenta real.
            </p>
          </div>
          <Switch
            checked={bot.config.liveTrading}
            disabled={!creds || bot.enabled || !!bot.position}
            onCheckedChange={(v) => {
              if (!v) return bot.updateConfig({ liveTrading: false })
              setConfirm('')
              setAskConfirm(true)
            }}
          />
        </div>
        {askConfirm && (
          <div className="space-y-2 rounded-md border border-amber-500/40 p-3">
            <p>
              Escribe <strong>OPERAR</strong> para enviar órdenes a la cuenta {creds?.env === 'live' ? <strong className="text-red-400">REAL</strong> : 'de práctica'} de OANDA.
              El oro es un CFD apalancado: puedes perder más rápido de lo que ganas.
            </p>
            <div className="flex gap-2">
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-8 max-w-40 text-xs" placeholder="OPERAR" />
              <Button
                size="sm"
                disabled={confirm.trim().toUpperCase() !== 'OPERAR'}
                onClick={() => {
                  bot.updateConfig({ liveTrading: true })
                  bot.log(`Operación en OANDA (${creds?.env}) ACTIVADA tras confirmación escrita`, 'error')
                  setAskConfirm(false)
                }}
              >
                Activar
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAskConfirm(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function GoldInner() {
  const bot = useGoldBotContext()
  const cfg = bot.config
  const p = cfg.params
  const pos = bot.position
  const bt = bot.backtest

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">
              Oro · XAU/USD · {bot.source === 'oanda' ? 'precios de OANDA' : bot.source === 'paxg' ? 'precios PAXG (proxy del oro)' : 'pulsa Arrancar'}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Landmark className="size-4 text-yellow-400" /> Tendencia en oro
                        <Badge variant="outline" className={cfg.liveTrading ? 'text-red-400' : 'text-emerald-400'}>
                          {cfg.liveTrading ? 'OANDA' : 'DEMO'}
                        </Badge>
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">
                        Velas de {p.interval} · ruptura {p.entryBars}/{p.exitBars} · EMA{p.trendEma} · stop {p.atrMult}×ATR · sin comisión
                        (spread) · financiación {(100 * (p.holdCostPerYear ?? 0)).toFixed(1)}%/año · mínimo {bot.spec.minimumTradeSize} oz ·
                        margen {(bot.spec.marginRate * 100).toFixed(0)}%
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      {bot.enabled ? (
                        <Button size="sm" variant="outline" onClick={bot.stop}>
                          <Pause className="size-3.5" /> Detener
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => void bot.start()}>
                          <Play className="size-3.5" /> Arrancar
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={bot.resetAccount} disabled={bot.enabled}>
                        <RotateCcw className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Capital" value={`${usd(bot.equityUsd)} USD`} />
                    <Stat label="P&L realizado" value={`${bot.realizedUsd >= 0 ? '+' : ''}${usd(bot.realizedUsd)} USD`} tone={bot.realizedUsd >= 0 ? 'up' : 'down'} />
                    <Stat label="Abierto" value={`${bot.unrealizedUsd >= 0 ? '+' : ''}${usd(bot.unrealizedUsd)} USD`} tone={bot.unrealizedUsd >= 0 ? 'up' : 'down'} />
                    <Stat label="Operaciones" value={`${bot.trades.length} · ${bot.winRate.toFixed(0)}% acierto`} />
                  </div>
                  <div className="rounded-md border border-border/60 p-3 text-xs">
                    <p className="text-muted-foreground">
                      Precio {bot.price ? `${usd(bot.price.bid)} / ${usd(bot.price.ask)}` : '—'} · última decisión: {bot.lastDecision}
                    </p>
                    {pos ? (
                      <p className="mt-2">
                        Posición: <strong>{pos.units} oz</strong> desde {usd(pos.entryPrice)} · stop {usd(pos.stop)}
                        {pos.tradeId ? ` (en OANDA, trade ${pos.tradeId})` : ''} · financiación {usd(pos.financingUsd)} USD
                      </p>
                    ) : (
                      <p className="mt-2 text-muted-foreground">Sin posición: esperando una ruptura alcista con tendencia a favor.</p>
                    )}
                  </div>
                  {bot.halted && <p className="rounded-md bg-red-500/10 p-2 text-xs text-red-400">⛔ {bot.halted}</p>}
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
                          disabled={bot.enabled}
                          onValueChange={([v]) => bot.updateConfig({ params: { ...p, [s.key]: v } })}
                        />
                      </div>
                    ))}
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <Label className="text-xs">Capital asignado</Label>
                        <span className="text-muted-foreground">{usd(cfg.capitalUsd, 0)} USD</span>
                      </div>
                      <Slider
                        min={100}
                        max={50000}
                        step={100}
                        value={[cfg.capitalUsd]}
                        disabled={bot.enabled || !!pos}
                        onValueChange={([v]) => bot.updateConfig({ capitalUsd: v })}
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={p.interval === '1h'}
                      disabled={bot.enabled || !!pos}
                      onCheckedChange={(v) => bot.updateConfig({ params: { ...p, interval: v ? '1h' : '4h' } })}
                    />
                    Velas de 1 h (en el backtest de 2026 perdió dinero; por defecto 4 h)
                  </label>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <FlaskConical className="size-4 text-violet-400" /> Backtest
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">
                        Con OANDA conectada usa velas reales de XAU/USD; si no, PAXG en Binance. Spread y financiación incluidos.
                      </CardDescription>
                    </div>
                    <Button size="sm" variant="outline" disabled={bot.backtestBusy} onClick={() => void bot.runBacktest()}>
                      {bot.backtestBusy ? 'Calculando…' : bt ? 'Recalcular' : 'Ejecutar backtest'}
                    </Button>
                  </div>
                </CardHeader>
                {bt && (
                  <CardContent className="space-y-2 text-xs">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat label="Resultado" value={`${bt.returnPct >= 0 ? '+' : ''}${bt.returnPct.toFixed(1)}%`} tone={bt.returnPct >= 0 ? 'up' : 'down'} />
                      <Stat label="Mantener oro" value={`${bt.buyHoldPct >= 0 ? '+' : ''}${bt.buyHoldPct.toFixed(1)}%`} />
                      <Stat label="Caída máxima" value={`−${bt.maxDrawdownPct.toFixed(1)}%`} tone="down" />
                      <Stat label="Operaciones" value={`${bt.trades.length} · ${bt.winRatePct.toFixed(0)}% · PF ${Number.isFinite(bt.profitFactor) ? bt.profitFactor.toFixed(2) : '∞'}`} />
                    </div>
                    <p className="text-muted-foreground">
                      {new Date(bt.fromTime).toLocaleDateString()} → {new Date(bt.toTime).toLocaleDateString()} · invertido el{' '}
                      {bt.exposurePct.toFixed(0)}% del tiempo · el backtest supone tamaños fraccionados; OANDA puede exigir un mínimo por orden.
                    </p>
                  </CardContent>
                )}
              </Card>

              <OandaConnect bot={bot} />

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
                    <strong className="text-foreground">Riesgo:</strong> el oro en OANDA es un CFD apalancado (margen ~5%, 1:20 en la
                    UE). La mayoría de cuentas minoristas de CFD pierden dinero. Esta estrategia acierta ~la mitad de las veces y puede
                    pasar meses sin ganar.
                  </p>
                  <p>
                    <strong className="text-foreground">Tamaño mínimo:</strong> si OANDA exige 1 oz por orden, con un stop de ~3×ATR (~60–90
                    USD/oz) cada operación arriesga ese importe: con poco capital, el bot omitirá las señales que superen tu riesgo máximo.
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

export default function GoldPage() {
  return (
    <TooltipProvider delayDuration={200}>
      <GoldInner />
    </TooltipProvider>
  )
}
