'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RotateCcw, Save, Settings, Zap } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useTradingStore } from '@/lib/store'
import { DEFAULT_CONFIG, type BotConfig, type TokenInfo } from '@/lib/trading-types'

interface NumericField {
  key: keyof BotConfig
  label: string
  description: string
  min: number
  max: number
  step: number
  unit?: string
  format?: (v: number) => string
}

const NUMERIC_FIELDS: NumericField[] = [
  {
    key: 'tradeSizePct',
    label: 'Trade Size',
    description: 'Percent of available balance per trade',
    min: 1,
    max: 50,
    step: 1,
    unit: '%',
  },
  {
    key: 'buyThreshold',
    label: 'Buy Threshold',
    description: 'Deviation below SMA (%) to trigger BUY',
    min: 0.1,
    max: 5,
    step: 0.1,
    unit: '%',
  },
  {
    key: 'sellThreshold',
    label: 'Sell Threshold',
    description: 'Profit above entry (%) to trigger SELL',
    min: 0.1,
    max: 5,
    step: 0.1,
    unit: '%',
  },
  {
    key: 'stopLossPct',
    label: 'Stop Loss',
    description: 'Loss (%) at which position is closed',
    min: 1,
    max: 10,
    step: 0.5,
    unit: '%',
  },
  {
    key: 'arbMinProfitBps',
    label: 'Min Arb Profit',
    description: 'Minimum profit (bps) required to execute arb',
    min: 10,
    max: 200,
    step: 5,
    unit: 'bps',
  },
  {
    key: 'slippageBps',
    label: 'Slippage Tolerance',
    description: 'Max slippage accepted on Jupiter swaps',
    min: 10,
    max: 200,
    step: 5,
    unit: 'bps',
  },
  {
    key: 'scanIntervalMs',
    label: 'Scan Interval',
    description: 'Delay between market scans',
    min: 2000,
    max: 15000,
    step: 500,
    unit: 'ms',
    format: (v) => `${(v / 1000).toFixed(1)}s`,
  },
]

async function fetchTokens(): Promise<TokenInfo[]> {
  const res = await fetch('/api/trading/tokens')
  if (!res.ok) throw new Error('token fetch failed')
  const json = (await res.json()) as { tokens: TokenInfo[] }
  return json.tokens ?? []
}

export function ConfigPanel() {
  const [open, setOpen] = useState(false)

  // Open the panel when other components emit 'open-config'
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener('open-config', handler)
    return () => window.removeEventListener('open-config', handler)
  }, [])

  const config = useTradingStore((s) => s.config)
  const updateConfig = useTradingStore((s) => s.updateConfig)
  const connected = useTradingStore((s) => s.connected)

  const { data: tokens, isLoading: tokensLoading } = useQuery({
    queryKey: ['trading-tokens'],
    queryFn: fetchTokens,
    staleTime: 5 * 60 * 1000,
  })

  // Local draft state - separate from live config so we can edit & apply
  const [draft, setDraft] = useState<BotConfig>(config)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Re-sync local draft when live config changes (e.g. snapshot from engine)
  useEffect(() => {
    setDraft(config)
    setDirty(false)
  }, [config])

  const update = <K extends keyof BotConfig>(key: K, value: BotConfig[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }

  const toggleToken = (mint: string) => {
    setDraft((d) => {
      const has = d.tokens.includes(mint)
      const next = has ? d.tokens.filter((m) => m !== mint) : [...d.tokens, mint]
      return { ...d, tokens: next }
    })
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Emit to engine (engine persists to DB). Also POST to REST for redundancy.
      updateConfig(draft)
      try {
        await fetch('/api/trading/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        })
      } catch {
        // REST is best-effort; the engine is source of truth
      }
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setDraft({ ...DEFAULT_CONFIG, tokens: draft.tokens })
    setDirty(true)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 bg-background p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="flex items-center gap-2">
            <Settings className="size-5 text-emerald-400" />
            Bot Configuration
          </SheetTitle>
          <SheetDescription>
            Tune strategy parameters and token selection. Changes apply live to the engine.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 scrollbar-thin">
          <div className="space-y-6 p-4">
            {/* Capital & Max Positions */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Capital &amp; Risk
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="capital">Capital (USDC)</Label>
                  <Input
                    id="capital"
                    type="number"
                    min={10}
                    step={50}
                    value={draft.capital}
                    onChange={(e) =>
                      update('capital', Math.max(10, Number(e.target.value) || 0))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="maxPositions">Max Positions</Label>
                  <Input
                    id="maxPositions"
                    type="number"
                    min={1}
                    max={20}
                    step={1}
                    value={draft.maxPositions}
                    onChange={(e) =>
                      update(
                        'maxPositions',
                        Math.max(1, Math.min(20, Number(e.target.value) || 1)),
                      )
                    }
                  />
                </div>
              </div>
            </section>

            {/* Numeric sliders */}
            <section className="space-y-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Strategy Parameters
              </h3>
              {NUMERIC_FIELDS.map((f) => {
                const val = draft[f.key] as number
                return (
                  <div key={f.key} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="text-sm">{f.label}</Label>
                        <p className="text-[11px] text-muted-foreground">{f.description}</p>
                      </div>
                      <Badge variant="outline" className="tabular-nums">
                        {f.format ? f.format(val) : `${val}${f.unit ? ` ${f.unit}` : ''}`}
                      </Badge>
                    </div>
                    <Slider
                      value={[val]}
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      onValueChange={([v]) => update(f.key, v as never)}
                    />
                  </div>
                )
              })}
            </section>

            {/* Token selection */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Tokens
                </h3>
                <Badge variant="outline">{draft.tokens.length} selected</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Choose which verified tokens the bot may trade. USDC is the quote currency.
              </p>
              {tokensLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {tokens?.map((t) => {
                    const checked = draft.tokens.includes(t.mint)
                    return (
                      <button
                        type="button"
                        key={t.mint}
                        onClick={() => toggleToken(t.mint)}
                        className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                          checked
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                            : 'border-border bg-card/40 text-muted-foreground hover:bg-muted/40'
                        }`}
                      >
                        <Checkbox checked={checked} className="pointer-events-none" />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{t.symbol}</div>
                          <div className="truncate text-[10px] opacity-70">{t.name}</div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>

            {/* Status hint */}
            <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-2">
                <Zap
                  className={`size-3.5 ${connected ? 'text-emerald-400' : 'text-amber-400'}`}
                />
                <span>
                  {connected
                    ? 'Engine connected. Changes will apply live.'
                    : 'Engine offline. Connect to apply changes.'}
                </span>
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center gap-2 border-t border-border p-4">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={saving}
            className="gap-1.5"
          >
            <RotateCcw className="size-3.5" /> Reset
          </Button>
          <div className="ml-auto">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
            >
              <Save className="size-3.5" /> {saving ? 'Saving…' : 'Save & Apply'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
