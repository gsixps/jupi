// REAL on-chain swap execution via Jupiter's Swap API.
// All of this runs CLIENT-SIDE in the user's browser.
// The wallet (Phantom) signs the transaction; the private key never leaves the wallet.
//
// Flow:
//   1. GET /swap/v1/quote → route + outAmount
//   2. POST /swap/v1/swap { quoteResponse, userPublicKey, wrapAndUnwrapSol:true } → serialized tx
//   3. Deserialize → VersionedTransaction
//   4. Phantom signs (user sees a popup approving the swap)
//   5. Broadcast via Solana RPC + confirm

import {
  VersionedTransaction,
  Transaction,
  Connection,
  PublicKey,
} from "@solana/web3.js"
import type { TokenInfo } from "./trading-types"
import { fromBaseAmount, toBaseAmount, USDC_MINT } from "./tokens"
import { signAndSendTransaction } from "./wallet"

const QUOTE_API = "https://api.jup.ag/swap/v1/quote"
const SWAP_API = "https://api.jup.ag/swap/v1/swap"

/**
 * Fetch with retry: the free-tier Jupiter API Gateway throttles bursty
 * bots with 429s, so retry with backoff before giving up. Returns the last
 * response (even a 429) so callers can decide based on res.ok.
 */
async function fetchWithRetry(
  url: string,
  init?: RequestInit
): Promise<Response | null> {
  let last: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { ...init, cache: "no-store" as any })
      if (res.status !== 429 && res.status < 500) return res
      last = res
    } catch {
      // network error — fall through to next attempt
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
  }
  return last
}

// Public Solana mainnet RPC (rate-limited; for production use Helius/QuickNode).
// api.mainnet-beta.solana.com now requires an API key (403 on data methods),
// so default to PublicNode's free open endpoint. User can override in the UI.
export const DEFAULT_RPC =
  "https://solana-rpc.publicnode.com"

export interface RealQuoteResult {
  inputMint: string
  outputMint: string
  inAmount: number // base units
  outAmount: number // base units
  outAmountStr: string
  outPerIn: number // human units ratio
  priceImpactPct: number
  labels: string[]
  routePlan: unknown
  // the full raw quote object (needed for the swap call)
  raw: unknown
}

/**
 * Fetch a real swap quote from Jupiter v6.
 * @param inputMint   source token mint
 * @param outputMint   destination token mint
 * @param uiAmount     input amount in HUMAN units (e.g. 0.5 SOL)
 * @param slippageBps  slippage tolerance in bps (50 = 0.5%)
 * @param tokens       token info (for decimals)
 */
export async function fetchRealQuote(
  inputMint: string,
  outputMint: string,
  uiAmount: number,
  slippageBps: number,
  tokens: TokenInfo[]
): Promise<RealQuoteResult | null> {
  const inTok = tokens.find((t) => t.mint === inputMint)
  const outTok = tokens.find((t) => t.mint === outputMint)
  if (!inTok || !outTok) return null
  const inBase = toBaseAmount(uiAmount, inTok.decimals)
  if (inBase <= 0) return null

  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(inBase),
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
    onlyDirectRoutes: "false",
    asLegacyTransaction: "false",
    maxAccounts: "64",
  })
  try {
    const res = await fetchWithRetry(`${QUOTE_API}?${params.toString()}`)
    if (!res || !res.ok) return null
    const j = (await res.json()) as {
      inAmount?: string
      outAmount?: string
      priceImpactPct?: number | string
      routePlan?: Array<{ swapInfo?: { label?: string } }>
    }
    const inAmount = Number(j.inAmount ?? inBase)
    const outAmountStr = j.outAmount ?? "0"
    const outAmount = Number(outAmountStr)
    const priceImpactPct = Number(j.priceImpactPct ?? 0)
    const inHuman = inAmount / Math.pow(10, inTok.decimals)
    const outHuman = outAmount / Math.pow(10, outTok.decimals)
    const outPerIn = inHuman > 0 ? outHuman / inHuman : 0
    const labels: string[] = []
    if (Array.isArray(j.routePlan)) {
      for (const leg of j.routePlan) {
        if (leg.swapInfo?.label) labels.push(leg.swapInfo.label)
      }
    }
    return {
      inputMint,
      outputMint,
      inAmount,
      outAmount,
      outAmountStr,
      outPerIn,
      priceImpactPct,
      labels,
      routePlan: j.routePlan,
      raw: j,
    }
  } catch {
    return null
  }
}

export interface SwapExecution {
  signature: string
  success: boolean
  error?: string
  inputMint: string
  outputMint: string
  inAmount: number // base units
  outAmount: number // base units (expected, from quote)
  inSymbol: string
  outSymbol: string
  inHuman: number
  outHuman: number
  usdValue?: number
  slot?: number
  confirmations?: number
}

/**
 * Execute a REAL on-chain swap via Jupiter.
 * 1. Get a fresh quote (valid for ~60s)
 * 2. POST /v6/swap to get the serialized transaction
 * 3. Deserialize with VersionedTransaction
 * 4. Phantom signs (user approves in popup)
 * 5. Broadcast + confirm
 *
 * @param userPublicKey  the connected wallet's public key (string)
 * @param connection     Solana RPC connection
 * @param quote          the quote from fetchRealQuote
 */
export async function executeRealSwap(opts: {
  userPublicKey: string
  connection: Connection
  quote: RealQuoteResult
  inSymbol: string
  outSymbol: string
  inDecimals: number
  outDecimals: number
  priorityFeeMicroLamports?: number
}): Promise<SwapExecution> {
  const {
    userPublicKey,
    connection,
    quote,
    inSymbol,
    outSymbol,
    inDecimals,
    outDecimals,
    priorityFeeMicroLamports,
  } = opts

  // 2. Get the serialized swap transaction from Jupiter.
  const swapBody: Record<string, unknown> = {
    quoteResponse: quote.raw,
    userPublicKey,
    wrapAndUnwrapSol: true, // handle native SOL <-> wSOL automatically
    asLegacyTransaction: false,
    computeUnitPriceMicroLamports: priorityFeeMicroLamports ?? "auto",
  }
  const swapRes = await fetchWithRetry(SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  })
  if (!swapRes || !swapRes.ok) {
    const txt = await swapRes?.text().catch(() => swapRes?.status.toString())
    throw new Error(`Jupiter swap API ${swapRes?.status ?? "network error"}: ${(txt ?? "").slice(0, 200)}`)
  }
  const swapJson = (await swapRes.json()) as {
    swapTransaction?: string
    lastValidBlockHeight?: number
    prioritizationFeeLamports?: number
  }
  if (!swapJson.swapTransaction) {
    throw new Error("Jupiter returned no swapTransaction")
  }

  // 3. Deserialize the base64 transaction into a VersionedTransaction.
  // Buffer is available client-side via the polyfill loaded in use-wallet.
  const txBuf = Buffer.from(swapJson.swapTransaction, "base64")
  const tx = VersionedTransaction.deserialize(txBuf)

  // 4. Sign + send via Phantom.
  const signature = await signAndSendTransaction(tx, connection)

  // 5. Confirm.
  const blockHeight = await connection.getLatestBlockhash?.()
  let confirmed = false
  let slot: number | undefined
  if (blockHeight && swapJson.lastValidBlockHeight) {
    const conf = await connection.confirmTransaction(
      {
        signature,
        blockhash: blockHeight.blockhash,
        lastValidBlockHeight:
          swapJson.lastValidBlockHeight ??
          blockHeight.lastValidBlockHeight,
      },
      "confirmed"
    )
    confirmed = !conf.value.err
    slot = conf.context.slot
  } else {
    // Fallback: simple confirmation wait
    await connection.confirmTransaction(signature, "confirmed")
    confirmed = true
  }

  const inHuman = quote.inAmount / Math.pow(10, inDecimals)
  const outHuman = quote.outAmount / Math.pow(10, outDecimals)

  return {
    signature,
    success: confirmed,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    inSymbol,
    outSymbol,
    inHuman,
    outHuman,
    slot,
    error: confirmed ? undefined : "Transaction may have failed",
  }
}

/**
 * Triangular arbitrage execution: 3 sequential real swaps USDC -> A -> B -> USDC.
 * Each leg is a separate on-chain transaction (signed by the user). The user
 * must approve all 3 in Phantom.
 */
export async function executeTriangularArbitrage(opts: {
  userPublicKey: string
  connection: Connection
  inputUsd: number
  leg1: { mint: string; symbol: string; decimals: number } // A
  leg2: { mint: string; symbol: string; decimals: number } // B
  tokens: TokenInfo[]
  slippageBps: number
}): Promise<{
  legs: SwapExecution[]
  totalInUsd: number
  totalOutUsd: number
  profitUsd: number
  profitPct: number
  success: boolean
}> {
  const { userPublicKey, connection, inputUsd, leg1, leg2, tokens, slippageBps } = opts
  const legs: SwapExecution[] = []

  // Leg 1: USDC -> A
  const q1 = await fetchRealQuote(
    USDC_MINT,
    leg1.mint,
    inputUsd,
    slippageBps,
    tokens
  )
  if (!q1) throw new Error("Arb leg 1 (USDC->A) quote failed")
  const exec1 = await executeRealSwap({
    userPublicKey,
    connection,
    quote: q1,
    inSymbol: "USDC",
    outSymbol: leg1.symbol,
    inDecimals: 6,
    outDecimals: leg1.decimals,
  })
  legs.push(exec1)
  if (!exec1.success) {
    return {
      legs,
      totalInUsd: inputUsd,
      totalOutUsd: 0,
      profitUsd: -inputUsd,
      profitPct: -100,
      success: false,
    }
  }
  // The actual amount of A received (use the quote's outAmount — on-chain may differ slightly)
  const aReceivedBase = q1.outAmount

  // Leg 2: A -> B (use the full A received)
  const aReceivedHuman = fromBaseAmount(aReceivedBase, leg1.decimals)
  const q2 = await fetchRealQuote(
    leg1.mint,
    leg2.mint,
    aReceivedHuman,
    slippageBps,
    tokens
  )
  if (!q2) throw new Error("Arb leg 2 (A->B) quote failed")
  const exec2 = await executeRealSwap({
    userPublicKey,
    connection,
    quote: q2,
    inSymbol: leg1.symbol,
    outSymbol: leg2.symbol,
    inDecimals: leg1.decimals,
    outDecimals: leg2.decimals,
  })
  legs.push(exec2)
  if (!exec2.success) {
    return {
      legs,
      totalInUsd: inputUsd,
      totalOutUsd: 0,
      profitUsd: -inputUsd,
      profitPct: -100,
      success: false,
    }
  }
  const bReceivedBase = q2.outAmount

  // Leg 3: B -> USDC
  const bReceivedHuman = fromBaseAmount(bReceivedBase, leg2.decimals)
  const q3 = await fetchRealQuote(
    leg2.mint,
    USDC_MINT,
    bReceivedHuman,
    slippageBps,
    tokens
  )
  if (!q3) throw new Error("Arb leg 3 (B->USDC) quote failed")
  const exec3 = await executeRealSwap({
    userPublicKey,
    connection,
    quote: q3,
    inSymbol: leg2.symbol,
    outSymbol: "USDC",
    inDecimals: leg2.decimals,
    outDecimals: 6,
  })
  legs.push(exec3)

  const totalOutUsd = exec3.outHuman // outSymbol is USDC, outHuman is USD value
  const profitUsd = totalOutUsd - inputUsd
  const profitPct = inputUsd > 0 ? (profitUsd / inputUsd) * 100 : 0

  return {
    legs,
    totalInUsd: inputUsd,
    totalOutUsd,
    profitUsd,
    profitPct,
    success: exec3.success,
  }
}

/**
 * Execute a REAL on-chain swap signed by a Keypair (the funded trading
 * sub-wallet) instead of Phantom. This is what enables FULLY AUTOMATIC
 * trading — no per-transaction approval popup. The bot owns the keypair,
 * so it signs and broadcasts directly.
 *
 * @param signerKeypair   the trading wallet's Keypair (from @solana/web3.js)
 * @param userPublicKey   the trading wallet's public key (string)
 * @param connection      Solana RPC connection
 * @param quote           the quote from fetchRealQuote
 */
export async function executeSwapWithKeypair(opts: {
  signerKeypair: { signMessage?: any; secretKey: Uint8Array; publicKey: PublicKey } & import("@solana/web3.js").Signer
  userPublicKey: string
  connection: Connection
  quote: RealQuoteResult
  inSymbol: string
  outSymbol: string
  inDecimals: number
  outDecimals: number
  priorityFeeMicroLamports?: number
}): Promise<SwapExecution> {
  const {
    signerKeypair,
    userPublicKey,
    connection,
    quote,
    inSymbol,
    outSymbol,
    inDecimals,
    outDecimals,
    priorityFeeMicroLamports,
  } = opts

  // POST /v6/swap to get the serialized transaction.
  const swapBody: Record<string, unknown> = {
    quoteResponse: quote.raw,
    userPublicKey,
    wrapAndUnwrapSol: true,
    asLegacyTransaction: false,
    computeUnitPriceMicroLamports: priorityFeeMicroLamports ?? "auto",
  }
  const swapRes = await fetchWithRetry(SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  })
  if (!swapRes || !swapRes.ok) {
    const txt = await swapRes?.text().catch(() => swapRes?.status.toString())
    throw new Error(`Jupiter swap API ${swapRes?.status ?? "network error"}: ${(txt ?? "").slice(0, 200)}`)
  }
  const swapJson = (await swapRes.json()) as {
    swapTransaction?: string
    lastValidBlockHeight?: number
  }
  if (!swapJson.swapTransaction) {
    throw new Error("Jupiter returned no swapTransaction")
  }

  // Deserialize + sign with the trading wallet keypair (NO Phantom popup).
  const txBuf = Buffer.from(swapJson.swapTransaction, "base64")
  const tx = VersionedTransaction.deserialize(txBuf)
  tx.sign([signerKeypair as any])

  // Broadcast + confirm.
  const raw = Buffer.from(tx.serialize())
  const signature = await connection.sendRawTransaction(raw as any, {
    skipPreflight: false,
    maxRetries: 3,
  })

  let confirmed = false
  let slot: number | undefined
  try {
    const conf = await connection.confirmTransaction(signature, "confirmed")
    confirmed = !conf.value.err
    slot = conf.context?.slot
  } catch {
    // fall back to a simple wait
    await new Promise((r) => setTimeout(r, 3000))
    const sigInfo = await connection.getSignatureStatuses([signature])
    const status = sigInfo?.value?.[0]
    confirmed = status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized"
    slot = status?.slot ?? undefined
  }

  const inHuman = quote.inAmount / Math.pow(10, inDecimals)
  const outHuman = quote.outAmount / Math.pow(10, outDecimals)

  return {
    signature,
    success: confirmed,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    inSymbol,
    outSymbol,
    inHuman,
    outHuman,
    slot,
    error: confirmed ? undefined : "Transaction may have failed",
  }
}
