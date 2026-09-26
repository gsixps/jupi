// Trading engine entry point - socket.io server on port 3003
import { createServer } from "http"
import { Server } from "socket.io"
import "dotenv/config"
import * as fs from "fs"
import { TradingEngine } from "./lib/engine"
import { EVENTS } from "./lib/types"

const PORT = Number(process.env.PORT ?? 3003)
const LOG_FILE = process.env.ENGINE_LOG || "/home/z/my-project/engine.log"

// In daemon mode, bun sometimes reassigns stdout/stderr to /dev/null.
// Wrap console.log/error to also append to the log file so we have visibility.
function appendLog(level: string, args: unknown[]): void {
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })()))
      .join(" ")}\n`
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    // ignore - logging best effort
  }
}

const _origLog = console.log.bind(console)
const _origErr = console.error.bind(console)
console.log = (...args: unknown[]) => { _origLog(...args); appendLog("log", args) }
console.error = (...args: unknown[]) => { _origErr(...args); appendLog("err", args) }
console.warn = (...args: unknown[]) => { _origErr(...args); appendLog("warn", args) }

const httpServer = createServer()
const io = new Server(httpServer, {
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

const engine = new TradingEngine(io)
engine
  .init()
  .then(() => {
    console.log("Trading engine initialized")
  })
  .catch((e) => {
    console.error("Engine init failed", e)
    process.exit(1)
  })

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id)
  socket.emit(EVENTS.CONNECTED, { ok: true, time: Date.now() })
  // send snapshot once engine is ready
  engine.emitState(socket)

  socket.on(EVENTS.GET_STATE, () => engine.emitState(socket))
  socket.on(EVENTS.START, () => engine.start())
  socket.on(EVENTS.STOP, () => engine.stop())
  socket.on(EVENTS.UPDATE_CONFIG, (cfg) => engine.handleUpdateConfig(cfg ?? {}))
  socket.on("disconnect", () => console.log("Client disconnected:", socket.id))
})

httpServer.listen(PORT, () => console.log(`Trading engine on port ${PORT}`))

// graceful shutdown
process.on("SIGTERM", () => httpServer.close(() => process.exit(0)))
process.on("SIGINT", () => httpServer.close(() => process.exit(0)))
