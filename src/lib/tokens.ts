// Solana token registry
// Verified mint addresses (DexScreener + CoinGecko confirmed) + CoinGecko IDs.
// Used by both the Next.js app and the trading-engine mini-service.

import type { TokenInfo } from "./trading-types"

// USDC is our quote/numeraire token
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
export const SOL_MINT = "So11111111111111111111111111111111111111112"

// Augment TokenInfo with an optional coingeckoId field (runtime extension).
declare module "./trading-types" {
  interface TokenInfo {
    coingeckoId?: string
  }
}

// Hardcoded, VERIFIED token list with correct mints (confirmed via DexScreener +
// CoinGecko) and CoinGecko IDs for the price fallback path.
export const VERIFIED_TOKENS: TokenInfo[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    mint: USDC_MINT,
    decimals: 6,
    stable: true,
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkYqMcxMn6oyn6QEJ",
    decimals: 6,
    stable: true,
  },
  {
    symbol: "SOL",
    name: "Solana",
    mint: SOL_MINT,
    decimals: 9,
    coingeckoId: "solana",
  },
  {
    symbol: "JUP",
    name: "Jupiter",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
    coingeckoId: "jupiter-exchange-solana",
  },
  {
    symbol: "BONK",
    name: "Bonk",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    decimals: 5,
    coingeckoId: "bonk",
  },
  {
    symbol: "WIF",
    name: "dogwifcoin",
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    decimals: 6,
    coingeckoId: "dogwifcoin",
  },
  {
    symbol: "PYTH",
    name: "Pyth Network",
    mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    decimals: 6,
    coingeckoId: "pyth-network",
  },
  {
    symbol: "RAY",
    name: "Raydium",
    mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    decimals: 6,
    coingeckoId: "raydium",
  },
  {
    symbol: "JTO",
    name: "Jito Governance",
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    decimals: 9,
    coingeckoId: "jito-governance-token",
  },
]

export const BASE_TOKENS: TokenInfo[] = VERIFIED_TOKENS.filter(
  (t) => t.symbol === "USDC" || t.symbol === "SOL"
)

export const TARGET_TOKEN_SYMBOLS = VERIFIED_TOKENS.map((t) => t.symbol)

let cachedTokenList: TokenInfo[] | null = null

/**
 * Returns the verified token list. Tries Jupiter's token list first (fast-fail);
 * on failure (DNS blocked in this sandbox), returns the hardcoded VERIFIED_TOKENS.
 */
export async function fetchTokenList(): Promise<TokenInfo[]> {
  if (cachedTokenList) return cachedTokenList

  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2500)
    const res = await fetch("https://tokens.jup.ag/tokens?tags=verified", {
      // @ts-ignore
      cache: "no-store",
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (res.ok) {
      const raw = (await res.json()) as Array<{
        symbol: string
        name: string
        address: string
        decimals: number
        logoURI?: string
      }>
      const bySymbol = new Map<string, TokenInfo>()
      for (const tk of raw) {
        const sym = tk.symbol?.toUpperCase()
        if (!sym || !tk.address) continue
        if (TARGET_TOKEN_SYMBOLS.includes(sym) && !bySymbol.has(sym)) {
          bySymbol.set(sym, {
            symbol: sym,
            name: tk.name,
            mint: tk.address,
            decimals: tk.decimals,
            logo: tk.logoURI,
            stable: sym === "USDC" || sym === "USDT",
          })
        }
      }
      const list: TokenInfo[] = []
      for (const v of VERIFIED_TOKENS) {
        list.push(bySymbol.get(v.symbol) ?? v)
      }
      cachedTokenList = list
      return list
    }
  } catch {
    // fall through
  }

  cachedTokenList = VERIFIED_TOKENS
  return cachedTokenList
}

export function toBaseAmount(uiAmount: number, decimals: number): number {
  return Math.floor(uiAmount * Math.pow(10, decimals))
}

export function fromBaseAmount(baseAmount: number, decimals: number): number {
  return baseAmount / Math.pow(10, decimals)
}
