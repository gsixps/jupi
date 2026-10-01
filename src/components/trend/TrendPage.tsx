'use client'

import { Wifi, WifiOff } from 'lucide-react'

import { BotTabs } from '@/components/trading/BotTabs'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { TrendPanel } from '@/components/trend/TrendPanel'
import type { TrendBot } from '@/hooks/use-trend'

/** Shared layout of the Bitcoin and Eth tabs (trend-following bot). */
export function TrendPage({ bot }: { bot: TrendBot }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {bot.dataSource === 'live' ? (
                <Wifi className="size-3 text-emerald-400" />
              ) : (
                <WifiOff className="size-3 text-amber-400" />
              )}
              {bot.meta.name} · seguimiento de tendencia ·{' '}
              {bot.dataSource === 'live' ? 'velas reales de Binance' : bot.enabled ? 'esperando a Binance' : 'pulsa Arrancar'}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <TrendPanel bot={bot} />
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveEquityChart
                equity={bot.equityCurve}
                currentEquity={bot.stats.equityUsd}
                capital={bot.capitalUsd}
              />
            </div>
          </div>
        </div>
      </main>

      <footer className="mt-auto border-t border-amber-500/20 bg-background/60 py-4 backdrop-blur">
        <p className="mx-auto max-w-4xl px-4 text-center text-[10px] leading-relaxed text-muted-foreground/80">
          Estrategia de seguimiento de tendencia en {bot.meta.symbol}: compra en rupturas alcistas con la tendencia a
          favor y sale cuando la tendencia se rompe. Acierta menos de la mitad de las veces y vive de que las
          ganancias sean mayores que las pérdidas; puede pasar meses en pérdidas. La demo usa precios reales de
          Binance con comisiones y deslizamiento. El backtest muestra el pasado, no garantiza el futuro.
        </p>
      </footer>
    </div>
  )
}
