'use client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useCoinEthContext } from '@/components/trading/BotsProvider'
import { TrendPage } from '@/components/trend/TrendPage'

function EthInner() {
  const bot = useCoinEthContext()
  return <TrendPage bot={bot} />
}

export default function EthPage() {
  return (
    <TooltipProvider delayDuration={200}>
      <EthInner />
    </TooltipProvider>
  )
}
