'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotTabs } from '@/components/trading/BotTabs'
import { useBybitBotContext } from '@/components/trading/BotsProvider'
import { BybitHeader } from '@/components/bybit/BybitHeader'
import { BybitTradingPanel } from '@/components/bybit/BybitTradingPanel'
import { BybitMarketGrid } from '@/components/bybit/BybitMarketGrid'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { Wifi, WifiOff } from 'lucide-react'
import { BYBIT_RWA_PAIRS } from '@/lib/bybit'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

function BybitInner() {
  const bybit = useBybitBotContext()
  const realMode = bybit.config.liveTrading

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <BybitHeader bybit={bybit} />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">
              Bybit RWA &middot; xStocks vs TradFi perps &middot;{` `}
              {realMode
                ? 'REAL capital · real orders'
                : bybit.dataSource === 'live'
                  ? 'live api.bybit.com'
                  : 'demo engine'}
            </p>
          </div>

          {/* 2-column: control panel (left) + equity (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <BybitTradingPanel bybit={bybit} />
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveEquityChart
                equity={bybit.equityCurve}
                currentEquity={bybit.stats?.equityUsd ?? bybit.config.capitalUsd}
                capital={bybit.config.capitalUsd}
              />
            </div>
          </div>

          {/* RWA shelf + signals + log (full width) */}
          <BybitMarketGrid bybit={bybit} />
        </div>
      </main>

      <footer className="mt-auto border-t border-orange-500/20 bg-background/60 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-2 px-4 md:px-6">
          <p className="max-w-4xl text-center text-[10px] leading-relaxed text-muted-foreground/80">
            🏦 DEMO · RWA BASIS ARBITRAGE — the bot reads live quotes from the
            public Bybit V5 API (api.bybit.com/v5/market/tickers) for{' '}
            {BYBIT_RWA_PAIRS.length} tokenized real-world assets, pairing every
            1:1-backed xStock on Spot with the TradFi linear perp on the same
            underlying. When the two quotes diverge it opens a market-neutral
            hedge (buy the xStock and short the perp, or the reverse) so only the
            basis convergence is left as P&amp;L. If the API is unreachable it
            falls back to a deterministic demo engine. In demo the capital is
            fictional and no orders are placed — no real funds are at risk. Turn
            on real mode to trade with your own Bybit API keys and real capital.
            Past performance does not guarantee future results.
          </p>
          <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground md:flex-row md:w-full">
            <div className="flex items-center gap-1.5">
              <span>Built on the Bybit public V5 API</span>
              <span className="opacity-40">•</span>
              <span className="text-orange-300">{BYBIT_RWA_PAIRS.length} RWA pairs</span>
              <span className="opacity-40">•</span>
              <span>
                {realMode ? 'Real capital' : 'Fictional USD capital'}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {bybit.dataSource === 'live' ? (
                <>
                  <Wifi className="size-3 text-emerald-400" />
                  <span className="text-emerald-300">
                    Live api.bybit.com data · {bybit.scanCount} scans
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="size-3 text-amber-400" />
                  <span className="text-amber-300">
                    {bybit.enabled
                      ? `Demonstrated with demo data · ${bybit.scanCount} scans`
                      : 'Demo engine ready · click Start'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default function BybitPage() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <BybitInner />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
