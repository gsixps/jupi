'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotTabs } from '@/components/trading/BotTabs'
import { useCurveBot } from '@/hooks/use-curve'
import { CurveHeader } from '@/components/curve/CurveHeader'
import { CurveTradingPanel } from '@/components/curve/CurveTradingPanel'
import { CurveMarketGrid } from '@/components/curve/CurveMarketGrid'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { Wifi, WifiOff } from 'lucide-react'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

function CurveInner() {
  const curve = useCurveBot()

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <CurveHeader curve={curve} />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BotTabs />
            <p className="text-[11px] text-muted-foreground">
              Curve Finance &middot; buy cheap, sell expensive &middot;{` `}
              {curve.dataSource === 'live' ? 'live curve.finance API' : 'demo engine'}
            </p>
          </div>

          {/* 2-column: control panel (left) + equity (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <CurveTradingPanel curve={curve} />
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveEquityChart
                equity={curve.equityCurve}
                currentEquity={curve.stats?.equityUsd ?? curve.config.capitalUsd}
                capital={curve.config.capitalUsd}
              />
            </div>
          </div>

          {/* Pool quotes (full width) */}
          <CurveMarketGrid curve={curve} />
        </div>
      </main>

      <footer className="mt-auto border-t border-blue-500/20 bg-background/60 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-2 px-4 md:px-6">
          <p className="max-w-4xl text-center text-[10px] leading-relaxed text-muted-foreground/80">
            🌊 DEMO · STABLECOIN ARBITRAGE — the bot reads implied USD prices
            from the Curve Finance API (api.curve.fi) and trades buy-cheap /
            sell-expensive spreads across stable pools. If the API is
            unreachable it falls back to a deterministic demo engine. Capital is
            fictional; no real funds are at risk. Past performance does not
            guarantee future results.
          </p>
          <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground md:flex-row md:w-full">
            <div className="flex items-center gap-1.5">
              <span>Built on the curve.finance API</span>
              <span className="opacity-40">•</span>
              <span className="text-blue-300">buy cheap · sell expensive</span>
              <span className="opacity-40">•</span>
              <span>Fictional USD capital</span>
            </div>
            <div className="flex items-center gap-1.5">
              {curve.dataSource === 'live' ? (
                <>
                  <Wifi className="size-3 text-emerald-400" />
                  <span className="text-emerald-300">
                    Live curve.finance data · {curve.scanCount} scans
                  </span>
                </>
              ) : (
                <>
                  <WifiOff className="size-3 text-amber-400" />
                  <span className="text-amber-300">
                    {curve.enabled
                      ? `Demonstrated with demo data · ${curve.scanCount} scans`
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

export default function CurvePage() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <CurveInner />
      </TooltipProvider>
    </QueryClientProvider>
  )
}