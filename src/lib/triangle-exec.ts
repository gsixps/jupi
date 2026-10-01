// TRIANGLE EXECUTION — full-cycle triangular arbitrage math (Kraken).
//
// A triangle route trades one token against two quote paths:
//   direct:  TOKEN/USD           (directSymbol)
//   implied: TOKEN/X  ×  X/USD   (crossSymbol × usdtSymbol, X = inter asset)
//
// A CYCLE executes the three legs in sequence and ends back in USD, so the
// position never carries market risk:
//
//   direction "direct_cheap" (token cheaper on the direct pair):
//     1. BUY  TOKEN on directSymbol   (spend USD, receive TOKEN at ask)
//     2. SELL TOKEN on crossSymbol    (receive X at bid, fee charged in X)
//     3. SELL X on usdtSymbol         (receive USD at bid)
//
//   direction "cross_cheap" (token cheaper via the cross path):
//     1. BUY  X on usdtSymbol         (spend USD, receive X at ask)
//     2. BUY  TOKEN on crossSymbol    (spend X at ask, fee charged in X)
//     3. SELL TOKEN on directSymbol   (receive USD at bid)
//
// Fee model: taker fee f per leg, charged in the quote currency of each pair
// (Kraken oflags=fciq). The value flowing through each leg is multiplied by
// (1 − f), so gross cycle return = favorable-rates product × (1 − f)^3:
//   direct_cheap: bid(cross) × bid(inter/USD) / ask(direct)
//   cross_cheap:  bid(direct) / (ask(cross) × ask(inter/USD))
//
// This mirrors what Kraken actually does closely enough for go/no-go
// decisions and for the paper ledger. LIVE P&L always uses the REAL fees
// reported by the fills (feeQuote) instead of this model.
//
// Pure functions — no I/O, no Kraken imports.

export type TriangleDirection = "direct_cheap" | "cross_cheap"

/** Executable book for one pair. In demo (mock) bid == ask == mock price. */
export interface TrianglePairBook {
  bid: number
  ask: number
}

/** One leg of a completed/simulated cycle, for the ledger and the UI. */
export interface CycleLeg {
  pair: string
  side: "buy" | "sell"
  /** base-asset volume of the leg */
  qty: number
  /** execution price (ask for buys, bid for sells) */
  price: number
  /** quote value the leg settles at (before its own fee) */
  quoteAmount: number
  /** fee charged in the pair quote currency (fciq) */
  feeQuote: number
  /** asset that flows to the next leg (symbol) */
  outAsset: string
  /** amount of outAsset received net of this leg's fee */
  outQty: number
}

export interface CyclePlan {
  routeId: string
  routeName: string
  token: string
  direction: TriangleDirection
  /** USD that enters the cycle */
  notionalUsd: number
  legs: CycleLeg[]
  /** USD that comes back after the 3 legs and their fees */
  finalUsd: number
  /** raw rate difference before any fee, in bps */
  grossBps: number
  /** net return after the 3 leg fees, in bps */
  netBps: number
  netProfitUsd: number
  /** approximate total fees of the cycle, expressed in USD */
  feeTotalUsd: number
}

export interface TriangleRouteShape {
  id: string
  name: string
  token: string
  directSymbol: string
  crossSymbol: string
  usdtSymbol: string
}

function isPositive(n: unknown): n is number {
  return typeof n === "number" && isFinite(n) && n > 0
}

/**
 * Plan the best direction for one triangle route given executable books.
 * Returns null when any leg lacks a usable price or the notional is too small.
 *
 * @param interAsset symbol of the intermediate asset (base of usdtSymbol)
 * @param books per-symbol bid/ask books for directSymbol, crossSymbol, usdtSymbol
 */
export function planTriangleCycle(
  route: TriangleRouteShape,
  interAsset: string,
  books: Record<string, TrianglePairBook>,
  notionalUsd: number,
  feeBpsPerLeg: number
): CyclePlan | null {
  if (!(notionalUsd > 0)) return null
  const direct = books[route.directSymbol]
  const cross = books[route.crossSymbol]
  const inter = books[route.usdtSymbol]
  if (!direct || !cross || !inter) return null
  if (!isPositive(direct.bid) || !isPositive(direct.ask)) return null
  if (!isPositive(cross.bid) || !isPositive(cross.ask)) return null
  if (!isPositive(inter.bid) || !isPositive(inter.ask)) return null

  const f = feeBpsPerLeg / 10000
  const N = notionalUsd

  // Direction A — "direct_cheap": buy TOKEN direct, unwind via cross.
  const grossA = (cross.bid * inter.bid) / direct.ask
  const qtyT = (N * (1 - f)) / direct.ask
  const xGross = qtyT * cross.bid
  const xFee = xGross * f
  const xNet = xGross - xFee
  const usdGross = xNet * inter.bid
  const usdFee = usdGross * f
  const finalA = usdGross - usdFee
  const legsA: CycleLeg[] = [
    {
      pair: route.directSymbol, side: "buy",
      qty: qtyT, price: direct.ask,
      quoteAmount: N, feeQuote: N * f,
      outAsset: route.token, outQty: qtyT,
    },
    {
      pair: route.crossSymbol, side: "sell",
      qty: qtyT, price: cross.bid,
      quoteAmount: xGross, feeQuote: xFee,
      outAsset: interAsset, outQty: xNet,
    },
    {
      pair: route.usdtSymbol, side: "sell",
      qty: xNet, price: inter.bid,
      quoteAmount: usdGross, feeQuote: usdFee,
      outAsset: "USD", outQty: finalA,
    },
  ]

  // Direction B — "cross_cheap": buy the inter asset, then TOKEN via cross,
  // unwind on the direct pair.
  const grossB = direct.bid / (cross.ask * inter.ask)
  const x1 = (N * (1 - f)) / inter.ask
  const qtyTB = (x1 * (1 - f)) / cross.ask
  const usdGrossB = qtyTB * direct.bid
  const usdFeeB = usdGrossB * f
  const finalB = usdGrossB - usdFeeB
  const legsB: CycleLeg[] = [
    {
      pair: route.usdtSymbol, side: "buy",
      qty: x1, price: inter.ask,
      quoteAmount: N, feeQuote: N * f,
      outAsset: interAsset, outQty: x1,
    },
    {
      pair: route.crossSymbol, side: "buy",
      qty: qtyTB, price: cross.ask,
      quoteAmount: x1, feeQuote: x1 * f,
      outAsset: route.token, outQty: qtyTB,
    },
    {
      pair: route.directSymbol, side: "sell",
      qty: qtyTB, price: direct.bid,
      quoteAmount: usdGrossB, feeQuote: usdFeeB,
      outAsset: "USD", outQty: finalB,
    },
  ]

  const a: CyclePlan = {
    routeId: route.id,
    routeName: route.name,
    token: route.token,
    direction: "direct_cheap",
    notionalUsd: N,
    legs: legsA,
    finalUsd: finalA,
    grossBps: (grossA - 1) * 10000,
    netBps: (finalA / N - 1) * 10000,
    netProfitUsd: finalA - N,
    feeTotalUsd: N * f + xFee * inter.bid + usdFee,
  }
  const b: CyclePlan = {
    ...a,
    direction: "cross_cheap",
    legs: legsB,
    finalUsd: finalB,
    grossBps: (grossB - 1) * 10000,
    netBps: (finalB / N - 1) * 10000,
    netProfitUsd: finalB - N,
    // leg2 fee is charged in the inter asset (quote of the cross pair):
    // convert it to USD with the inter/USD rate (usdtSymbol ask).
    feeTotalUsd: N * f + x1 * f * inter.ask + usdFeeB,
  }
  return a.netBps >= b.netBps ? a : b
}

/**
 * Deterministic DEMO dislocation (bps) for one route: a slow sine wave that
 * periodically pushes the cross-implied price away from the direct one, the
 * way real cross-pair dislocations appear and fade. Amplitude ~120bps with a
 * seeded period of 45–120s, so demo cycles clear the fee hurdle occasionally
 * instead of every tick. Only ever applied to MOCK data.
 */
export function mockRouteDislocationBps(routeId: string, t = Date.now()): number {
  let h = 2166136261
  const s = routeId + "::disloc"
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const r = (h >>> 0) % 100000 / 100000
  const period = 45000 + r * 75000 // 45s – 120s
  const phase = r * 6.2832
  const wave = Math.sin((t / period) * 6.2832 + phase)
  // keep the sign of the seed stable but let the wave cross zero
  return wave * 120 * (0.75 + 0.25 * r)
}

/**
 * Apply the demo dislocation to a raw quote map (mutates a copy): the CROSS
 * pair of every route is shifted, which moves the implied price vs direct.
 * Returns a NEW map — never mutates the input.
 */
export function applyMockDislocation(
  raw: Record<string, number>,
  routes: TriangleRouteShape[],
  t = Date.now()
): Record<string, number> {
  const out = { ...raw }
  for (const route of routes) {
    const base = out[route.crossSymbol]
    if (!isPositive(base)) continue
    const bps = mockRouteDislocationBps(route.id, t)
    out[route.crossSymbol] = base * (1 + bps / 10000)
  }
  return out
}

/** Short human summary of a cycle plan for logs: "USD→SOL→XBT→USD". */
export function cyclePathLabel(plan: CyclePlan, interAsset: string): string {
  const t = plan.token
  if (plan.direction === "direct_cheap") {
    return `USD→${t}→${interAsset}→USD`
  }
  return `USD→${interAsset}→${t}→USD`
}
