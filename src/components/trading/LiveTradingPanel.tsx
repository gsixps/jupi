'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Radio,
  Square,
  Wallet as WalletIcon,
  ArrowDownToLine,
  ArrowUpFromLine,
  RefreshCw,
  XCircle,
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
  Alert,
  AlertDescription,
} from '@/components/ui/alert'
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
import type { UseWallet } from '@/hooks/use-wallet'
import type { useLiveTrading } from '@/hooks/use-live-trading'
import { fmtUsd, fmtPct, fmtNum, fmtTime, fmtDuration } from '@/lib/format'

interface LiveTradingPanelProps {
  live: ReturnType<typeof useLiveTrading>
  wallet: UseWallet
}

interface NumericControl {
  key:
    | 'tradeSizePct'
    | 'buyThreshold'
    | 'sellThreshold'
    | 'stopLossPct'
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
  { key: 'slippageBps', label: 'Slippage', min: 10, max: 500, step: 5, unit: 'bps' },
  { key: 'scanIntervalMs', label: 'Scan Interval', min: 3000, max: 15000, step: 500, unit: 'ms', format: (v) => `${(v / 1000).toFixed(1)}s` },
]

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    idle: { label: 'Idle', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300', icon: <Pause className="size-3" /> },
    scanning: { label: 'Scanning', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300', icon: <Radio className="size-3 animate-pulse" /> },
    executing: { label: 'Executing swap', cls: 'border-violet-500/40 bg-violet-500/10 text-violet-300', icon: <Loader2 className="size-3 animate-spin" /> },
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

function StatTile({ label, value, sub, tone = 'default' }: { label: string; value: string; sub?: string; tone?: 'default' | 'positive' | 'negative' }) {
  const toneCls = tone === 'positive' ? 'text-emerald-400' : tone === 'negative' ? 'text-rose-400' : 'text-foreground'
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  )
}

function LiveTradeRow({ trade }: { trade: LiveTradingPanelProps['live']['trades'][number] }) {
  const win = trade.win
  const statusCls =
    trade.status === 'confirmed' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : trade.status === 'failed' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
  const sig = trade.signature
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0">
      <div className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{fmtTime(trade.closedAt ?? trade.openedAt)}</div>
      <div className="hidden w-12 shrink-0 sm:block">
        <Badge variant="outline" className={trade.side === 'BUY' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : trade.side === 'SELL' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-violet-500/40 bg-violet-500/10 text-violet-300'}>
          {trade.side}
        </Badge>
      </div>
      <div className="min-w-0 flex-1 truncate text-xs">
        <span className="font-medium">{trade.inputSymbol}</span>
        <span className="mx-1 text-muted-foreground">→</span>
        <span className="font-medium">{trade.outputSymbol}</span>
      </div>
      <div className={`w-20 shrink-0 text-right text-xs font-semibold tabular-nums ${win ? 'text-emerald-400' : 'text-rose-400'}`}>
        {win ? '+' : ''}{fmtUsd(trade.pnl)}
        <span className="ml-0.5 text-[10px] font-normal opacity-70">({fmtPct(trade.pnlPct)})</span>
      </div>
      <Badge variant="outline" className={`hidden w-20 justify-center gap-1 sm:flex ${statusCls}`}>
        {trade.status === 'confirmed' ? <CheckCircle2 className="size-3" /> : trade.status === 'failed' ? <XCircle className="size-3" /> : <Clock className="size-3" />}
        {trade.status}
      </Badge>
      {sig ? (
        <a href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer" className="w-24 shrink-0 text-right font-mono text-[10px] text-violet-300 underline-offset-2 hover:underline" title={`View ${sig} on Solscan`}>
          {sig.slice(0, 4)}…{sig.slice(-4)}
          <ExternalLink className="ml-1 inline size-2.5" />
        </a>
      ) : (
        <span className="w-24 shrink-0 text-right text-[10px] text-muted-foreground">--</span>
      )}
    </div>
  )
}

export function LiveTradingPanel({ live, wallet }: LiveTradingPanelProps) {
  const [confirmedThisSession, setConfirmedThisSession] = useState(false)
  const [fundUsd, setFundUsd] = useState('5')
  const [fundSol, setFundSol] = useState('0.03')
  const [resetOpen, setResetOpen] = useState(false)
  const [resetText, setResetText] = useState('')

  const stats = live.stats
  const totalPnl = stats?.totalPnl ?? 0
  const winRate = stats?.winRate ?? 0
  const equity = stats?.equity ?? live.config.capital
  const openPositions = stats?.openPositions ?? 0
  const uptimeMs = stats?.uptimeMs ?? 0
  const pnlTone = totalPnl >= 0 ? 'positive' : 'negative'

  const walletConnected = wallet.connected
  const running = live.enabled
  const tw = live.tradingWallet
  const tb = live.tradingBalances
  const funded = live.fundingStatus === 'funded'
  const canStart = walletConnected && funded && (tb?.sol ?? 0) >= 0.001

  const handleStart = () => {
    setConfirmedThisSession(true)
    live.start()
  }

  const handleFund = async () => {
    const usd = parseFloat(fundUsd) || 0
    const sol = parseFloat(fundSol) || 0
    if (usd <= 0 && sol <= 0) return
    await live.fundWallet(usd, sol)
  }

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="size-4 text-rose-400" />
              Fully-Automatic Live
            </CardTitle>
            <CardDescription className="mt-1">
              Fund a $5 trading sub-wallet once &middot; bot signs every swap &middot; <span className="text-emerald-400">zero per-trade approvals</span>
            </CardDescription>
          </div>
          <StatusBadge status={live.status} />
        </div>
      </CardHeader>

      <CardContent className="p-0 pt-3 space-y-4">
        {/* Wallet gate */}
        {!walletConnected && (
          <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-200">
            <AlertTriangle className="!text-amber-400" />
            <AlertDescription>Connect your Phantom wallet (top-right) to generate & fund the trading sub-wallet.</AlertDescription>
          </Alert>
        )}

        {/* Trading sub-wallet status */}
        {walletConnected && tw && (
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <WalletIcon className="size-4 text-violet-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Trading sub-wallet (ephemeral · browser-only)</div>
                  <div className="font-mono text-xs truncate">{tw.publicKey.slice(0, 8)}…{tw.publicKey.slice(-8)}</div>
                </div>
              </div>
              <Badge variant="outline" className={funded ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-500/40 bg-zinc-500/10 text-zinc-300'}>
                {live.fundingStatus === 'funding' ? 'Funding…' : funded ? 'Funded' : live.fundingStatus === 'withdrawing' ? 'Withdrawing…' : 'Not funded'}
              </Badge>
            </div>

            {/* Balances */}
            {tb && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border/40 bg-background/40 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">USDC (capital)</div>
                  <div className="text-sm font-semibold tabular-nums text-emerald-400">${tb.usdc.toFixed(2)}</div>
                </div>
                <div className="rounded-md border border-border/40 bg-background/40 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">SOL (gas)</div>
                  <div className="text-sm font-semibold tabular-nums text-amber-300">{tb.sol.toFixed(4)}</div>
                </div>
              </div>
            )}

            {/* Funding form (shown when not funded) */}
            {!funded && live.fundingStatus !== 'funding' && (
              <div className="space-y-2 rounded-md border border-dashed border-border/60 p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Fund the trading sub-wallet (1 approval)</div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">USDC (trading capital)</Label>
                    <div className="relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                      <Input value={fundUsd} onChange={(e) => setFundUsd(e.target.value)} type="number" min="1" step="1" className="pl-5 h-8 text-sm" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">SOL (for gas)</Label>
                    <Input value={fundSol} onChange={(e) => setFundSol(e.target.value)} type="number" min="0.01" step="0.01" className="h-8 text-sm" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">Main wallet must hold the funded USDC + SOL. After this one approval, the bot runs fully automatic.</p>
                <Button onClick={handleFund} className="w-full h-8 gap-1.5 bg-violet-600 text-white hover:bg-violet-500">
                  <ArrowDownToLine className="size-3.5" />
                  Fund ${fundUsd} USDC + {fundSol} SOL
                </Button>
              </div>
            )}

            {/* Funded actions */}
            {funded && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => live.refreshTradingBalances()} variant="outline" size="sm" className="gap-1.5 h-8">
                  <RefreshCw className="size-3.5" /> Refresh
                </Button>
                <Button onClick={() => live.withdrawFunds()} variant="outline" size="sm" className="gap-1.5 h-8 border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20">
                  <ArrowUpFromLine className="size-3.5" /> Withdraw all
                </Button>
                <Button onClick={() => { setResetText(''); setResetOpen(true) }} variant="outline" size="sm" className="gap-1.5 h-8 border-rose-500/30 bg-rose-500/5 text-rose-300 hover:bg-rose-500/15">
                  Reset wallet
                </Button>
              </div>
            )}

            {/* Reset wallet — DOUBLE confirmation (type RESET to enable) */}
            <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="size-5 text-rose-400" />
                    Delete the trading wallet?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This <strong>permanently deletes</strong> the current trading sub-wallet
                    (<code className="text-xs">{live.tradingWallet?.publicKey?.slice(0, 8) ?? '…'}…</code>)
                    and its server backup. The bot is stopped. Any funds still inside it
                    <strong> can never be recovered</strong>. Withdraw them first!
                    <br />
                    <br />
                    Type <code className="text-xs text-rose-300">RESET</code> to confirm:
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  autoFocus
                  value={resetText}
                  onChange={(e) => setResetText(e.target.value)}
                  placeholder="type RESET"
                  className="h-8 text-sm"
                />
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => { setResetText(''); setResetOpen(false) }}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={resetText.trim().toUpperCase() !== 'RESET'}
                    className="bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-40"
                    onClick={() => { setResetText(''); setResetOpen(false); live.resetTradingWallet() }}
                  >
                    Yes, delete and generate a new wallet
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}

        {/* Start / Stop */}
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button size="lg" variant="destructive" onClick={() => live.stop()} className="gap-2 bg-rose-600 text-white hover:bg-rose-500">
              <Square className="size-4" /> Stop Auto-Trading
            </Button>
          ) : confirmedThisSession ? (
            <Button size="lg" onClick={handleStart} disabled={!canStart} className="gap-2 bg-emerald-600 text-white hover:bg-emerald-500">
              <Play className="size-4" /> Start Auto-Trading
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="lg" disabled={!canStart} className="gap-2 bg-emerald-600 text-white hover:bg-emerald-500">
                  <Play className="size-4" /> Start Auto-Trading
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="flex items-center gap-2">
                    <AlertTriangle className="size-5 text-rose-400" />
                    Enable fully-automatic trading?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The bot will sign and broadcast every swap <strong>automatically</strong> from the funded trading sub-wallet ({(tb?.usdc ?? 0).toFixed(2)} USDC). <strong>No per-trade approvals</strong> — once started, it trades on its own. You can lose the funded amount. Stop the bot anytime. Are you sure?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleStart} className="bg-rose-600 text-white hover:bg-rose-500">
                    I understand, start
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {!canStart && walletConnected && !running && (
            <span className="text-xs text-amber-300">
              {(!funded) ? 'Fund the trading wallet first.' : 'Need ≥0.001 SOL for gas — fund more SOL.'}
            </span>
          )}
        </div>

        {live.error && (
          <Alert className="border-rose-500/30 bg-rose-500/5 text-rose-200">
            <AlertTriangle className="text-rose-400" />
            <AlertDescription>{live.error}</AlertDescription>
          </Alert>
        )}

        {/* Live stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Equity" value={fmtUsd(equity)} sub={`Started ${fmtUsd(live.config.capital)}`} />
          <StatTile label="Growth" value={fmtPct(stats?.totalPnlPct ?? 0)} sub={`${fmtUsd(totalPnl)} profit`} tone={pnlTone} />
          <StatTile label="Next Trade Size" value={fmtUsd((tb?.usdc ?? 0) * (live.config.tradeSizePct / 100))} sub={`${live.config.tradeSizePct}% of $${(tb?.usdc ?? 0).toFixed(2)}`} tone="positive" />
          <StatTile label="Win Rate" value={`${winRate.toFixed(1)}%`} sub={`${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`} tone={winRate >= 50 ? 'positive' : 'default'} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Open Positions" value={String(openPositions)} sub={`Max ${live.config.maxPositions}`} />
          <StatTile label="USDC Balance" value={`$${(tb?.usdc ?? 0).toFixed(2)}`} sub="trading capital" tone="positive" />
          <StatTile label="SOL (gas)" value={`${(tb?.sol ?? 0).toFixed(4)}`} sub="for tx fees" />
          <StatTile label="Uptime" value={fmtDuration(uptimeMs)} sub={`${stats?.scanCount ?? 0} scans`} />
        </div>

        <Separator />

        {/* Config quick controls */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Strategy Config</h3>
            <Badge variant="outline" className="text-[10px] border-emerald-500/40 bg-emerald-500/10 text-emerald-300">↗ compound interest</Badge>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CONTROLS.map((c) => {
              const val = live.config[c.key] as number
              const maxTradeUsd = c.key === 'tradeSizePct' ? (val / 100) * (tb?.usdc ?? live.config.capital) : 0
              return (
                <div key={c.key} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">{c.label}</Label>
                    <Badge variant="outline" className="tabular-nums text-[10px]">
                      {c.format ? c.format(val) : c.key === 'tradeSizePct' ? `${val}${c.unit} ≈ ${fmtUsd(maxTradeUsd)}` : `${val}${c.unit ? ` ${c.unit}` : ''}`}
                    </Badge>
                  </div>
                  <Slider value={[val]} min={c.min} max={c.max} step={c.step} onValueChange={([v]) => live.updateConfig({ [c.key]: v } as never)} disabled={running} />
                  {c.key === 'tradeSizePct' && (
                    <p className="text-[10px] text-emerald-400/80">↗ Scales with current balance — bigger trades as you profit.</p>
                  )}
                  {running && c.key !== 'tradeSizePct' && <p className="text-[10px] text-muted-foreground">Stop the bot to adjust.</p>}
                </div>
              )
            })}
          </div>
        </div>

        <Separator />

        {/* Recent live trades */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent Live Trades (on-chain)</h3>
            <Badge variant="outline" className="text-[10px]">{live.trades.length} total</Badge>
          </div>
          <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60">
            {live.trades.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No live trades yet — fund $5 & start the bot.
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {live.trades.slice(0, 30).map((t, i) => (
                  <motion.div key={t.id || `lt-${i}`} layout initial={{ opacity: 0, y: -8, backgroundColor: 'rgba(244,63,94,0.10)' }} animate={{ opacity: 1, y: 0, backgroundColor: 'rgba(0,0,0,0)' }} transition={{ duration: 0.35 }}>
                    <LiveTradeRow trade={t} />
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Engine Log</h3>
          <div className="max-h-40 overflow-y-auto scrollbar-thin rounded-md border border-border/60 bg-black/40 p-2 font-mono text-[10px] leading-relaxed">
            {live.logs.length === 0 ? (
              <div className="text-muted-foreground">No logs yet.</div>
            ) : (
              live.logs.slice(0, 50).map((l, i) => (
                <div key={`${l.time}-${i}`} className={l.level === 'error' ? 'text-rose-400' : l.level === 'warn' ? 'text-amber-300' : l.level === 'trade' ? 'text-emerald-300' : 'text-muted-foreground'}>
                  <span className="opacity-50">{fmtTime(l.time)}</span> {l.msg}
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
