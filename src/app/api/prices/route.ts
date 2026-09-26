// Server-side proxy that fetches REAL Solana token prices.
// The browser (client-side paper bot) fetches from this local route instead of
// hitting api.jup.is / api.coingecko.com directly — this works in ALL
// environments (including sandboxes where the browser has no outbound internet
// but the Next.js server does).
//
// Tries Jupiter Price API first (aggregated DEX prices), falls back to CoinGecko
// (real market prices). NO perturbation, NO simulation — these are the exact
// real prices.

import { NextResponse } from "next/server"
import { VERIFIED_TOKENS, USDC_MINT, SOL_MINT } from "@/lib/tokens"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3"
const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price"

// In-memory cache (5s) to avoid hammering CoinGecko's free-tier rate limit
// when the bot scans every few seconds.
let cache: { ts: number; data: { prices: Record<string, number>; change: Record<string, number> } } | null = null
const CACHE_TTL = 5000

export async function GET(req: Request) {
  // serve from cache if fresh (reduces CoinGecko rate-limit hits)
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(
      { prices: cache.data.prices, change: cache.data.change, source: "cached" },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    )
  }
  const url = new URL(req.url)
  const mintsParam = url.searchParams.get("mints") || ""
  const requestedMints = mintsParam
    ? mintsParam.split(",").filter(Boolean)
    : VERIFIED_TOKENS.map((t) => t.mint)

  // If the cache is stale but we have SOMETHING cached, serve it as a
  // best-effort fallback while we attempt a fresh fetch. This keeps the bot
  // running even during transient upstream (Jupiter/CoinGecko) failures.
  const staleButUsable = cache && cache.data

  // always include USDC + SOL
  const mints = Array.from(new Set([USDC_MINT, SOL_MINT, ...requestedMints]))

  const prices: Record<string, number> = { [USDC_MINT]: 1 }
  const change: Record<string, number> = {}

  // 1) Try Jupiter Price API (server-side, works if DNS resolves).
  try {
    const ids = mints.filter((m) => m !== USDC_MINT).join(",")
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(
      `${JUPITER_PRICE_API}?vsToken=USDC&ids=${encodeURIComponent(ids)}`,
      { cache: "no-store" as any, signal: ctrl.signal }
    )
    clearTimeout(t)
    if (res.ok) {
      const j = (await res.json()) as Record<
        string,
        { usdPrice?: number; priceChange24h?: number }
      >
      for (const [mint, entry] of Object.entries(j)) {
        if (typeof entry.usdPrice === "number" && entry.usdPrice > 0) {
          prices[mint] = entry.usdPrice
        }
        if (typeof entry.priceChange24h === "number") {
          change[mint] = entry.priceChange24h
        }
      }
    }
  } catch {
    // Jupiter unreachable — fall through to CoinGecko
  }

  // 2) CoinGecko fallback for any mint still missing a price (REAL prices).
  const missing = mints.filter((m) => m !== USDC_MINT && !prices[m])
  if (missing.length > 0) {
    try {
      const cgIds = missing
        .map((m) => VERIFIED_TOKENS.find((t) => t.mint === m)?.coingeckoId)
        .filter(Boolean) as string[]
      if (cgIds.length > 0) {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 6000)
        const cgRes = await fetch(
          `${COINGECKO_API}?ids=${encodeURIComponent(
            cgIds.join(",")
          )}&vs_currencies=usd&include_24hr_change=true`,
          { cache: "no-store" as any, signal: ctrl.signal }
        )
        clearTimeout(t)
        if (cgRes.ok) {
          const cg = (await cgRes.json()) as Record<
            string,
            { usd?: number; usd_24h_change?: number }
          >
          for (const m of missing) {
            const tok = VERIFIED_TOKENS.find((t) => t.mint === m)
            if (!tok?.coingeckoId) continue
            const entry = cg[tok.coingeckoId]
            if (entry?.usd && entry.usd > 0) {
              prices[m] = entry.usd
              if (typeof entry.usd_24h_change === "number") {
                change[m] = entry.usd_24h_change
              }
            }
          }
        }
      }
    } catch {
      // both failed
    }
  }

  // stables
  prices[USDC_MINT] = 1
  for (const t of VERIFIED_TOKENS) {
    if (t.stable) prices[t.mint] = 1
  }

  // If we got NO real (non-stable) prices this round, serve the stale cache
  // instead of returning empty data. This keeps the bot fed during transient
  // upstream failures (CoinGecko rate-limit, Jupiter DNS, recompiles).
  const realPriceCount = Object.keys(prices).filter(
    (m) => prices[m] !== 1 || !VERIFIED_TOKENS.find((t) => t.mint === m)?.stable
  ).length
  if (realPriceCount === 0 && staleButUsable) {
    return NextResponse.json(
      { prices: cache!.data.prices, change: cache!.data.change, source: "stale-cache" },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    )
  }

  // populate cache
  cache = { ts: Date.now(), data: { prices, change } }

  return NextResponse.json(
    { prices, change, source: realPriceCount > 1 ? "jupiter+coingecko" : "partial" },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  )
}
