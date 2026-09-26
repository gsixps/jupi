// Real Phantom wallet integration for Solana.
// All functions are CLIENT-SIDE only (use the browser-injected window.solana).
// The user's private key NEVER leaves their wallet — we only request signing.
//
// Phantom injects `window.solana` (and `window.phantom.solana`). We detect it,
// connect, read the public key + on-chain balances, and request swap signatures.

import { PublicKey } from "@solana/web3.js"
import type { Connection, Transaction, VersionedTransaction } from "@solana/web3.js"
import { VERIFIED_TOKENS, USDC_MINT } from "./tokens"
import type { TokenInfo } from "./trading-types"

export interface PhantomProvider {
  isPhantom?: boolean
  isSolana?: boolean
  publicKey?: PublicKey | null
  connect: (opts?: {
    onlyIfTrusted?: boolean
  }) => Promise<{ publicKey: PublicKey }>
  disconnect: () => Promise<void>
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>
  signAndSendTransaction?: (
    tx: Transaction | VersionedTransaction,
    connection?: Connection,
    opts?: { skipPreflight?: boolean }
  ) => Promise<{ signature: string } | string>
  sendTransaction?: (
    tx: Transaction | VersionedTransaction,
    connection: Connection,
    opts?: { skipPreflight?: boolean }
  ) => Promise<string>
  on: (event: string, handler: (...args: any[]) => void) => void
  off?: (event: string, handler: (...args: any[]) => void) => void
}

declare global {
  interface Window {
    solana?: PhantomProvider
    phantom?: { solana?: PhantomProvider }
  }
}

/**
 * Detect the Phantom provider (or any Solana wallet injecting window.solana).
 *
 * IMPORTANT: prefer `window.phantom.solana` (the canonical, stable reference)
 * over `window.solana`, which Phantom keeps as a *compatibility Proxy*. On the
 * legacy proxy, read-only/non-configurable properties like `on` are re-created
 * on every access, so V8 throws a Proxy invariant error like:
 *   "'get' on proxy: property 'on' is a read-only and non-configurable data
 *    property ... but the proxy did not return its actual value"
 * That crash took down the dashboard's wallet effect on some installs.
 */
export function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null
  // 1) Canonical reference (stable object, no compat Proxy).
  const nested = window.phantom?.solana
  if (nested && (nested.isPhantom || nested.isSolana || typeof nested.connect === "function")) {
    return nested
  }
  // 2) Legacy `window.solana` proxy — only as a fallback.
  const direct = window.solana
  if (direct && (direct.isPhantom || direct.isSolana || typeof direct.connect === "function")) {
    return direct
  }
  return null
}

/** Returns true if a Solana wallet (Phantom/Solflare/Backpack) is installed. */
export function isWalletInstalled(): boolean {
  return getPhantomProvider() !== null
}

export interface WalletState {
  connected: boolean
  publicKey: string | null
  provider: PhantomProvider | null
}

/** Connect to the wallet. Throws if not installed or user rejects. */
export async function connectWallet(): Promise<WalletState> {
  const provider = getPhantomProvider()
  if (!provider) {
    throw new Error(
      "No Solana wallet found. Install Phantom from https://phantom.app"
    )
  }
  // Try silent reconnect first (onlyIfTrusted), then full connect.
  try {
    const resp = await provider.connect({ onlyIfTrusted: true })
    return {
      connected: true,
      publicKey: resp.publicKey.toString(),
      provider,
    }
  } catch {
    // full connect (shows popup)
    const resp = await provider.connect()
    return {
      connected: true,
      publicKey: resp.publicKey.toString(),
      provider,
    }
  }
}

/** Disconnect the wallet. */
export async function disconnectWallet(): Promise<void> {
  const provider = getPhantomProvider()
  if (!provider) return
  try {
    await provider.disconnect()
  } catch {
    // ignore
  }
}

export interface TokenBalance {
  mint: string
  symbol: string
  decimals: number
  amount: number // human units
  usdValue: number
  logo?: string
}

export interface WalletBalances {
  sol: number // native SOL
  solUsd: number
  tokens: TokenBalance[]
  totalUsd: number
}

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss6TFVZ7UxF"
const LAMPORTS_PER_SOL = 1_000_000_000

/**
 * Fetch the wallet's SOL + SPL token balances from a Solana RPC.
 * Uses the public mainnet RPC by default (rate-limited; for production use
 * a paid RPC like Helius/QuickNode).
 */
export async function fetchWalletBalances(
  connection: Connection,
  publicKey: string,
  prices: Record<string, number>
): Promise<WalletBalances> {
  const pub = new PublicKey(publicKey)
  const lamports = await connection.getBalance(pub)
  const sol = lamports / LAMPORTS_PER_SOL
  const solUsd = sol * (prices[getSolMint()] ?? 0)

  const tokens: TokenBalance[] = []
  let totalUsd = solUsd

  try {
    const resp = await connection.getParsedTokenAccountsByOwner(pub, {
      programId: new PublicKey(TOKEN_PROGRAM_ID),
    })
    const byMint = new Map<string, TokenBalance>()
    for (const { account } of resp.value) {
      const info = (account.data as any)?.parsed?.info
      if (!info) continue
      const mint = info.mint as string
      const amountStr = info.tokenAmount?.amount as string
      const decimals = info.tokenAmount?.decimals as number
      const uiAmount = info.tokenAmount?.uiAmount as number
      if (!mint || uiAmount == null) continue
      const tok = VERIFIED_TOKENS.find((t) => t.mint === mint)
      if (!tok) continue // only track our curated tokens
      const usd = uiAmount * (prices[mint] ?? 0)
      byMint.set(mint, {
        mint,
        symbol: tok.symbol,
        decimals,
        amount: uiAmount,
        usdValue: usd,
        logo: tok.logo,
      })
      totalUsd += usd
    }
    // ensure USDC is shown even at 0
    if (!byMint.has(USDC_MINT)) {
      byMint.set(USDC_MINT, {
        mint: USDC_MINT,
        symbol: "USDC",
        decimals: 6,
        amount: 0,
        usdValue: 0,
      })
    }
    tokens.push(...byMint.values())
    tokens.sort((a, b) => b.usdValue - a.usdValue)
  } catch (e) {
    // token fetch failed — return SOL-only
  }

  return { sol, solUsd, tokens, totalUsd }
}

function getSolMint(): string {
  return "So11111111111111111111111111111111111111112"
}

/**
 * Sign and broadcast a transaction via Phantom.
 * Returns the transaction signature.
 *
 * Phantom's injected provider exposes `signAndSendTransaction` (its primary
 * API), NOT `sendTransaction`. Some other wallets expose `sendTransaction`,
 * so we support all three paths:
 *   1. sendTransaction(tx, conn, opts) -> signature string        (wallets like Solflare)
 *   2. signAndSendTransaction(tx, conn, opts) -> {signature}|string (Phantom)
 *   3. signTransaction + connection.sendRawTransaction            (universal fallback)
 */
/** Normalize any rejection so the caller always gets a real Error with a message. */
function normalizeError(e: unknown): Error {
  if (e instanceof Error) return e
  if (typeof e === "string") return new Error(e)
  const m = (e as { message?: unknown } | null | undefined)?.message
  if (typeof m === "string" && m) return new Error(m)
  return new Error(
    e == null
      ? "Phantom request failed (no reason given)"
      : `Phantom request failed: ${String(e)}`
  )
}

export async function signAndSendTransaction(
  tx: Transaction | VersionedTransaction,
  connection: Connection,
  opts?: { skipPreflight?: boolean }
): Promise<string> {
  const provider = getPhantomProvider()
  if (!provider) throw new Error("Wallet not connected")
  const skipPreflight = opts?.skipPreflight ?? false

  try {
    if (provider.sendTransaction) {
      const sig = await provider.sendTransaction(tx, connection, { skipPreflight })
      if (typeof sig !== "string") throw new Error("Wallet returned an invalid signature")
      return sig
    }
    if (provider.signAndSendTransaction) {
      const res = await provider.signAndSendTransaction(tx, connection, { skipPreflight })
      const sig =
        typeof res === "string"
          ? res
          : (res as { signature?: string } | null | undefined)?.signature
      if (typeof sig !== "string") throw new Error("Phantom returned no signature")
      return sig
    }
    // Fallback: sign locally then broadcast via our RPC.
    const signed = await provider.signTransaction(tx)
    const raw = (signed as Transaction).serialize()
    return await connection.sendRawTransaction(raw, { skipPreflight })
  } catch (e) {
    throw normalizeError(e)
  }
}

export { VERIFIED_TOKENS }
