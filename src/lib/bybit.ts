// BYBIT — RWA (real-world asset) basis-arbitrage engine.
//
// Strategy: Bybit lists Backed Finance "xStocks" (1:1 tokenized US equities)
// on Spot (e.g. NVDAXUSDT) AND a TradFi linear perpetual on the same
// underlying (e.g. NVDAUSDT). The xStock token trades 24/7 while the
// underlying's cash market is closed, so the two quotes drift apart.
//
//   perp  >  spot  →  buy the xStock spot, short the perp   (sell the perp)
//   perp  <  spot  →  sell the xStock spot, buy the perp    (long the perp)
//
// Hedging the perp leg makes the trade market-neutral: the RWA price move
// cancels out and only the basis convergence is left as P&L. That is a real,
// capital-efficient arbitrage rather than a directional bet on a stock.
//
// Market data comes from the REAL public Bybit V5 API
// (https://api.bybit.com/v5/market/tickers). When the browser cannot reach
// Bybit (sandbox), a deterministic mock engine anchored at the last real
// quotes takes over — same pattern as the Binance / Kraken / Curve tabs.

export const BYBIT_API_BASE = "https://api.bybit.com"
export const BYBIT_SPOT_TICKERS = `${BYBIT_API_BASE}/v5/market/tickers?category=spot`
export const BYBIT_LINEAR_TICKERS = `${BYBIT_API_BASE}/v5/market/tickers?category=linear`

/** RWA theme used to label the watchlist. */
export type RwaSector =
  | 'AI semis'
  | 'Mega-cap tech'
  | 'Consumer'
  | 'Index ETF'
  | 'Fintech'
  | 'Payments'

/**
 * A matched RWA basis pair: the 1:1-backed spot token and the linear perp on
 * the same underlying. `perpSymbol` is only used when the perp tracks the very
 * same reference asset — pairs without a valid match are excluded.
 */
export interface BybitRwaPair {
  id: string
  /** xStock ticker, e.g. "NVDAX" */
  token: string
  /** Underlying company/ticker, e.g. "NVDA" */
  underlying: string
  company: string
  sector: RwaSector
  /** Spot symbol, e.g. "NVDAXUSDT" */
  spotSymbol: string
  /** Linear perp symbol on the same underlying, e.g. "NVDAUSDT" */
  perpSymbol: string
  /** Last real spot quote (USD) — mock anchor. */
  anchorUsd: number
}

/**
 * The RWA shelf. Anchors are the real Bybit quotes captured while building
 * this engine and only act as the fallback mock's centre of gravity.
 */
export const BYBIT_RWA_PAIRS: BybitRwaPair[] = [
  {
    id: 'rwa_nvda',
    token: 'NVDAX',
    underlying: 'NVDA',
    company: 'NVIDIA',
    sector: 'AI semis',
    spotSymbol: 'NVDAXUSDT',
    perpSymbol: 'NVDAUSDT',
    anchorUsd: 224.88,
  },
  {
    id: 'rwa_tsla',
    token: 'TSLAX',
    underlying: 'TSLA',
    company: 'Tesla',
    sector: 'Consumer',
    spotSymbol: 'TSLAXUSDT',
    perpSymbol: 'TSLAUSDT',
    anchorUsd: 371.82,
  },
  {
    id: 'rwa_aapl',
    token: 'AAPLX',
    underlying: 'AAPL',
    company: 'Apple',
    sector: 'Mega-cap tech',
    spotSymbol: 'AAPLXUSDT',
    perpSymbol: 'AAPLUSDT',
    anchorUsd: 341.7,
  },
  {
    id: 'rwa_meta',
    token: 'METAX',
    underlying: 'META',
    company: 'Meta Platforms',
    sector: 'Mega-cap tech',
    spotSymbol: 'METAXUSDT',
    perpSymbol: 'METAUSDT',
    anchorUsd: 747.22,
  },
  {
    id: 'rwa_googl',
    token: 'GOOGLX',
    underlying: 'GOOGL',
    company: 'Alphabet',
    sector: 'Mega-cap tech',
    spotSymbol: 'GOOGLXUSDT',
    perpSymbol: 'GOOGLUSDT',
    anchorUsd: 344.1,
  },
  {
    id: 'rwa_amzn',
    token: 'AMZNX',
    underlying: 'AMZN',
    company: 'Amazon',
    sector: 'Mega-cap tech',
    spotSymbol: 'AMZNXUSDT',
    perpSymbol: 'AMZNUSDT',
    anchorUsd: 249.75,
  },
  {
    id: 'rwa_mcd',
    token: 'MCDX',
    underlying: 'MCD',
    company: "McDonald's",
    sector: 'Consumer',
    spotSymbol: 'MCDXUSDT',
    perpSymbol: 'MCDUSDT',
    anchorUsd: 243.58,
  },
  {
    id: 'rwa_coin',
    token: 'COINX',
    underlying: 'COIN',
    company: 'Coinbase',
    sector: 'Fintech',
    spotSymbol: 'COINXUSDT',
    perpSymbol: 'COINUSDT',
    anchorUsd: 195.06,
  },
  {
    id: 'rwa_crcl',
    token: 'CRCLX',
    underlying: 'CRCL',
    company: 'Circle',
    sector: 'Payments',
    spotSymbol: 'CRCLXUSDT',
    perpSymbol: 'CRCLUSDT',
    anchorUsd: 87.79,
  },
  {
    id: 'rwa_hood',
    token: 'HOODX',
    underlying: 'HOOD',
    company: 'Robinhood',
    sector: 'Fintech',
    spotSymbol: 'HOODXUSDT',
    perpSymbol: 'HOODUSDT',
    anchorUsd: 118.58,
  },
]

// ---- deterministic pseudo-random (same engine as binance / kraken / curve) ----
export function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Deterministic mock price for a leg. The perp leg gets a slightly wider,
 * slower wobble than the spot leg so a basis window (and therefore an
 * arbitrage opportunity) can open even with no API access. Amplitudes are in
 * percent, and RWA quotes move in much tighter ranges than memecoins.
 */
export function mockRwaPrice(
  symbol: string,
  anchorUsd: number,
  t = Date.now(),
  opts: { leg: 'spot' | 'perp'; pairId: string }
): number {
  const phase = seededRandom(symbol) * 6.2832
  const phase2 = seededRandom(symbol + 'w') * 6.2832
  // spot: tight, fast. perp: slightly wider + slower drift.
  const amp = opts.leg === 'spot' ? 0.0022 : 0.0045
  const period = opts.leg === 'spot' ? 240000 : 420000
  const wave1 = Math.sin((t / period) * 6.2832 + phase) * amp
  const wave2 = Math.sin((t / 1500000) * 6.2832 + phase2) * amp * 0.8
  const noiseBucket = Math.floor(t / 20000)
  const noise = (seededRandom(symbol + noiseBucket) - 0.5) * (amp / 2)
  // per-pair static basis offset keeps a directional lean on the basis
  const bias = (seededRandom(opts.pairId + 'basis') - 0.5) * 0.006
  const price = anchorUsd * (1 + wave1 + wave2 + noise + (opts.leg === 'perp' ? bias : 0))
  return Math.round(price * 1e4) / 1e4
}

/** One row of the RWA watchlist. */
export interface BybitRwaRow {
  pairId: string
  token: string
  underlying: string
  company: string
  sector: RwaSector
  spotSymbol: string
  perpSymbol: string
  spotUsd: number
  perpUsd: number
  anchorUsd: number
  /** Signed basis in bps: (perp - spot) / spot. Positive = perp rich. */
  basisBps: number
  /** True when |basis| ≥ entry threshold → tradeable window. */
  tradable: boolean
  dataLive: boolean
}

/**
 * Basis in basis points. Positive means the perp trades rich of the spot
 * token (buy spot / short perp); negative means the perp is cheap.
 */
export function basisBps(spotUsd: number, perpUsd: number): number {
  if (!(spotUsd > 0)) return 0
  return Math.round(((perpUsd - spotUsd) / spotUsd) * 10000)
}

/** Build the RWA rows from a {symbol → price} map, falling back to the mock. */
export function buildRwaRows(
  live: Record<string, number> | null,
  entryBps: number,
  now = Date.now()
): BybitRwaRow[] {
  return BYBIT_RWA_PAIRS.map((p) => {
    const liveSpot = live?.[p.spotSymbol]
    const livePerp = live?.[p.perpSymbol]
    const hasSpot = liveSpot !== undefined && liveSpot > 0
    const hasPerp = livePerp !== undefined && livePerp > 0
    const dataLive = hasSpot && hasPerp
    const spotUsd = hasSpot
      ? liveSpot
      : mockRwaPrice(p.spotSymbol, p.anchorUsd, now, { leg: 'spot', pairId: p.id })
    const perpUsd = hasPerp
      ? livePerp
      : mockRwaPrice(p.perpSymbol, p.anchorUsd, now, { leg: 'perp', pairId: p.id })
    const bps = basisBps(spotUsd, perpUsd)
    return {
      pairId: p.id,
      token: p.token,
      underlying: p.underlying,
      company: p.company,
      sector: p.sector,
      spotSymbol: p.spotSymbol,
      perpSymbol: p.perpSymbol,
      spotUsd,
      perpUsd,
      anchorUsd: p.anchorUsd,
      basisBps: bps,
      tradable: Math.abs(bps) >= entryBps,
      dataLive,
    }
  })
}

/**
 * Fetch both legs from the public Bybit V5 tickers endpoints. Returns a map of
 * symbol → last price for every RWA symbol we watch. Partial results are fine:
 * missing legs simply fall back to the mock engine per row.
 */
export async function fetchBybitRwaPrices(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const want = new Set<string>()
  for (const p of BYBIT_RWA_PAIRS) {
    want.add(p.spotSymbol)
    want.add(p.perpSymbol)
  }

  const pull = async (category: 'spot' | 'linear', url: string) => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`bybit ${category} api ${res.status}`)
      const j = (await res.json()) as {
        retCode: number
        retMsg: string
        result: { list: { symbol: string; lastPrice: string }[] }
      }
      if (j.retCode !== 0) throw new Error(`bybit ${category} ${j.retCode}: ${j.retMsg}`)
      for (const x of j.result.list) {
        if (!want.has(x.symbol)) continue
        const px = parseFloat(x.lastPrice)
        if (isFinite(px) && px > 0) out[x.symbol] = px
      }
    } finally {
      clearTimeout(t)
    }
  }

  await pull('spot', BYBIT_SPOT_TICKERS)
  await pull('linear', BYBIT_LINEAR_TICKERS)
  return out
}
