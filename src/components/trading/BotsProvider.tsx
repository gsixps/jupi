'use client'

// Persistent bot registry.
//
// Every bot is instantiated ONCE here, in the root layout, and stays mounted
// for the whole session. That is what lets several bots work at the same time:
// you can start the Binance bot in demo, jump to Bybit, start that one in real
// mode, then go to Kraken — all of them keep scanning in the background and
// only stop when the user presses Stop (or the real path halts on a rejected
// order).
//
// Each bot gets its own React context so a tick in one bot re-renders only the
// pages watching that bot, not every other bot's dashboard.

import { createContext, useContext, useMemo } from 'react'

import { useWallet } from '@/hooks/use-wallet'
import { useLiveTrading } from '@/hooks/use-live-trading'
import { usePaperTrading } from '@/hooks/use-paper-trading'
import { useBinanceBot } from '@/hooks/use-binance'
import { useKrakenBot } from '@/hooks/use-kraken'
import { useCurveBot } from '@/hooks/use-curve'
import { useSeabot } from '@/hooks/use-seabot'
import { usePumpFunBot } from '@/hooks/use-pumpfun'
import { useCoinBot } from '@/hooks/use-coin'
import { useBybitBot } from '@/hooks/use-bybit'

export type BinanceBot = ReturnType<typeof useBinanceBot>
export type KrakenBot = ReturnType<typeof useKrakenBot>
export type CurveBot = ReturnType<typeof useCurveBot>
export type SeabotBot = ReturnType<typeof useSeabot>
export type PumpFunBot = ReturnType<typeof usePumpFunBot>
export type CoinBot = ReturnType<typeof useCoinBot>
export type BybitBot = ReturnType<typeof useBybitBot>
export type PaperBot = ReturnType<typeof usePaperTrading>
export type LiveBot = ReturnType<typeof useLiveTrading>
export type Wallet = ReturnType<typeof useWallet>

/**
 * Per-bot status for the tab bar.
 *
 * Deliberately only carries the coarse flags: it re-renders the tab bar when a
 * bot starts/stops or switches to real money, NOT on every price tick.
 */
export interface BotStatus {
  running: boolean
  real: boolean
  label: string
}

export interface BotStatusMap {
  jupiter: BotStatus
  binance: BotStatus
  kraken: BotStatus
  curve: BotStatus
  seabot: BotStatus
  pumpfun: BotStatus
  bitcoin: BotStatus
  eth: BotStatus
  bybit: BotStatus
}

function createBotContext<T>(name: string) {
  const Ctx = createContext<T | null>(null)
  Ctx.displayName = `${name}Context`
  function useBotContext(): T {
    const v = useContext(Ctx)
    if (v === null) {
      throw new Error(`use${name} must be used inside <BotsProvider>`)
    }
    return v
  }
  return { Ctx, useBotContext }
}

const jupiterPaperCtx = createBotContext<PaperBot>('PaperBot')
const jupiterLiveCtx = createBotContext<LiveBot>('LiveBot')
const walletCtx = createBotContext<Wallet>('Wallet')
const binanceCtx = createBotContext<BinanceBot>('BinanceBot')
const krakenCtx = createBotContext<KrakenBot>('KrakenBot')
const curveCtx = createBotContext<CurveBot>('CurveBot')
const seabotCtx = createBotContext<SeabotBot>('SeabotBot')
const pumpfunCtx = createBotContext<PumpFunBot>('PumpFunBot')
const coinBtcCtx = createBotContext<CoinBot>('CoinBotBtc')
const coinEthCtx = createBotContext<CoinBot>('CoinBotEth')
const bybitCtx = createBotContext<BybitBot>('BybitBot')
const statusCtx = createBotContext<BotStatusMap>('BotStatus')

export const usePaperBotContext = jupiterPaperCtx.useBotContext
export const useLiveBotContext = jupiterLiveCtx.useBotContext
export const useWalletContext = walletCtx.useBotContext
export const useBinanceBotContext = binanceCtx.useBotContext
export const useKrakenBotContext = krakenCtx.useBotContext
export const useCurveBotContext = curveCtx.useBotContext
export const useSeabotBotContext = seabotCtx.useBotContext
export const usePumpFunBotContext = pumpfunCtx.useBotContext
export const useCoinBtcContext = coinBtcCtx.useBotContext
export const useCoinEthContext = coinEthCtx.useBotContext
export const useBybitBotContext = bybitCtx.useBotContext
export const useBotStatusContext = statusCtx.useBotContext

export function BotsProvider({ children }: { children: React.ReactNode }) {
  // `useWallet` is lifted here on purpose: `useLiveTrading` needs the SAME
  // wallet instance, otherwise the two would drift apart.
  const wallet = useWallet()
  const live = useLiveTrading(wallet)
  const paper = usePaperTrading()

  const binance = useBinanceBot()
  const kraken = useKrakenBot()
  const curve = useCurveBot()
  const seabot = useSeabot()
  const pumpfun = usePumpFunBot(wallet)
  const coinBtc = useCoinBot('btc')
  const coinEth = useCoinBot('eth')
  const bybit = useBybitBot()

  const status = useMemo<BotStatusMap>(() => {
    const flags = (
      enabled: boolean,
      real: boolean,
      label: string
    ): BotStatus => ({ running: enabled, real: enabled && real, label })

    return {
      jupiter: flags(
        paper.enabled || live.enabled,
        live.enabled,
        'Jupiter Bot'
      ),
      binance: flags(binance.enabled, binance.config.liveTrading, 'Binance'),
      kraken: flags(kraken.enabled, kraken.config.liveTrading, 'Kraken'),
      curve: flags(curve.enabled, curve.config.liveTrading, 'Curve Finance'),
      seabot: flags(seabot.enabled, seabot.config.liveTrading, 'SeaBot'),
      pumpfun: flags(pumpfun.enabled, pumpfun.config.liveTrading, 'PumpFun'),
      bitcoin: flags(coinBtc.enabled, coinBtc.liveTrading, 'Bitcoin'),
      eth: flags(coinEth.enabled, coinEth.liveTrading, 'Eth'),
      bybit: flags(bybit.enabled, bybit.config.liveTrading, 'Bybit RWA'),
    }
  }, [paper.enabled, live.enabled, binance, kraken, curve, seabot, pumpfun, coinBtc, coinEth, bybit])

  return (
    <walletCtx.Ctx.Provider value={wallet}>
      <jupiterLiveCtx.Ctx.Provider value={live}>
        <jupiterPaperCtx.Ctx.Provider value={paper}>
          <binanceCtx.Ctx.Provider value={binance}>
            <krakenCtx.Ctx.Provider value={kraken}>
              <curveCtx.Ctx.Provider value={curve}>
                <seabotCtx.Ctx.Provider value={seabot}>
                  <pumpfunCtx.Ctx.Provider value={pumpfun}>
                    <coinBtcCtx.Ctx.Provider value={coinBtc}>
                      <coinEthCtx.Ctx.Provider value={coinEth}>
                        <bybitCtx.Ctx.Provider value={bybit}>
                          <statusCtx.Ctx.Provider value={status}>
                            {children}
                          </statusCtx.Ctx.Provider>
                        </bybitCtx.Ctx.Provider>
                      </coinEthCtx.Ctx.Provider>
                    </coinBtcCtx.Ctx.Provider>
                  </pumpfunCtx.Ctx.Provider>
                </seabotCtx.Ctx.Provider>
              </curveCtx.Ctx.Provider>
            </krakenCtx.Ctx.Provider>
          </binanceCtx.Ctx.Provider>
        </jupiterPaperCtx.Ctx.Provider>
      </jupiterLiveCtx.Ctx.Provider>
    </walletCtx.Ctx.Provider>
  )
}
