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
import { useTrendBot } from '@/hooks/use-trend'
import { useBybitBot } from '@/hooks/use-bybit'
import { useCarryBot } from '@/hooks/use-carry'

export type BinanceBot = ReturnType<typeof useBinanceBot>
export type KrakenBot = ReturnType<typeof useKrakenBot>
export type CurveBot = ReturnType<typeof useCurveBot>
export type SeabotBot = ReturnType<typeof useSeabot>
export type PumpFunBot = ReturnType<typeof usePumpFunBot>
export type CoinBot = ReturnType<typeof useTrendBot>
export type BybitBot = ReturnType<typeof useBybitBot>
export type CarryBot = ReturnType<typeof useCarryBot>
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
  carry: BotStatus
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
const carryCtx = createBotContext<CarryBot>('CarryBot')
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
export const useCarryBotContext = carryCtx.useBotContext
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
  // Bitcoin / Eth tabs run the trend-following bot (Donchian + EMA on 4h)
  const coinBtc = useTrendBot('btc')
  const coinEth = useTrendBot('eth')
  const bybit = useBybitBot()
  const carry = useCarryBot()

  // Coarse primitives for the tab bar. Reading them here keeps the memo below
  // from depending on the bot objects, whose identity changes on every tick.
  const flags = (
    enabled: boolean,
    real: boolean,
    label: string
  ): BotStatus => ({ running: enabled, real: enabled && real, label })
  const paperEnabled = paper.enabled
  const liveEnabled = live.enabled
  const binanceEnabled = binance.enabled
  const binanceLive = binance.config.liveTrading
  const krakenEnabled = kraken.enabled
  const krakenLive = kraken.config.liveTrading
  const curveEnabled = curve.enabled
  const curveLive = curve.config.liveTrading
  const seabotEnabled = seabot.enabled
  const seabotLive = seabot.config.liveTrading
  const pumpfunEnabled = pumpfun.enabled
  const pumpfunLive = pumpfun.config.liveTrading
  const btcEnabled = coinBtc.enabled
  const btcLive = coinBtc.liveTrading
  const ethEnabled = coinEth.enabled
  const ethLive = coinEth.liveTrading
  const bybitEnabled = bybit.enabled
  const bybitLive = bybit.config.liveTrading
  const carryEnabled = carry.enabled
  const carryLive = carry.liveTrading

  // Depend on the primitive flags only. Depending on the bot objects would
  // rebuild this map on every price tick and re-render the tab bar constantly.
  const status = useMemo<BotStatusMap>(
    () => ({
      jupiter: flags(paperEnabled || liveEnabled, liveEnabled, 'Jupiter Bot'),
      binance: flags(binanceEnabled, binanceLive, 'Binance'),
      kraken: flags(krakenEnabled, krakenLive, 'Kraken'),
      curve: flags(curveEnabled, curveLive, 'Curve Finance'),
      seabot: flags(seabotEnabled, seabotLive, 'SeaBot'),
      pumpfun: flags(pumpfunEnabled, pumpfunLive, 'PumpFun'),
      bitcoin: flags(btcEnabled, btcLive, 'Bitcoin'),
      eth: flags(ethEnabled, ethLive, 'Eth'),
      bybit: flags(bybitEnabled, bybitLive, 'Bybit RWA'),
      carry: flags(carryEnabled, carryLive, 'Rendimiento'),
    }),
    [
      paperEnabled,
      liveEnabled,
      binanceEnabled,
      binanceLive,
      krakenEnabled,
      krakenLive,
      curveEnabled,
      curveLive,
      seabotEnabled,
      seabotLive,
      pumpfunEnabled,
      pumpfunLive,
      btcEnabled,
      btcLive,
      ethEnabled,
      ethLive,
      bybitEnabled,
      bybitLive,
      carryEnabled,
      carryLive,
    ]
  )

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
                        <carryCtx.Ctx.Provider value={carry}>
                          <statusCtx.Ctx.Provider value={status}>
                            {children}
                          </statusCtx.Ctx.Provider>
                        </carryCtx.Ctx.Provider>
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
