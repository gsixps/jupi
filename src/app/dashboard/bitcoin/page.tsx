'use client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useCoinBtcContext } from '@/components/trading/BotsProvider'
import { TrendPage } from '@/components/trend/TrendPage'

function BitcoinInner() {
  const bot = useCoinBtcContext()
  return <TrendPage bot={bot} />
}

export default function BitcoinPage() {
  return (
    <TooltipProvider delayDuration={200}>
      <BitcoinInner />
    </TooltipProvider>
  )
}
