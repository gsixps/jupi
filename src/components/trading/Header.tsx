'use client'

import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { Bot, Settings, TrendingUp, TrendingDown, Wifi, WifiOff, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTradingStore } from '@/lib/store'
import { fmtUsd, fmtPct } from '@/lib/format'

export function Header() {
  const connected = useTradingStore((s) => s.connected)
  const stats = useTradingStore((s) => s.stats)
  const config = useTradingStore((s) => s.config)
  const startBot = useTradingStore((s) => s.startBot)
  const stopBot = useTradingStore((s) => s.stopBot)
  const onOpenConfig = () => {
    window.dispatchEvent(new CustomEvent('open-config'))
  }

  // Keyboard shortcut: pressing "c" opens the config panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return
        }
        onOpenConfig()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const running = stats?.running ?? config.running
  const equity = stats?.equity ?? config.capital
  const totalPnl = stats?.totalPnl ?? 0
  const totalPnlPct = stats?.totalPnlPct ?? 0
  const pnlPositive = totalPnl >= 0

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            <Bot className="size-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight md:text-base">
              Jupiter Bot
            </h1>
            <p className="hidden text-[11px] text-muted-foreground sm:block">
              Automated mean-reversion &amp; arbitrage on Solana
            </p>
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 md:gap-4">
          {/* Equity + P&L */}
          <div className="hidden items-end gap-4 sm:flex">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Equity
              </div>
              <motion.div
                key={equity.toFixed(2)}
                initial={{ opacity: 0.6, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className="text-base font-semibold tabular-nums"
              >
                {fmtUsd(equity)}
              </motion.div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total P&amp;L
              </div>
              <motion.div
                key={totalPnl.toFixed(2)}
                initial={{ opacity: 0.6, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`flex items-center gap-1 text-base font-semibold tabular-nums ${
                  pnlPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {pnlPositive ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
                {fmtUsd(totalPnl)} <span className="text-xs">({fmtPct(totalPnlPct)})</span>
              </motion.div>
            </div>
          </div>

          {/* Connection badge */}
          <Badge
            variant="outline"
            className={
              connected
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-400'
            }
          >
            {connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
            {connected ? 'LIVE' : 'OFFLINE'}
          </Badge>

          {/* Start / Stop */}
          {running ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={stopBot}
              disabled={!connected}
              className="gap-1.5"
            >
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={startBot}
              disabled={!connected}
              className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
            >
              <Play className="size-3.5" /> Start
            </Button>
          )}

          {/* Settings */}
          <Button
            size="icon"
            variant="outline"
            onClick={onOpenConfig}
            aria-label="Open settings"
          >
            <Settings className="size-4" />
          </Button>
        </div>
      </div>
    </header>
  )
}
