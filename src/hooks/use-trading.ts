'use client'

// Convenience re-exports so components can `import { useTrading } from '@/hooks/use-trading'`.
// The actual store lives in @/lib/store to avoid prop drilling and allow fine-grained
// subscriptions via useTradingStore(selector).
export {
  useTradingStore,
  useTrading,
  type LogEntry,
  type StateSnapshot,
} from '@/lib/store'
