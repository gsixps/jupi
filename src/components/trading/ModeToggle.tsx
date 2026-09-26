'use client'

import { FlaskConical, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'

export type TradingMode = 'paper' | 'live'

interface ModeToggleProps {
  mode: TradingMode
  setMode: (m: TradingMode) => void
}

/**
 * Segmented control to switch between Demo (simulated)
 * and Live (real on-chain swaps via Phantom + Jupiter).
 */
export function ModeToggle({ mode, setMode }: ModeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Trading mode"
      className="inline-flex w-full max-w-md items-center gap-1 rounded-lg border border-border bg-muted/60 p-1 sm:w-auto"
    >
      <button
        role="tab"
        aria-selected={mode === 'paper'}
        type="button"
        onClick={() => setMode('paper')}
        className={cn(
          'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-all sm:flex-none',
          mode === 'paper'
            ? 'bg-background text-emerald-400 shadow-sm ring-1 ring-emerald-500/30'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <FlaskConical className="size-3.5" />
        Demo
      </button>
      <button
        role="tab"
        aria-selected={mode === 'live'}
        type="button"
        onClick={() => setMode('live')}
        className={cn(
          'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-all sm:flex-none',
          mode === 'live'
            ? 'bg-rose-500/15 text-rose-300 shadow-sm ring-1 ring-rose-500/40'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Zap className="size-3.5" />
        Live
      </button>
    </div>
  )
}
