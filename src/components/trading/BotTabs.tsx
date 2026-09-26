'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Zap, Ship, ChartNoAxesCombined, Coins, Bitcoin, Gem, Rocket } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Top-level bot switcher — Jupiter Bot (Solana arb), SeaBot (NFT buy-low /
 * sell-high), Curve Finance (stablecoin arb), Binance (triangle arb), Bitcoin
 * & Ethereum (coin accumulation arb) and PumpFun (meme-coin hunting). Each bot
 * lives at its own route; this tab bar navigates between dashboards.
 */
export function BotTabs() {
  const pathname = usePathname()
  const seabot = pathname === '/dashboard/seabot'
  const curve = pathname === '/dashboard/curve'
  const binance = pathname === '/dashboard/binance'
  const bitcoin = pathname === '/dashboard/bitcoin'
  const eth = pathname === '/dashboard/eth'
  const pumpfun = pathname === '/dashboard/pumpfun'
  const home = !seabot && !curve && !binance && !bitcoin && !eth && !pumpfun

  const base =
    'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-all sm:flex-none'

  return (
    <div
      role="tablist"
      aria-label="Bot"
      className="inline-flex w-full max-w-5xl flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/60 p-1 sm:w-auto sm:flex-nowrap"
    >
      <Link
        role="tab"
        aria-selected={home}
        href="/dashboard"
        className={cn(
          base,
          home
            ? 'bg-background text-emerald-400 shadow-sm ring-1 ring-emerald-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Zap className="size-3.5" />
        Jupiter Bot
      </Link>
      <Link
        role="tab"
        aria-selected={seabot}
        href="/dashboard/seabot"
        className={cn(
          base,
          seabot
            ? 'bg-background text-cyan-400 shadow-sm ring-1 ring-cyan-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Ship className="size-3.5" />
        SeaBot
      </Link>
      <Link
        role="tab"
        aria-selected={curve}
        href="/dashboard/curve"
        className={cn(
          base,
          curve
            ? 'bg-background text-blue-400 shadow-sm ring-1 ring-blue-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <ChartNoAxesCombined className="size-3.5" />
        Curve Finance
      </Link>
      <Link
        role="tab"
        aria-selected={binance}
        href="/dashboard/binance"
        className={cn(
          base,
          binance
            ? 'bg-background text-amber-400 shadow-sm ring-1 ring-amber-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Coins className="size-3.5" />
        Binance
      </Link>
      <Link
        role="tab"
        aria-selected={bitcoin}
        href="/dashboard/bitcoin"
        className={cn(
          base,
          bitcoin
            ? 'bg-background text-orange-400 shadow-sm ring-1 ring-orange-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Bitcoin className="size-3.5" />
        Bitcoin
      </Link>
      <Link
        role="tab"
        aria-selected={eth}
        href="/dashboard/eth"
        className={cn(
          base,
          eth
            ? 'bg-background text-violet-400 shadow-sm ring-1 ring-violet-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Gem className="size-3.5" />
        Eth
      </Link>
      <Link
        role="tab"
        aria-selected={pumpfun}
        href="/dashboard/pumpfun"
        className={cn(
          base,
          pumpfun
            ? 'bg-background text-fuchsia-400 shadow-sm ring-1 ring-fuchsia-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Rocket className="size-3.5" />
        PumpFun
      </Link>
    </div>
  )
}