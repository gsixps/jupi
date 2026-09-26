// React hook for real Phantom wallet connection + on-chain balance tracking.
// All client-side. The wallet's private key never leaves Phantom.

"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import type { Connection } from "@solana/web3.js"
import "../lib/polyfills" // install Buffer polyfill before web3.js loads
import { Connection as SolConnection, PublicKey } from "@solana/web3.js"
import {
  connectWallet,
  disconnectWallet,
  fetchWalletBalances,
  getPhantomProvider,
  isWalletInstalled,
  type WalletBalances,
  type PhantomProvider,
} from "@/lib/wallet"
import { VERIFIED_TOKENS, USDC_MINT } from "@/lib/tokens"

export interface UseWallet {
  installed: boolean
  connecting: boolean
  connected: boolean
  publicKey: string | null
  shortAddress: string
  balances: WalletBalances | null
  balancesLoading: boolean
  rpc: string
  setRpc: (rpc: string) => void
  error: string | null
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  refreshBalances: (prices: Record<string, number>) => Promise<void>
  getProvider: () => PhantomProvider | null
  getConnection: () => Connection | null
}

let sharedConnection: Connection | null = null

export function useWallet(): UseWallet {
  const [installed, setInstalled] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [balances, setBalances] = useState<WalletBalances | null>(null)
  const [balancesLoading, setBalancesLoading] = useState(false)
  const [rpc, setRpcState] = useState(
    "https://solana-rpc.publicnode.com"
  )
  const [error, setError] = useState<string | null>(null)

  // detect provider on mount
  useEffect(() => {
    const p = getPhantomProvider()
    setInstalled(!!p || isWalletInstalled())
    if (!p) return
    // Some installs expose a legacy compatibility Proxy whose `connect` getter
    // can throw a V8 Proxy-invariant error on access. Grab the methods ONCE
    // (through the provider) inside a guard so a weird provider can never
    // crash the dashboard.
    try {
      if (typeof p.connect === "function") {
        p.connect({ onlyIfTrusted: true })
          .then((r) => {
            setConnected(true)
            setPublicKey(r.publicKey.toString())
          })
          .catch(() => {
            // user hasn't trusted this site yet; stay disconnected
          })
      }
      // listen for account changes / disconnects
      if (typeof p.on === "function") {
        p.on("accountChanged", (newKey: any) => {
          if (newKey) {
            setPublicKey(newKey.toString())
          } else {
            // account disconnected from the site
            setConnected(false)
            setPublicKey(null)
            setBalances(null)
          }
        })
        p.on("disconnect", () => {
          setConnected(false)
          setPublicKey(null)
          setBalances(null)
        })
      }
    } catch (e) {
      // A brittle provider (legacy proxy / race with provider injection)
      // shouldn't take the whole dashboard down. Connect-on-demand still works
      // via the explicit "Connect Phantom" button.
      console.warn("[use-wallet] silent reconnect skipped:", (e as Error)?.message ?? e)
    }
  }, [])

  const setRpc = useCallback((r: string) => {
    setRpcState(r)
    sharedConnection = null // force re-create on next getConnection
  }, [])

  const getConnection = useCallback((): Connection | null => {
    if (typeof window === "undefined") return null
    if (!sharedConnection) {
      try {
        sharedConnection = new SolConnection(rpc, "confirmed")
      } catch {
        return null
      }
    }
    return sharedConnection
  }, [rpc])

  const connect = useCallback(async () => {
    setError(null)
    setConnecting(true)
    try {
      const st = await connectWallet()
      setConnected(st.connected)
      setPublicKey(st.publicKey)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    try {
      await disconnectWallet()
    } catch {
      // ignore
    }
    setConnected(false)
    setPublicKey(null)
    setBalances(null)
  }, [])

  const refreshBalances = useCallback(
    async (prices: Record<string, number>) => {
      if (!publicKey) return
      const conn = getConnection()
      if (!conn) return
      setBalancesLoading(true)
      try {
        const b = await fetchWalletBalances(conn, publicKey, prices)
        setBalances(b)
      } catch (e: any) {
        setError(e?.message ?? String(e))
      } finally {
        setBalancesLoading(false)
      }
    },
    [publicKey, getConnection]
  )

  const shortAddress = publicKey
    ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`
    : ""

  return {
    installed,
    connecting,
    connected,
    publicKey,
    shortAddress,
    balances,
    balancesLoading,
    rpc,
    setRpc,
    error,
    connect,
    disconnect,
    refreshBalances,
    getProvider: getPhantomProvider,
    getConnection,
  }
}
