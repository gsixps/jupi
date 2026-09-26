'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useWallet } from '@/hooks/use-wallet'
import { useLiveTrading } from '@/hooks/use-live-trading'
import { usePaperTrading } from '@/hooks/use-paper-trading'
import { ModeToggle, type TradingMode } from '@/components/trading/ModeToggle'
import { WalletConnect } from '@/components/trading/WalletConnect'
import { LiveTradingPanel } from '@/components/trading/LiveTradingPanel'
import { LiveTradeFeed } from '@/components/trading/LiveTradeFeed'
import { LiveOpenPositions } from '@/components/trading/LiveOpenPositions'
import { LivePriceGrid } from '@/components/trading/LivePriceGrid'
import { LiveEquityChart } from '@/components/trading/LiveEquityChart'
import { LiveArbitrageScanner } from '@/components/trading/LiveArbitrageScanner'
import { LiveHeader } from '@/components/trading/LiveHeader'
import { PaperHeader } from '@/components/trading/PaperHeader'
import { PaperTradingPanel } from '@/components/trading/PaperTradingPanel'
import { Wifi, WifiOff, Terminal } from 'lucide-react'
import { fmtTime } from '@/lib/format'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

/** Compact log panel that takes logs as props (used in Paper mode bottom). */
function PaperLogPanel({
  logs,
}: {
  logs: { time: number; msg: string; level: 'info' | 'warn' | 'error' | 'trade' }[]
}) {
  return (
    <Card className="p-4 md:p-5">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Terminal className="size-4 text-emerald-400" />
          Engine Log
          <span className="ml-auto text-[10px] font-normal text-muted-foreground">
            {logs.length} lines
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 pt-2">
        <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-md border border-border/60 bg-black/40 p-2 font-mono text-[10px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="flex h-20 items-center justify-center font-mono text-[11px] text-muted-foreground">
              waiting for engine output…
            </div>
          ) : (
            logs.slice(0, 80).map((entry, i) => (
              <div
                key={`${entry.time}-${i}`}
                className={
                  entry.level === 'error'
                    ? 'text-rose-400'
                    : entry.level === 'warn'
                      ? 'text-amber-300'
                      : entry.level === 'trade'
                        ? 'text-emerald-300'
                        : 'text-muted-foreground'
                }
              >
                <span className="opacity-50">{fmtTime(entry.time)}</span>{' '}
                {entry.msg}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function DashboardInner() {
  const [mode, setMode] = useState<TradingMode>('paper')

  // All three hooks must always be called (rules of hooks) regardless of mode.
  //  - wallet: Phantom wallet (used only in Live mode)
  //  - live:   real on-chain bot (used only in Live mode)
  //  - paper:  client-side paper bot (used only in Paper mode) — REAL Jupiter
  //            data, fictional capital. NO socket dependency.
  const wallet = useWallet()
  const live = useLiveTrading(wallet)
  const paper = usePaperTrading()

  // ============ LIVE MODE ============
  if (mode === 'live') {
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <LiveHeader live={live} wallet={wallet} />

        <main className="flex-1">
          <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
            <ModeToggle mode={mode} setMode={setMode} />

            {/* 2-column layout: panel left, wallet+positions+equity right */}
            <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <LiveTradingPanel live={live} wallet={wallet} />
              </div>
              <div className="flex flex-col gap-4 md:gap-6">
                <WalletConnect wallet={wallet} prices={live.prices} />
                <LiveOpenPositions
                  positions={live.positions}
                  prices={live.prices}
                />
                <LiveEquityChart
                  equity={live.equityCurve}
                  currentEquity={live.stats?.equity ?? live.config.capital}
                  capital={live.config.capital}
                />
              </div>
            </div>

            {/* Live prices + live trade feed */}
            <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <LivePriceGrid
                  tokens={live.tokens}
                  prices={live.prices}
                  change24h={live.change24h}
                  priceHistory={live.priceHistory}
                />
              </div>
              <div className="lg:col-span-1">
                <LiveTradeFeed trades={live.trades} />
              </div>
            </div>
          </div>
        </main>

        <footer className="mt-auto border-t border-rose-500/20 bg-background/60 py-4 backdrop-blur">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-center px-4 md:px-6">
            <p className="max-w-4xl text-center text-[10px] leading-relaxed text-muted-foreground/80">
              ⚠️ REAL MONEY · FULLY AUTOMATIC — You fund a dedicated trading
              sub-wallet with ~$5 (one Phantom approval). After that, the bot
              signs and broadcasts every swap automatically with no popups.
              Risk is strictly limited to the funded amount — your main wallet
              is never touched. Real Solana network fees (~0.000005 SOL/tx)
              apply. The strategies are basic and compete with professional
              MEV/HFT bots; you can lose the $5. Past performance does not
              guarantee future results.
            </p>
          </div>
        </footer>
      </div>
    )
  }

  // ============ PAPER MODE (client-side bot, REAL Jupiter data) ============
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <PaperHeader paper={paper} />

      <main className="flex-1">
        <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:space-y-6 md:p-6">
          <ModeToggle mode={mode} setMode={setMode} />

          {/* 2-column: paper control panel (left) + positions + equity (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <PaperTradingPanel paper={paper} />
            </div>
            <div className="flex flex-col gap-4 md:gap-6">
              <LiveOpenPositions
                positions={paper.positions}
                prices={paper.prices}
              />
              <LiveEquityChart
                equity={paper.equityCurve}
                currentEquity={paper.stats?.equity ?? paper.config.capital}
                capital={paper.config.capital}
              />
            </div>
          </div>

          {/* Real prices (left, wide) + arb scanner (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <LivePriceGrid
                tokens={paper.tokens}
                prices={paper.prices}
                change24h={paper.change24h}
                priceHistory={paper.priceHistory}
              />
            </div>
            <div className="lg:col-span-1">
              <LiveArbitrageScanner
                arbitrage={paper.arbitrage}
                stats={paper.stats}
                title="Arbitrage Scanner"
                subtitle="Real triangular arb · live Jupiter quotes"
              />
            </div>
          </div>

          {/* Trade feed (left, wide) + logs (right) */}
          <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <LiveTradeFeed trades={paper.trades} />
            </div>
            <div className="lg:col-span-1">
              <PaperLogPanel logs={paper.logs} />
            </div>
          </div>
        </div>
      </main>

      <footer className="mt-auto border-t border-emerald-500/20 bg-background/60 py-4 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-2 px-4 md:px-6">
          <p className="max-w-4xl text-center text-[10px] leading-relaxed text-muted-foreground/80">
            🧪 DEMO · REAL JUPITER MARKET DATA — Demo mode runs with real Jupiter
            prices, swap quotes and P&amp;L fetched live from the browser. Capital
            is fictional; no real funds are at risk. This reflects what would
            happen with real money at real market rates — past performance does
            not guarantee future results.
          </p>
          <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground md:flex-row md:w-full">
            <div className="flex items-center gap-1.5">
              <span>Built with Jupiter Price API + Jupiter Swap API v6</span>
              <span className="opacity-40">•</span>
              <span className="text-emerald-300">REAL market data</span>
              <span className="opacity-40">•</span>
              <span>Fictional capital</span>
            </div>
            <div className="flex items-center gap-1.5">
              {paper.enabled ? (
                <>
                  <Wifi className="size-3 text-emerald-400" />
                  <span className="text-emerald-300">
                    Client-side bot running · {paper.scanCount} scans
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

export default function Home() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <DashboardInner />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
