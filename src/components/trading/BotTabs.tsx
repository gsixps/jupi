'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Zap,
  Ship,
  ChartNoAxesCombined,
  Coins,
  Bitcoin,
  Gem,
  Rocket,
  Anchor,
  Building2,
  PiggyBank,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBotStatusContext, type BotStatusMap } from '@/components/trading/BotsProvider'

type BotKey = keyof BotStatusMap

/**
 * Top-level bot switcher. Every bot is registered once in <BotsProvider> at the
 * root layout, so a bot started here keeps working while you browse another
 * tab — the pulsing dot marks a running bot and the red mark means it is
 * trading real capital with real orders.
 */
export function BotTabs() {
  const pathname = usePathname()
  const status = useBotStatusContext()

  const current =
    pathname === '/dashboard/seabot'
      ? 'seabot'
      : pathname === '/dashboard/curve'
        ? 'curve'
        : pathname === '/dashboard/binance'
          ? 'binance'
          : pathname === '/dashboard/bitcoin'
            ? 'bitcoin'
            : pathname === '/dashboard/eth'
              ? 'eth'
              : pathname === '/dashboard/pumpfun'
                ? 'pumpfun'
                : pathname === '/dashboard/kraken'
                  ? 'kraken'
                  : pathname === '/dashboard/bybit'
                    ? 'bybit'
                    : pathname === '/dashboard/carry'
                      ? 'carry'
                      : 'jupiter'

  const running = Object.values(status).filter((s) => s.running).length
  const liveCount = Object.values(status).filter((s) => s.running && s.real).length

  const base =
    'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-all sm:flex-none'

  return (
    <div className="space-y-1">
      <div
        role="tablist"
        aria-label="Bot"
        className="inline-flex w-full max-w-6xl flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/60 p-1 sm:w-auto sm:flex-nowrap"
      >
        <TabLink href="/dashboard" base={base} active={current === 'jupiter'} status={status.jupiter}>
          <Zap className="size-3.5" />
          Jupiter Bot
        </TabLink>
        <TabLink href="/dashboard/seabot" base={base} active={current === 'seabot'} status={status.seabot}>
          <Ship className="size-3.5" />
          SeaBot
        </TabLink>
        <TabLink href="/dashboard/curve" base={base} active={current === 'curve'} status={status.curve}>
          <ChartNoAxesCombined className="size-3.5" />
          Curve Finance
        </TabLink>
        <TabLink href="/dashboard/binance" base={base} active={current === 'binance'} status={status.binance}>
          <Coins className="size-3.5" />
          Binance
        </TabLink>
        <TabLink href="/dashboard/bitcoin" base={base} active={current === 'bitcoin'} status={status.bitcoin}>
          <Bitcoin className="size-3.5" />
          Bitcoin
        </TabLink>
        <TabLink href="/dashboard/eth" base={base} active={current === 'eth'} status={status.eth}>
          <Gem className="size-3.5" />
          Eth
        </TabLink>
        <TabLink href="/dashboard/pumpfun" base={base} active={current === 'pumpfun'} status={status.pumpfun}>
          <Rocket className="size-3.5" />
          PumpFun
        </TabLink>
        <TabLink href="/dashboard/kraken" base={base} active={current === 'kraken'} status={status.kraken}>
          <Anchor className="size-3.5" />
          Kraken
        </TabLink>
        <TabLink href="/dashboard/bybit" base={base} active={current === 'bybit'} status={status.bybit}>
          <Building2 className="size-3.5" />
          Bybit
        </TabLink>
        <TabLink href="/dashboard/carry" base={base} active={current === 'carry'} status={status.carry}>
          <PiggyBank className="size-3.5" />
          Rendimiento
        </TabLink>
      </div>

      {running > 0 && (
        <p className="px-1 text-[10px] text-muted-foreground">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400 align-middle" />{' '}
          {running} bot{running > 1 ? 's' : ''} corriendo en segundo plano
          {liveCount > 0 && (
            <span className="ml-2 text-rose-400">
              · {liveCount} con capital real
            </span>
          )}
        </p>
      )}
    </div>
  )
}

function TabLink({
  href,
  base,
  active,
  status,
  children,
}: {
  href: string
  base: string
  active: boolean
  status: { running: boolean; real: boolean } | undefined
  children: React.ReactNode
}) {
  return (
    <Link
      role="tab"
      aria-selected={active}
      href={href}
      className={cn(
        base,
        active
          ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
          : 'text-muted-foreground hover:text-foreground',
        status?.running && !active && 'text-foreground',
      )}
    >
      {children}
      {status?.running && (
        <span
          className={cn(
            'size-1.5 shrink-0 animate-pulse rounded-full',
            status.real ? 'bg-rose-400' : 'bg-emerald-400',
          )}
          title={status.real ? 'Running with REAL capital' : 'Running in demo'}
        />
      )}
    </Link>
  )
}
