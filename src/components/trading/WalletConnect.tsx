'use client'

import { useState } from 'react'
import {
  AlertCircle,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  Wallet,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { UseWallet } from '@/hooks/use-wallet'
import { fmtUsd, fmtNum } from '@/lib/format'
import { SOL_MINT } from '@/lib/tokens'

interface WalletConnectProps {
  /**
   * The wallet instance from useWallet(). The page lifts the call to
   * useWallet() so that the live trading hook and this card share state.
   */
  wallet: UseWallet
  /** Live prices from the trading hook, used to value balances. */
  prices: Record<string, number>
}

/**
 * Phantom wallet connection card.
 * - If no wallet installed: warning + Phantom install link.
 * - If not connected: Connect button (shows wallet.error if any).
 * - If connected: address (short + copy), disconnect, balance breakdown,
 *   refresh button, total portfolio USD value.
 */
export function WalletConnect({ wallet, prices }: WalletConnectProps) {
  const [copied, setCopied] = useState(false)

  const copyAddress = async () => {
    if (!wallet.publicKey) return
    try {
      await navigator.clipboard.writeText(wallet.publicKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked — ignore
    }
  }

  // ---- not installed ----
  if (!wallet.installed) {
    return (
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4 text-rose-400" />
            Wallet Not Detected
          </CardTitle>
          <CardDescription className="mt-1">
            Install a Solana wallet to enable live trading.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3">
          <Alert className="border-amber-500/30 bg-amber-500/5 text-amber-200">
            <AlertCircle className="text-amber-400" />
            <AlertDescription>
              No Solana wallet (e.g. Phantom) was found in this browser. Live
              trading requires a wallet extension to sign on-chain swap
              transactions.
            </AlertDescription>
          </Alert>
          <Button asChild className="mt-3 w-full gap-2">
            <a href="https://phantom.app" target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Install Phantom
            </a>
          </Button>
        </CardContent>
      </Card>
    )
  }

  // ---- not connected ----
  if (!wallet.connected) {
    return (
      <Card className="p-4 md:p-6">
        <CardHeader className="p-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4 text-emerald-400" />
            Connect Phantom
          </CardTitle>
          <CardDescription className="mt-1">
            Sign in with your Solana wallet to start live trading.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-3 space-y-3">
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-[11px] text-muted-foreground">
            Phantom will pop up to approve the connection. Your private key
            never leaves your wallet — only public-key + signing requests.
          </div>
          {wallet.error && (
            <Alert className="border-rose-500/30 bg-rose-500/5 text-rose-200">
              <AlertCircle className="text-rose-400" />
              <AlertDescription>{wallet.error}</AlertDescription>
            </Alert>
          )}
          <Button
            onClick={() => wallet.connect()}
            disabled={wallet.connecting}
            className="w-full gap-2 bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {wallet.connecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wallet className="size-4" />
            )}
            {wallet.connecting ? 'Connecting…' : 'Connect Phantom'}
          </Button>
        </CardContent>
      </Card>
    )
  }

  // ---- connected ----
  const balances = wallet.balances
  const totalUsd = balances?.totalUsd ?? 0
  const solUsd = balances?.solUsd ?? 0
  const sol = balances?.sol ?? 0
  const solPrice = prices[SOL_MINT] ?? 0
  const tokenRows =
    balances?.tokens
      .filter((t) => t.amount > 0)
      .sort((a, b) => b.usdValue - a.usdValue) ?? []

  return (
    <Card className="p-4 md:p-6">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="size-4 text-emerald-400" />
              Phantom Wallet
            </CardTitle>
            <CardDescription className="mt-1">
              Connected to Solana mainnet
            </CardDescription>
          </div>
          <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
            Connected
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0 pt-3 space-y-3">
        {/* Address row */}
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 font-mono text-xs">
            {wallet.shortAddress}
          </code>
          <Button
            size="icon"
            variant="outline"
            onClick={copyAddress}
            aria-label="Copy address"
            className="size-8"
          >
            {copied ? (
              <Check className="size-3.5 text-emerald-400" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </div>

        {/* Disconnect — prominent, labeled button */}
        <Button
          variant="outline"
          onClick={() => wallet.disconnect()}
          className="w-full gap-2 border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20"
        >
          <LogOut className="size-4" />
          Disconnect Wallet
        </Button>

        <Separator />

        {/* Total portfolio */}
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Total Portfolio
          </span>
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tabular-nums">
              {fmtUsd(totalUsd)}
            </span>
            <Button
              size="icon"
              variant="outline"
              onClick={() => wallet.refreshBalances(prices)}
              disabled={wallet.balancesLoading}
              aria-label="Refresh balances"
              title="Refresh balances"
              className="size-7"
            >
              <RefreshCw
                className={`size-3.5 ${wallet.balancesLoading ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
        </div>

        {wallet.error && (
          <Alert className="border-rose-500/30 bg-rose-500/5 text-rose-200">
            <AlertCircle className="text-rose-400" />
            <AlertDescription>{wallet.error}</AlertDescription>
          </Alert>
        )}

        {/* SOL row */}
        <div className="space-y-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Native SOL
          </span>
          <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-violet-400" />
              <span className="text-sm font-medium">SOL</span>
              <span className="text-[10px] text-muted-foreground">native</span>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium tabular-nums">
                {fmtNum(sol, 4)} SOL
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums">
                {fmtUsd(solPrice > 0 ? solUsd : sol * solPrice)}
              </div>
            </div>
          </div>
        </div>

        {/* SPL tokens */}
        {tokenRows.length > 0 && (
          <div className="space-y-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              SPL Tokens
            </span>
            <div className="space-y-1.5">
              {tokenRows.map((t) => (
                <div
                  key={t.mint}
                  className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: tokenColor(t.symbol) }}
                    />
                    <span className="text-sm font-medium">{t.symbol}</span>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium tabular-nums">
                      {fmtNum(t.amount, 4)} {t.symbol}
                    </div>
                    <div className="text-[10px] text-muted-foreground tabular-nums">
                      {fmtUsd(t.usdValue)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {balances === null && (
          <div className="text-[11px] text-muted-foreground">
            Tap refresh to load on-chain balances.
          </div>
        )}

        {/* RPC endpoint */}
        <Separator />
        <div className="space-y-1.5">
          <Label htmlFor="rpc" className="text-xs">
            RPC Endpoint
          </Label>
          <Input
            id="rpc"
            value={wallet.rpc}
            onChange={(e) => wallet.setRpc(e.target.value)}
            className="h-8 text-xs"
            placeholder="https://solana-rpc.publicnode.com"
          />
          <p className="text-[10px] text-muted-foreground">
            For better reliability, use a paid RPC (Helius/QuickNode). The
            public mainnet RPC is rate-limited.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

function tokenColor(symbol: string): string {
  const map: Record<string, string> = {
    USDC: 'rgb(45 212 191)',
    USDT: 'rgb(45 212 191)',
    JUP: 'rgb(168 85 247)',
    BONK: 'rgb(245 158 11)',
    WIF: 'rgb(244 63 94)',
    PYTH: 'rgb(168 85 247)',
    RAY: 'rgb(16 185 129)',
    JTO: 'rgb(20 184 166)',
  }
  return map[symbol] ?? 'rgb(161 161 170)'
}
