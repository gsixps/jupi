// Funded trading sub-wallet for FULLY AUTOMATIC on-chain trading.
//
// The user transfers a small amount (e.g. $5 USDC + a little SOL for gas)
// from their Phantom wallet into an EPHEMERAL trading wallet that this app
// generates and controls. The user signs the funding transaction ONCE in
// Phantom. After that, the bot signs every swap with the trading wallet's
// keypair directly — NO per-trade approval popups. The risk is strictly
// limited to the funded amount.
//
// The trading wallet's secret key is stored in the browser's localStorage
// (encrypted is overkill for a $5 hot wallet; if you scale up, move this to
// a proper key vault / HSM).

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js"
import type { Signer } from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createCloseAccountInstruction,
  getAccount,
  NATIVE_MINT,
} from "@solana/spl-token"
import bs58 from "bs58"
import { USDC_MINT } from "./tokens"

const STORAGE_KEY = "jup_trading_wallet_v1"
// spl-token functions require a real PublicKey (not the string form of the mint).
const USDC_MINT_PK = new PublicKey(USDC_MINT)

export interface TradingWallet {
  keypair: Keypair
  publicKey: string
}

/** Generate a fresh ephemeral trading wallet and persist it to localStorage. */
export function generateTradingWallet(): TradingWallet {
  const kp = Keypair.generate()
  const tw: TradingWallet = {
    keypair: kp,
    publicKey: kp.publicKey.toString(),
  }
  saveTradingWallet(tw)
  return tw
}

/** Load the persisted trading wallet from localStorage, or null. */
export function loadTradingWallet(): TradingWallet | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const secret = bs58.decode(raw)
    if (secret.length !== 64) return null
    const kp = Keypair.fromSecretKey(secret)
    return { keypair: kp, publicKey: kp.publicKey.toString() }
  } catch {
    return null
  }
}

/** Persist the trading wallet's secret key (base58) to localStorage. */
function saveTradingWallet(tw: TradingWallet): void {
  if (typeof window === "undefined") return
  try {
    const secret = bs58.encode(tw.keypair.secretKey)
    window.localStorage.setItem(STORAGE_KEY, secret)
  } catch {
    // ignore
  }
}

/** Delete the trading wallet from localStorage. */
export function clearTradingWallet(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

// ---- server-side backup (so a cleared browser can't lose the funds) ----
// The keypair is also persisted to the DB via /api/trading/wallet. If
// localStorage is cleared, the hook reloads it from the server.

/** Save the trading wallet's secret key to the server DB (best-effort). */
export async function saveTradingWalletToServer(tw: TradingWallet): Promise<void> {
  try {
    await fetch("/api/trading/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: tw.publicKey,
        secretKey: bs58.encode(tw.keypair.secretKey),
      }),
    })
  } catch {
    // DB backup is best-effort — localStorage is the primary store
  }
}

/** Load the trading wallet from the server DB, or null. */
export async function loadTradingWalletFromServer(): Promise<TradingWallet | null> {
  try {
    const res = await fetch("/api/trading/wallet", { cache: "no-store" })
    if (!res.ok) return null
    const j = (await res.json()) as {
      wallet?: { publicKey?: string; secretKey?: string }
    }
    const raw = j.wallet?.secretKey
    if (!raw) return null
    const secret = bs58.decode(raw)
    if (secret.length !== 64) return null
    const kp = Keypair.fromSecretKey(secret)
    return { keypair: kp, publicKey: kp.publicKey.toString() }
  } catch {
    return null
  }
}

/** Delete the trading wallet backup from the server DB (best-effort). */
export async function clearTradingWalletFromServer(): Promise<void> {
  try {
    await fetch("/api/trading/wallet", { method: "DELETE" })
  } catch {
    // ignore
  }
}

export interface FundParams {
  solAmount: number // human SOL to transfer (for gas + buffer)
  usdcAmount: number // human USDC to transfer (trading capital)
}

export interface FundingTxResult {
  transaction: Transaction
  tradingWalletPubkey: string
}

/**
 * Build a single transaction that funds the trading wallet from the main
 * (Phantom) wallet:
 *   1. Create the trading wallet's USDC ATA (idempotent — no-op if exists)
 *   2. Transfer `usdcAmount` USDC  main → trading wallet
 *   3. Transfer `solAmount` SOL  main → trading wallet (System Program)
 *
 * The main wallet signs this ONE transaction in Phantom. After confirmation,
 * the bot can trade autonomously from the trading wallet.
 */
export async function buildFundingTransaction(
  connection: Connection,
  funderPubkey: string,
  tradingWalletPubkey: string,
  params: FundParams
): Promise<FundingTxResult> {
  const funder = new PublicKey(funderPubkey)
  const tradingWallet = new PublicKey(tradingWalletPubkey)

  // Most funders keep USDC in their ASSOCIATED token account (Phantom shows
  // this "USDC" row). But some wallets hold USDC in a non-associated account
  // (old wallets, some exchanges/QoL tools), in which case the formal ATA is
  // empty and a transfer FROM that ATA fails with a cryptic
  // `InstructionError … Custom(1) = InsufficientFunds`. So instead of assuming
  // `funderAta` exists with a balance, we discover every USDC account owned by
  // the funder, pick the one that can actually cover `usdcAmount`, and use
  // THAT account as the transfer source. If the funder owns no USDC at all we
  // bail with an actionable message instead of letting Phantom/`send` show a
  // simulation error.
  //
  // Returns the parsed source token account (address + how much it holds a
  // number that's ready for display).
  async function findUsdcSource(
    conn: Connection,
    owner: PublicKey,
    wantAmount: number
  ): Promise<{ address: PublicKey; available: number } | null> {
    let ownedAccounts: Awaited<ReturnType<Connection["getParsedTokenAccountsByOwner"]>>["value"] = []
    try {
      const res = await conn.getParsedTokenAccountsByOwner(owner, { mint: USDC_MINT_PK })
      ownedAccounts = res.value
    } catch {
      // If the RPC can't enumerate accounts we can't discover the real source
      // either — behave like the old code (fall back to the ATA) and let the
      // send produce the on-chain error.
      return null
    }
    // Keep only USDC-mint accounts with a positive (nonzero) balance.
    const candidates = ownedAccounts
      .filter(({ account }) => account.data.parsed?.info?.mint === USDC_MINT_PK.toBase58())
      .map(({ pubkey, account }) => ({
        address: pubkey,
        available: Number(account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0),
      }))
      .filter((c) => c.available > 0)
      .sort((a, b) => b.available - a.available)
    if (candidates.length === 0) return null
    return candidates[0]
  }

  const funderUsdcSource = await findUsdcSource(connection, funder, params.usdcAmount)
  if (params.usdcAmount > 0 && !funderUsdcSource) {
    throw new Error(
      `No encontré USDC en tu wallet conectada (${funderPubkey.slice(0, 6)}…). ` +
        `Para fondear el bot necesitas recibir USDC (tokens) en esta misma wallet dentro de Phantom. ` +
        `Revisa que el wallet correcto esté seleccionado en Phantom y que tenga USDC disponible.`
    )
  }
  if (funderUsdcSource && funderUsdcSource.available < params.usdcAmount) {
    // Log the shortfall so it's debuggable, but don't throw — the token
    // program on-chain will do the right thing and block the overspend.
    console.error(
      `[fund-usdc] wallet only has ${funderUsdcSource.available.toFixed(2)} USDC but you asked for ${params.usdcAmount.toFixed(2)}`
    )
  }

  // ---- SOURCE RESOLUTION: which account does the USDC actually come FROM? ----
  // Phantom typically keeps USDC in the ASSOCIATED account, but wallets that
  // have been funded via certain venues keep it in a NON-associated token
  // account. `findUsdcSource` discovers the real one — log it FULL so we can
  // verify on-chain:
  console.error(
    "[fund-source]",
    JSON.stringify({
      discoveredSource: funderUsdcSource
        ? { address: funderUsdcSource.address.toBase58(), available: funderUsdcSource.available }
        : null,
      funderPubkey: funder.toBase58(),
      params: { usdc: params.usdcAmount, sol: params.solAmount },
    })
  )

  const tradingUsdcAta = await getAssociatedTokenAddress(
    USDC_MINT_PK,
    tradingWallet,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  )

  const tx = new Transaction()
  tx.feePayer = funder
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed")
  tx.recentBlockhash = blockhash

  // Guard: make sure the funding wallet can actually cover the transfer + fee.
  const needLamports =
    Math.floor(params.solAmount * LAMPORTS_PER_SOL) + 10000 /* one signature's fee */
  const balanceLamports = await connection.getBalance(funder)
  if (balanceLamports < needLamports) {
    throw new Error(
      `Phantom wallet balance too low: has ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(
        4
      )} SOL, needs ~${((needLamports + 5000) / LAMPORTS_PER_SOL).toFixed(4)} SOL for this funding`
    )
  }

  // 1. Create the trading wallet's USDC ATA if it doesn't exist (idempotent).
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      funder,
      tradingUsdcAta,
      tradingWallet,
      USDC_MINT_PK,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )

  // 2. Transfer USDC main → trading wallet.
  if (params.usdcAmount > 0) {
    const usdcBase = Math.floor(params.usdcAmount * Math.pow(10, 6))
    tx.add(
      createTransferInstruction(
        funderUsdcSource!.address, // the REAL source (may be non-ATA)
        tradingUsdcAta,
        funder,
        usdcBase,
        [],
        TOKEN_PROGRAM_ID
      )
    )
  }

  // 3. Transfer SOL main → trading wallet (for gas + buffer).
  if (params.solAmount > 0) {
    const lamports = Math.floor(params.solAmount * LAMPORTS_PER_SOL)
    tx.add(
      SystemProgram.transfer({
        fromPubkey: funder,
        toPubkey: tradingWallet,
        lamports,
      })
    )
  }

  return { transaction: tx, tradingWalletPubkey }
}

/**
 * Broadcast + confirm, but DON'T fail with a scary error when the RPC just
 * confirms slowly (the block height can expire, or the WebSocket confirm
 * times out, AFTER the tx has already landed). Ground truth = the signature's
 * own status: if the RPC reports the signature processed with no error, the
 * funds moved — report success. Falls back to an on-chain outcome check, then
 * to an explicit failure.
 */
async function sendAndConfirmChecked(
  connection: Connection,
  tx: Transaction,
  signers: Signer[],
  checkOutcome: () => Promise<boolean>
): Promise<string> {
  const sig = await connection.sendTransaction(tx, signers, {
    skipPreflight: false,
    maxRetries: 5,
  })
  try {
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: tx.recentBlockhash ?? "",
        lastValidBlockHeight: tx.lastValidBlockHeight ?? 0,
      },
      "confirmed"
    )
  } catch (e: any) {
    if (!/expired|block height|timeout/i.test(String(e?.message ?? ""))) throw e
    // Give a slow RPC a moment to catch up, then ask for the signature status
    // directly — if it was processed without error, the transaction landed.
    await new Promise((r) => setTimeout(r, 4000))
    try {
      const info = await connection.getSignatureStatuses([sig])
      const status = info?.value?.[0]
      if (status && !status.err) return sig
    } catch {
      // fall through to the outcome check
    }
    if (await checkOutcome()) return sig
    throw e
  }
  return sig
}

/**
 * Withdraw everything back to the main wallet (signed by the trading wallet,
 * no Phantom popup). Split into two independent, low-risk transactions:
 *   1. Transfer ALL trading-wallet USDC → the main wallet's USDC ATA
 *      (creates the ATA first if needed, paying rent from the trading wallet).
 *   2. Sweep remaining SOL (minus a fee reserve) → main wallet.
 *
 * We deliberately do NOT close the trading ATA: closing a funded token account
 * can fail in simulation depending on its exact state; a plain transfer is the
 * robust, canonical way to return funds.
 */
export async function withdrawAll(
  connection: Connection,
  tradingWallet: TradingWallet,
  destinationPubkey: string
): Promise<string> {
  const dest = new PublicKey(destinationPubkey)
  const tw = tradingWallet.keypair
  const tradingPubkey = tw.publicKey
  let lastSig = ""

  const tradingUsdcAta = await getAssociatedTokenAddress(
    USDC_MINT_PK,
    tradingPubkey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  )

  // --- 1) USDC back to the main wallet ---
  let usdcBase = 0
  try {
    const acct = await getAccount(connection, tradingUsdcAta)
    usdcBase = Number(acct.amount)
  } catch {
    // no USDC ATA on the trading wallet — nothing to move
  }

  if (usdcBase > 0) {
    const destUsdcAta = await getAssociatedTokenAddress(
      USDC_MINT_PK,
      dest,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
    // Only create the destination ATA if it doesn't already exist. Creating
    // one would need extra SOL rent from the (possibly depleted) trading
    // wallet — and the simulation fails with "insufficient funds for rent"
    // exactly when its SOL is low. If the main wallet already has a USDC ATA
    // (usual for Phantom), skip the create entirely.
    let destAtaExists = false
    try {
      await getAccount(connection, destUsdcAta)
      destAtaExists = true
    } catch {
      destAtaExists = false
    }
    const tx = new Transaction()
    tx.feePayer = tradingPubkey
    const { blockhash } = await connection.getLatestBlockhash("confirmed")
    tx.recentBlockhash = blockhash
    if (!destAtaExists) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          tradingPubkey,
          destUsdcAta,
          dest,
          USDC_MINT_PK,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      )
    }
    // Move ALL USDC (signer = trading wallet owner).
    tx.add(
      createTransferInstruction(
        tradingUsdcAta,
        destUsdcAta,
        tradingPubkey,
        usdcBase,
        [],
        TOKEN_PROGRAM_ID
      )
    )
    lastSig = await sendAndConfirmChecked(connection, tx, [tw], async () => {
      const acct = await getAccount(connection, tradingUsdcAta).catch(() => null)
      return !acct || Number(acct.amount) === 0
    })
  }

  // --- 2) Sweep remaining SOL (keep a small fee reserve) ---
  const balanceLamports = await connection.getBalance(tradingPubkey)
  const feeReserve = 10000 // ~2 signatures' worth of base fee
  if (balanceLamports > feeReserve + 5000) {
    const tx = new Transaction()
    tx.feePayer = tradingPubkey
    const { blockhash } = await connection.getLatestBlockhash("confirmed")
    tx.recentBlockhash = blockhash
    tx.add(
      SystemProgram.transfer({
        fromPubkey: tradingPubkey,
        toPubkey: dest,
        lamports: balanceLamports - feeReserve,
      })
    )
    lastSig = await sendAndConfirmChecked(connection, tx, [tw], async () => {
      const bal = await connection.getBalance(tradingPubkey)
      return bal <= feeReserve + 1000
    })
  }

  if (!lastSig) throw new Error("Trading wallet is empty — nothing to withdraw")
  return lastSig
}

/** Fetch the trading wallet's SOL + USDC balance. */
export async function getTradingWalletBalances(
  connection: Connection,
  tradingWalletPubkey: string
): Promise<{ sol: number; usdc: number; solLamports: number; usdcBase: number }> {
  const pub = new PublicKey(tradingWalletPubkey)
  const lamports = await connection.getBalance(pub)
  const sol = lamports / LAMPORTS_PER_SOL
  let usdc = 0
  let usdcBase = 0
  try {
    const ata = await getAssociatedTokenAddress(
      USDC_MINT_PK,
      pub,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
    const acct = await getAccount(connection, ata).catch(() => null)
    if (acct) {
      usdcBase = Number(acct.amount)
      usdc = usdcBase / Math.pow(10, 6)
    }
  } catch {
    // no ATA
  }
  return { sol, usdc, solLamports: lamports, usdcBase }
}

/**
 * Real SPL balance of one mint in the trading wallet, in token units.
 *
 * This is the chain-side source of truth for a PumpFun position: a refresh, a
 * manual sell from another tab or a swap that only partially filled all show up
 * here as a quantity that differs from what the bot recorded. Missing token
 * account simply means 0.
 */
export async function getTokenBalance(
  connection: Connection,
  ownerPubkey: string,
  mint: string,
  decimals: number
): Promise<number> {
  try {
    const owner = new PublicKey(ownerPubkey)
    const mintPk = new PublicKey(mint)
    const ata = await getAssociatedTokenAddress(
      mintPk,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
    const acct = await getAccount(connection, ata).catch(() => null)
    if (!acct) return 0
    return Number(acct.amount) / Math.pow(10, decimals || 6)
  } catch {
    return 0
  }
}
