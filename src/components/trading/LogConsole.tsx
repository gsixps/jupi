'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTradingStore, type LogEntry } from '@/lib/store'
import { fmtTime } from '@/lib/format'
import { Terminal } from 'lucide-react'

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: 'text-zinc-300',
  warn: 'text-amber-300',
  error: 'text-rose-300',
  success: 'text-emerald-300',
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex items-start gap-2 px-2 py-0.5 font-mono text-[11px] leading-relaxed">
      <span className="shrink-0 text-muted-foreground/70 tabular-nums">
        {fmtTime(entry.timestamp)}
      </span>
      <span className={`shrink-0 uppercase ${LEVEL_COLOR[entry.level]}`}>
        {entry.level}
      </span>
      <span className="min-w-0 flex-1 break-words text-zinc-200">{entry.message}</span>
    </div>
  )
}

export function LogConsole() {
  const logs = useTradingStore((s) => s.logs)

  return (
    <Card className="gap-2 p-4 md:p-5">
      <CardHeader className="p-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Terminal className="size-4 text-emerald-400" />
          Engine Log
          <span className="ml-auto text-[10px] font-normal text-muted-foreground">
            {logs.length} lines
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-48 overflow-y-auto scrollbar-thin rounded-md border border-border/60 bg-zinc-950/40 p-2">
          {logs.length === 0 ? (
            <div className="flex h-20 items-center justify-center font-mono text-[11px] text-muted-foreground">
              waiting for engine output…
            </div>
          ) : (
            logs.map((entry, i) => <LogLine key={`${entry.timestamp}-${i}`} entry={entry} />)
          )}
        </div>
      </CardContent>
    </Card>
  )
}
