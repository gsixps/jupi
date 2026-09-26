// Browser polyfill for Buffer (used by @solana/web3.js).
// Browsers don't have a global Buffer, so we install one from the `buffer`
// package before any @solana/web3.js code runs.
//
// Import this module FIRST in any client component that uses @solana/web3.js
// or @/lib/wallet / @/lib/jupiter-swap.

import { Buffer } from "buffer"

if (typeof window !== "undefined") {
  // @ts-ignore — Buffer is a Node global; we polyfill it for the browser.
  if (typeof window.Buffer === "undefined") {
    // @ts-ignore
    window.Buffer = Buffer
  }
  // @ts-ignore
  if (typeof globalThis.Buffer === "undefined") {
    // @ts-ignore
    globalThis.Buffer = Buffer
  }
}

export { Buffer }
