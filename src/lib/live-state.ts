// LIVE STATE PERSISTENCE + EXCHANGE RECONCILIATION.
//
// A refresh used to wipe every live bot's memory: after F5 the dashboard showed
// zero open positions while the coins were still on the exchange, so the bot
// happily re-bought an asset it already owned and its exit rules could never
// fire. This module persists the open positions per bot and, on start, checks
// them against what the exchange (or the chain) actually holds.
//
// Rules, in order of safety:
//   - The exchange is the source of truth for QUANTITIES, never for intent.
//   - Real >= recorded  -> keep the position, adopt the real quantity.
//   - Real <  recorded  -> STOP. The user may have sold by hand; the bot refuses
//                          to guess, it asks.
//   - Real balance with no recorded position -> warn only. The user's own money
//                          sitting on the account must not block the bot.
//
// Nothing here ever places an order.

const PREFIX = "jup_live_"
const VERSION = 1

export interface LiveSnapshot<T> {
  v: number
  bot: string
  savedAt: number
  /** Open positions only; closed ones are history, not state. */
  open: T[]
  /** Live cash in the quote currency, for the compound-interest base. */
  cashUsd?: number
  /** True when the bot was still running when the tab went away. */
  wasRunning: boolean
}

function key(bot: string): string {
  return `${PREFIX}${bot}_v1`
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

/** Persist the open positions. Called on every state change while live. */
export function saveLiveSnapshot<T>(
  bot: string,
  open: T[],
  opts: { cashUsd?: number; wasRunning?: boolean } = {}
): void {
  if (!canUseStorage()) return
  try {
    const snap: LiveSnapshot<T> = {
      v: VERSION,
      bot,
      savedAt: Date.now(),
      open,
      cashUsd: opts.cashUsd,
      wasRunning: opts.wasRunning ?? false,
    }
    window.localStorage.setItem(key(bot), JSON.stringify(snap))
  } catch {
    // A full or disabled storage must never break trading.
  }
}

/** Read the persisted open positions, or null when there are none. */
export function loadLiveSnapshot<T>(bot: string): LiveSnapshot<T> | null {
  if (!canUseStorage()) return null
  try {
    const raw = window.localStorage.getItem(key(bot))
    if (!raw) return null
    const snap = JSON.parse(raw) as LiveSnapshot<T>
    if (!snap || snap.v !== VERSION || snap.bot !== bot || !Array.isArray(snap.open)) return null
    return snap
  } catch {
    return null
  }
}

/** Forget the persisted state. Called when live mode is switched off. */
export function clearLiveSnapshot(bot: string): void {
  if (!canUseStorage()) return
  try {
    window.localStorage.removeItem(key(bot))
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------- reconcile

/** What a holding needs so the checker can compare it with the exchange. */
export interface Reconcilable {
  /** Exchange asset that holds the position (SOL, BTC, XBT, the mint...). */
  liveAsset: string
  /** Base quantity the bot believes it holds. */
  liveQty: number
  /** Name shown to the user when something is wrong. */
  liveLabel: string
}

export interface ReconcileInput<T> {
  bot: string
  /** Open positions restored from storage. */
  persisted: T[]
  /** Real free balances from the exchange, keyed by exchange asset. */
  balances: Map<string, number>
  /** Project one holding onto the shape the checker needs. */
  view: (h: T) => Reconcilable
  /** Apply a corrected real quantity to a holding, returning a new object. */
  withQty: (h: T, qty: number) => T
  /** Balances below this are dust and never a real position. */
  minQty?: number
}

export interface ReconcileResult<T> {
  /** Positions to carry into this session, with real quantities applied. */
  holdings: T[]
  /** Positions the exchange no longer holds at the recorded size. */
  missing: T[]
  /** Real balances with no recorded position (informational only). */
  untracked: string[]
  /** Non-null when the bot must not trade until the user resolves it. */
  fatal: string | null
  /** Human summary for the log. */
  notes: string[]
}

/**
 * Compare recorded positions with real exchange balances.
 *
 * `fatal` is only set when the exchange holds materially LESS than recorded:
 * that means a position was reduced or closed outside the bot, and continuing
 * would sell coins that are not there.
 */
export function reconcileLiveState<T>(input: ReconcileInput<T>): ReconcileResult<T> {
  const { persisted, balances, view, withQty } = input
  const minQty = input.minQty ?? 0
  const notes: string[] = []
  const fatal: string[] = []
  const untracked: string[] = []

  // Group by asset: two routes can hold the same coin (SOL direct + cross).
  const byAsset = new Map<string, T[]>()
  for (const h of persisted) {
    const v = view(h)
    if (!v.liveAsset) continue
    const list = byAsset.get(v.liveAsset)
    if (list) list.push(h)
    else byAsset.set(v.liveAsset, [h])
  }

  const out: T[] = []
  const missing: T[] = []

  for (const [asset, list] of byAsset) {
    const expected = list.reduce((a, h) => a + Math.max(0, view(h).liveQty), 0)
    const real = balances.get(asset) ?? 0
    const labels = list.map((h) => view(h).liveLabel)

    if (expected <= 0) {
      // Recorded without a real quantity: adopt whatever the exchange says.
      if (real > minQty) {
        notes.push(`${asset}: adoptado desde el exchange (${real})`)
        out.push(...list.map((h) => withQty(h, real)))
      } else {
        missing.push(...list)
      }
      continue
    }

    if (real >= expected * 0.999) {
      if (real > expected * 1.001) {
        notes.push(`${asset}: el exchange tiene ${real} y el bot registró ${expected}; se adopta el saldo real`)
      }
      const scale = real / expected
      out.push(...list.map((h) => withQty(h, view(h).liveQty * scale)))
      continue
    }

    if (real >= expected * 0.9) {
      // Small dust/slippage difference: proportional adjustment is safe.
      notes.push(`${asset}: ajustado de ${expected} a ${real} en el exchange`)
      const scale = real / expected
      out.push(...list.map((h) => withQty(h, view(h).liveQty * scale)))
      continue
    }

    missing.push(...list)
    fatal.push(
      `${asset}: el bot registró ${expected} pero el exchange solo tiene ${real} (${labels.join(', ')}). ` +
        `Si vendiste a mano, pulsa "Sincronizar con el exchange" para que el bot adopte el saldo real.`
    )
  }

  for (const [asset, free] of balances) {
    if (byAsset.has(asset)) continue
    if (free <= minQty) continue
    untracked.push(`${asset} ${free}`)
  }
  if (untracked.length > 0) {
    notes.push(`Saldo en el exchange sin posición registrada: ${untracked.join(', ')} (informativo)`)
  }

  return { holdings: out, missing, untracked, fatal: fatal.length ? fatal.join(' ') : null, notes }
}
