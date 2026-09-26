'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotTabs } from '@/components/trading/BotTabs'
import { useCoinBot } from '@/hooks/use-coin'
import { CoinHeader } from '@/components/coin/CoinHeader'
import { CoinTradingPanel } from '@/components/coin/CoinTradingPanel'
import { CoinMarketGrid } from '@/components/coin/CoinMarketGrid'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { Wifi, WifiOff } from 'lucide-react'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

function BitcoinInner() {
  const bot = useCoinBot('btc')

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <CoinHeader bot={bot} />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">
              Bitcoin &middot; buy cheap, sell expensive, accumulate BTC &middot;{` `}
              {bot.dataSource === 'live' ? 'live binance API' : 'demo engine'}
            </p>
          </div>

          {/* 2-column: control panel (left) + equity (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <CoinTradingPanel bot={bot} />
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveEquityChart
                equity={bot.equityCurve}
                currentEquity={bot.stats?.equityUsd ?? bot.capitalUsd}
                capital={bot.capitalUsd}
              />
            </div>
          </div>

          {/* BTC pair quotes (full width) */}
          <CoinMarketGrid bot={bot} />
        </div>
      </main>

      <footer className="mt-auto border-t border-amber-500/20 bg-background/60 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-2 px-4 md:px-6">
          <p className="max-w-4xl text-center text-[10px] leading-relaxed text-muted-foreground/80">
            🟠 DEMO · BITCOIN ACCUMULATION — the bot trades BTC against USDT,
            USDC and FDUSD on Binance, buying on the cheapest pair and selling
            on the dearest to NET +BTC every cycle. Open lots ARE the stored
            coins. If the API is unreachable it falls back to a deterministic
            demo engine. Capital is fictional; no real funds are at risk. Past
            performance does not guarantee future results.
          </p>
          <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground md:flex-row md:w-full">
            <div className="flex items-center gap-1.5">
              <span>Built on the binance.com API</span>
              <span className="opacity-40">•</span>
              <span className="text-amber-300">buy cheap · sell expensive · accumulate BTC</span>
              <span className="opacity-40">•</span>
              <span>Fictional USD capital</span>
            </div>
            <div className="flex items-center gap-1.5">
              {bot.dataSource === 'live' ? (
                <>
                  <Wifi className="size-3 text-emerald-400" />
                  <span className="text-emerald-300">
                    Live binance data · {bot.scanCount} scans
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="size-3 text-amber-400" />
                  <span className="text-amber-300">
                    {bot.enabled
                      ? `Demonstrated with demo data · ${bot.scanCount} scans`
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

export default function BitcoinPage() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <BitcoinInner />
      </TooltipProvider>
    </QueryClientProvider>
  )
}