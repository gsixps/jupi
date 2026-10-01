// Honest paper accounting — the demo ledgers charge the SAME costs a real
// account pays, so a demo P&L is what the live bot would have made.
//
// Rates are the entry-tier TAKER fees (market orders) of each venue. A real
// account with volume discounts pays less; never more than this.

export const TAKER_FEE = {
  /** Binance spot, no BNB discount. */
  binance: 0.001,
  /** Kraken Pro spot, < 10k USD 30-day volume. */
  kraken: 0.004,
  /** Bybit spot (xStocks included). */
  bybitSpot: 0.001,
  /** Bybit USDT linear perpetual. */
  bybitPerp: 0.00055,
  /** Solana DEX via Jupiter: pool fee is already inside the quote; this is
   *  the extra network + priority fee, roughly, per swap on a small ticket. */
  jupiterNetwork: 0.0005,
  /** Curve stable pools (typical 0.04% pool fee) — gas is NOT included. */
  curvePool: 0.0004,
} as const

/**
 * USD result of buying `notionalUsd` at `buyPrice` and selling everything at
 * `sellPrice`, paying `feeRate` on each side (fee on the USD value traded).
 */
export function paperRoundTrip(
  notionalUsd: number,
  buyPrice: number,
  sellPrice: number,
  feeRate: number
): { proceedsUsd: number; feesUsd: number; pnlUsd: number } {
  if (!(notionalUsd > 0) || !(buyPrice > 0) || !(sellPrice > 0)) {
    return { proceedsUsd: notionalUsd, feesUsd: 0, pnlUsd: 0 }
  }
  const buyFee = notionalUsd * feeRate
  const qty = (notionalUsd - buyFee) / buyPrice
  const gross = qty * sellPrice
  const sellFee = gross * feeRate
  const proceedsUsd = gross - sellFee
  return { proceedsUsd, feesUsd: buyFee + sellFee, pnlUsd: proceedsUsd - notionalUsd }
}
