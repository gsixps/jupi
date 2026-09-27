// Number / time formatting helpers for the trading UI

export function fmtUsd(n: number, digits = 2): string {
  if (!isFinite(n)) return "$0.00"
  const abs = Math.abs(n)
  if (abs >= 1_000_000)
    return `$${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}K`
  return `$${n.toFixed(digits)}`
}

export function fmtUsdFull(n: number, digits = 4): string {
  if (!isFinite(n)) return "$0.00"
  return `$${n.toFixed(digits)}`
}

export function fmtNum(n: number, digits = 4): string {
  if (!isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  if (abs >= 1) return n.toFixed(digits)
  return n.toExponential(2)
}

/** Compact raw number formatting (no $ sign) for volumes etc. */
export function fmtCompact(n: number): string {
  if (!isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  if (abs >= 1) return n.toFixed(2)
  return n.toPrecision(3)
}

export function fmtPct(n: number, digits = 2): string {
  if (n == null || !isFinite(n)) return "0.00%"
  const sign = n > 0 ? "+" : ""
  return `${sign}${n.toFixed(digits)}%`
}

export function fmtBps(n: number): string {
  if (n == null || !isFinite(n)) return "0.0 bps"
  return `${n.toFixed(1)} bps`
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "--"
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "0s"
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export function fmtEth(n: number, digits = 4): string {
  if (!isFinite(n)) return "0 ETH"
  return `${n.toFixed(digits)} ETH`
}

export function fmtEthUsd(n: number, ethUsd = 3247.18): string {
  if (!isFinite(n)) return "$0.00"
  return fmtUsd(n * ethUsd)
}

export function shortMint(mint: string): string {
  if (!mint) return ""
  if (mint.length <= 10) return mint
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
}
