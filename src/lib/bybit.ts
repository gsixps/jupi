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
// (https://api.bybit.com/v5/market/tickers): best bid/ask of both legs and
// the perp funding rate. When Bybit is unreachable the bot skips the tick —
// it never trades on simulated prices. The mock engine below only runs in
// the explicit SIMULATION data mode.

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
  /** Signed basis in bps on LAST prices: (perp - spot) / spot. Display only. */
  basisBps: number
  /** EXECUTABLE entry basis of a perp-rich hedge: sell the perp at its bid,
   *  buy the spot at its ask. This is what an order would actually capture. */
  entryRichBps: number
  /** EXECUTABLE exit basis of that hedge: buy the perp back at its ask, sell
   *  the spot at its bid. */
  exitRichBps: number
  /** Perp funding per interval (fraction; 0.0001 = 0.01%). The SHORT perp
   *  leg of a perp-rich hedge receives it when positive. */
  fundingRate: number
  fundingIntervalH: number
  /** True when the executable entry clears the threshold → tradeable window. */
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

/** Live quote of one symbol from the Bybit V5 tickers. */
export interface BybitQuote {
  last: number
  bid: number
  ask: number
  /** linear only */
  fundingRate?: number
  fundingIntervalH?: number
}

/**
 * Build the RWA rows. With `live` quotes a row is tradable only when BOTH legs
 * have a live book — a missing leg is never filled with a simulated price.
 * `live === null` is the explicit SIMULATION mode (synthetic prices).
 */
export function buildRwaRows(
  live: Record<string, BybitQuote> | null,
  entryBps: number,
  now = Date.now()
): BybitRwaRow[] {
  return BYBIT_RWA_PAIRS.map((p) => {
    const s = live?.[p.spotSymbol]
    const f = live?.[p.perpSymbol]
    const dataLive = !!(s && f && s.bid > 0 && s.ask > 0 && f.bid > 0 && f.ask > 0)
    let spotBid: number, spotAsk: number, perpBid: number, perpAsk: number
    let spotUsd: number, perpUsd: number
    if (live) {
      spotUsd = s?.last ?? p.anchorUsd
      perpUsd = f?.last ?? p.anchorUsd
      spotBid = s?.bid ?? 0
      spotAsk = s?.ask ?? 0
      perpBid = f?.bid ?? 0
      perpAsk = f?.ask ?? 0
    } else {
      spotUsd = mockRwaPrice(p.spotSymbol, p.anchorUsd, now, { leg: 'spot', pairId: p.id })
      perpUsd = mockRwaPrice(p.perpSymbol, p.anchorUsd, now, { leg: 'perp', pairId: p.id })
      spotBid = spotAsk = spotUsd
      perpBid = perpAsk = perpUsd
    }
    const ok = live ? dataLive : true
    const entryRichBps = ok && spotAsk > 0 ? ((perpBid - spotAsk) / spotAsk) * 10000 : 0
    const exitRichBps = ok && spotBid > 0 ? ((perpAsk - spotBid) / spotBid) * 10000 : 0
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
      basisBps: basisBps(spotUsd, perpUsd),
      entryRichBps,
      exitRichBps,
      fundingRate: f?.fundingRate ?? 0,
      fundingIntervalH: f?.fundingIntervalH ?? 8,
      tradable: ok && entryRichBps >= entryBps,
      dataLive: live ? dataLive : false,
    }
  })
}

/**
 * Fetch both legs from the public Bybit V5 tickers endpoints: last, best
 * bid/ask and (perps) the current funding rate and interval. Throws when
 * either endpoint fails — callers skip the tick instead of simulating.
 */
export async function fetchBybitRwaPrices(): Promise<Record<string, BybitQuote>> {
  const out: Record<string, BybitQuote> = {}
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
        result: {
          list: {
            symbol: string
            lastPrice: string
            bid1Price?: string
            ask1Price?: string
            fundingRate?: string
            fundingIntervalHour?: string
          }[]
        }
      }
      if (j.retCode !== 0) throw new Error(`bybit ${category} ${j.retCode}: ${j.retMsg}`)
      for (const x of j.result.list) {
        if (!want.has(x.symbol)) continue
        const last = parseFloat(x.lastPrice)
        const bid = parseFloat(x.bid1Price ?? '')
        const ask = parseFloat(x.ask1Price ?? '')
        if (!(last > 0)) continue
        const q: BybitQuote = {
          last,
          bid: bid > 0 ? bid : 0,
          ask: ask > 0 ? ask : 0,
        }
        if (category === 'linear') {
          const fr = parseFloat(x.fundingRate ?? '')
          const iv = parseFloat(x.fundingIntervalHour ?? '')
          q.fundingRate = isFinite(fr) ? fr : 0
          q.fundingIntervalH = iv > 0 ? iv : 8
        }
        out[x.symbol] = q
      }
    } finally {
      clearTimeout(t)
    }
  }

  await Promise.all([pull('spot', BYBIT_SPOT_TICKERS), pull('linear', BYBIT_LINEAR_TICKERS)])
  return out
}
