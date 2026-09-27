'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotTabs } from '@/components/trading/BotTabs'
import { useBinanceBotContext } from '@/components/trading/BotsProvider'
import { BinanceHeader } from '@/components/binance/BinanceHeader'
import { BinanceTradingPanel } from '@/components/binance/BinanceTradingPanel'
import { BinanceMarketGrid } from '@/components/binance/BinanceMarketGrid'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { Wifi, WifiOff } from 'lucide-react'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

function BinanceInner() {
  const binance = useBinanceBotContext()

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <BinanceHeader binance={binance} />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">
              Binance &middot; buy cheap, sell expensive &middot;{` `}
              {binance.dataSource === 'live' ? 'live binance.com API' : 'demo engine'}
            </p>
          </div>

          {/* 2-column: control panel (left) + equity (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <BinanceTradingPanel binance={binance} />
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveEquityChart
                equity={binance.equityCurve}
                currentEquity={binance.stats?.equityUsd ?? binance.config.capitalUsd}
                capital={binance.config.capitalUsd}
              />
            </div>
          </div>

          {/* Routes + spot watchlist (full width) */}
          <BinanceMarketGrid binance={binance} />
        </div>
      </main>

      <footer className="mt-auto border-t border-amber-500/20 bg-background/60 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-2 px-4 md:px-6">
          <p className="max-w-4xl text-center text-[10px] leading-relaxed text-muted-foreground/80">
            🪙 DEMO · TRIANGLE ARBITRAGE — the bot reads live prices from the
            Binance API (api.binance.com/api/v3/ticker/price) and trades
            buy-cheap / sell-expensive divergences between direct and implied
            USD quotes. If the API is unreachable it falls back to a
            deterministic demo engine. Capital is fictional; no real orders are
            placed — no real funds are at risk. Past performance does not
            guarantee future results.
          </p>
          <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground md:flex-row md:w-full">
            <div className="flex items-center gap-1.5">
              <span>Built on the binance.com API</span>
              <span className="opacity-40">•</span>
              <span className="text-amber-300">buy cheap · sell expensive</span>
              <span className="opacity-40">•</span>
              <span>Fictional USD capital</span>
            </div>
            <div className="flex items-center gap-1.5">
              {binance.dataSource === 'live' ? (
                <>
                  <Wifi className="size-3 text-emerald-400" />
                  <span className="text-emerald-300">
                    Live binance.com data · {binance.scanCount} scans
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="size-3 text-amber-400" />
                  <span className="text-amber-300">
                    {binance.enabled
                      ? `Demonstrated with demo data · ${binance.scanCount} scans`
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

export default function BinancePage() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <BinanceInner />
      </TooltipProvider>
    </QueryClientProvider>
  )
}