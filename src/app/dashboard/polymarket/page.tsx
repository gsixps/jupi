'use client'

import { Pause, Play, RotateCcw, Search, Target } from 'lucide-react'

import { BotTabs } from '@/components/trading/BotTabs'
import { usePolyCopyBotContext } from '@/components/trading/BotsProvider'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { TooltipProvider } from '@/components/ui/tooltip'

const usd = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const big = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : '−'}$${Math.abs(n) >= 1e6 ? (Math.abs(n) / 1e6).toFixed(1) + 'M' : Math.round(Math.abs(n) / 1000) + 'k'}`)

function PolyInner() {
  const bot = usePolyCopyBotContext()
  const cfg = bot.config
  const pnl = bot.equityUsd - cfg.capitalUsd
  const isFollowed = (w: string) => bot.followed.some((f) => f.wallet === w)

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">Polymarket · copy trading de wallets · demo con datos públicos reales</p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Target className="size-4 text-sky-400" /> Copy trading Polymarket
                        <Badge variant="outline" className="text-emerald-400">DEMO</Badge>
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">
                        Copia las compras NUEVAS de las wallets seguidas al precio que realmente queda en el libro de órdenes
                        (si se movió más de {Math.round(cfg.maxSlippage * 100)} ¢, no copia), con la comisión del mercado. Vende
                        cuando ellos venden y cobra 1 o 0 cuando el mercado se resuelve. No envía nada a Polymarket.
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      {bot.enabled ? (
                        <Button size="sm" variant="outline" onClick={bot.stop}>
                          <Pause className="size-3.5" /> Detener
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => void bot.start()} disabled={bot.followed.length === 0}>
                          <Play className="size-3.5" /> Copiar
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
                    <Stat label="Resultado" value={`${pnl >= 0 ? '+' : ''}${usd(pnl)} USD`} tone={pnl >= 0 ? 'up' : 'down'} />
                    <Stat label="Copiadas / tarde" value={`${bot.stats.copied} / ${bot.stats.skippedSlippage}`} />
                    <Stat label="Cerradas" value={`${bot.closed.length} · ${bot.closed.length ? Math.round((bot.wins / bot.closed.length) * 100) : 0}% ganan`} />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Row label="Capital (demo)" v={cfg.capitalUsd} fmt={(v) => `${usd(v, 0)} USD`} min={50} max={20000} step={50} disabled={bot.enabled || bot.positions.length > 0} on={(v) => bot.updateConfig({ capitalUsd: v })} />
                    <Row label="Por operación copiada" v={cfg.perTradePct} fmt={(v) => `${v}% del capital (compuesto)`} min={1} max={20} step={1} disabled={bot.enabled} on={(v) => bot.updateConfig({ perTradePct: v })} />
                    <Row label="Retraso máximo de precio" v={cfg.maxSlippage * 100} fmt={(v) => `${v.toFixed(1)} ¢`} min={0.5} max={10} step={0.5} disabled={bot.enabled} on={(v) => bot.updateConfig({ maxSlippage: v / 100 })} />
                    <Row label="Wallets a seguir (auto)" v={cfg.followCount} fmt={(v) => `${v}`} min={1} max={15} step={1} disabled={bot.enabled} on={(v) => bot.updateConfig({ followCount: v })} />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle className="text-sm">Análisis de wallets</CardTitle>
                      <CardDescription className="text-xs">
                        Wallets en ≥2 de los rankings semana/mes/total. Copiable = constante, no es un bot de alta frecuencia,
                        operaciones de tamaño razonable, beneficio repartido (no una sola apuesta) y sus cierres recientes ganan.
                        El acierto incluye las pérdidas que nunca canjearon.
                      </CardDescription>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void bot.runAnalysis()} disabled={bot.analyzing}>
                      <Search className="size-3.5" /> {bot.analyzing ? 'Analizando…' : 'Analizar'}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="overflow-x-auto text-xs">
                  <table className="w-full">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-2">Seguir</th>
                        <th className="pr-2">Wallet</th>
                        <th className="pr-2 text-right">Semana</th>
                        <th className="pr-2 text-right">Mes</th>
                        <th className="pr-2 text-right">Acierto</th>
                        <th className="pr-2 text-right">USD/op</th>
                        <th className="pr-2 text-right">Ops/h</th>
                        <th className="pl-2">Veredicto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bot.analysis.map((w) => (
                        <tr key={w.wallet} className="border-t border-border/40">
                          <td className="py-1 pr-2">
                            <input type="checkbox" checked={isFollowed(w.wallet)} disabled={bot.enabled} onChange={() => bot.toggleFollow(w.wallet, w.name)} />
                          </td>
                          <td className="pr-2">
                            <a className="underline-offset-2 hover:underline" href={`https://polymarket.com/profile/${w.wallet}`} target="_blank" rel="noreferrer">
                              {w.name.slice(0, 18)}
                            </a>
                          </td>
                          <td className="pr-2 text-right tabular-nums">{big(w.pnlWeek)}</td>
                          <td className="pr-2 text-right tabular-nums">{big(w.pnlMonth)}</td>
                          <td className="pr-2 text-right tabular-nums">
                            {Math.round(w.winRate * 100)}% <span className="text-muted-foreground">({w.resolved})</span>
                          </td>
                          <td className="pr-2 text-right tabular-nums">{usd(w.avgTradeUsd, 0)}</td>
                          <td className="pr-2 text-right tabular-nums">{w.tradesPerHour.toFixed(1)}</td>
                          <td className={`pl-2 ${w.copyable ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                            {w.copyable ? 'copiable' : w.reasons.join('; ')}
                          </td>
                        </tr>
                      ))}
                      {bot.analysis.length === 0 && (
                        <tr>
                          <td colSpan={8} className="py-2 text-muted-foreground">
                            Pulsa Analizar (tarda 1–2 minutos: revisa cientos de operaciones de cada wallet).
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Posiciones copiadas ({bot.positions.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1 text-xs">
                  {bot.positions.length === 0 && <p className="text-muted-foreground">Ninguna todavía.</p>}
                  {bot.positions.map((p) => {
                    const v = p.shares * p.markPrice
                    return (
                      <div key={p.asset} className="flex flex-wrap justify-between gap-2 border-b border-border/40 py-1 last:border-0">
                        <span className="max-w-md truncate">
                          {p.title} · <strong>{p.outcome}</strong> <span className="text-muted-foreground">({p.walletName})</span>
                        </span>
                        <span className="tabular-nums">
                          {p.avgPrice.toFixed(3)} → {p.markPrice.toFixed(3)} ·{' '}
                          <span className={v - p.costUsd >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                            {v - p.costUsd >= 0 ? '+' : ''}
                            {usd(v - p.costUsd)} USD
                          </span>
                        </span>
                      </div>
                    )
                  })}
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
                    <strong className="text-foreground">Cómo leer el resultado:</strong> la columna “tarde” cuenta las compras que
                    no se pudieron copiar porque el precio ya se había movido. Si es alta, la ventaja de esas wallets se va antes
                    de que llegues.
                  </p>
                  <p>
                    <strong className="text-foreground">Antes de operar en real:</strong> comprueba que Polymarket está disponible
                    en tu país y cómo trata tu legislación estas apuestas y sus ganancias.
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

function Row(p: { label: string; v: number; fmt: (v: number) => string; min: number; max: number; step: number; disabled?: boolean; on: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <Label className="text-xs">{p.label}</Label>
        <span className="text-muted-foreground">{p.fmt(p.v)}</span>
      </div>
      <Slider min={p.min} max={p.max} step={p.step} value={[p.v]} disabled={p.disabled} onValueChange={([v]) => p.on(v)} />
    </div>
  )
}

export default function PolymarketPage() {
  return (
    <TooltipProvider delayDuration={200}>
      <PolyInner />
    </TooltipProvider>
  )
}
