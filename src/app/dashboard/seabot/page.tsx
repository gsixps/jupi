'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotTabs } from '@/components/trading/BotTabs'
import { useSeabot } from '@/hooks/use-seabot'
import { SeabotHeader } from '@/components/seabot/SeabotHeader'
import { SeabotTradingPanel } from '@/components/seabot/SeabotTradingPanel'
import { SeabotMarketGrid } from '@/components/seabot/SeabotMarketGrid'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { ETH_USD_PRICE } from '@/lib/seabot'
import { Wifi, WifiOff } from 'lucide-react'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

function SeabotInner() {
  const seabot = useSeabot()

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SeabotHeader seabot={seabot} />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">
              SeaBot &middot; NFT buy-low / sell-high &middot; mock floor engine
            </p>
          </div>

          {/* 2-column: control panel (left) + equity (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SeabotTradingPanel seabot={seabot} />
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveEquityChart
                equity={seabot.equityCurve.map((e) => ({
                  ...e,
                  equity: e.equity * ETH_USD_PRICE,
                  balance: e.balance * ETH_USD_PRICE,
                  openPnl: e.openPnl * ETH_USD_PRICE,
                }))}
                currentEquity={(seabot.stats?.equityEth ?? seabot.config.capitalEth) * ETH_USD_PRICE}
                capital={seabot.config.capitalEth * ETH_USD_PRICE}
              />
            </div>
          </div>

          {/* Floor prices (full width) */}
          <SeabotMarketGrid seabot={seabot} />
        </div>
      </main>

      <footer className="mt-auto border-t border-cyan-500/20 bg-background/60 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-2 px-4 md:px-6">
          <p className="max-w-4xl text-center text-[10px] leading-relaxed text-muted-foreground/80">
            ⚓ DEMO · MOCK FLOOR ENGINE — SeaBot runs entirely in your browser
            with a deterministic floor-price generator (the seabot project's
            demo data layer — no OpenSea API key required). Capital is
            fictional; no real funds are at risk. Every P&amp;L reflects what
            would have happened at the simulated market rate — past performance
            does not guarantee future results.
          </p>
          <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground md:flex-row md:w-full">
            <div className="flex items-center gap-1.5">
              <span>Built on the SeaSniper / seabot methodology</span>
              <span className="opacity-40">•</span>
              <span className="text-cyan-300">buy low · sell high</span>
              <span className="opacity-40">•</span>
              <span>Fictional ETH capital</span>
            </div>
            <div className="flex items-center gap-1.5">
              {seabot.enabled ? (
                <>
                  <Wifi className="size-3 text-emerald-400" />
                  <span className="text-emerald-300">
                    Client-side bot running · {seabot.scanCount} scans
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="size-3 text-amber-400" />
                  <span className="text-amber-300">Bot stopped · click Start</span>
                </>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default function SeabotPage() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <SeabotInner />
      </TooltipProvider>
    </QueryClientProvider>
  )
}