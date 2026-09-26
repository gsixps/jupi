import Link from "next/link"
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Cpu,
  Gauge,
  LineChart,
  Lock,
  Radar,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Separator } from "@/components/ui/separator"

const tickers = [
  { pair: "SOL/USDC", price: "$148.32", change: "+3.4%" },
  { pair: "JUP/USDC", price: "$0.92", change: "+1.8%" },
  { pair: "BONK/USDC", price: "$0.0000241", change: "-0.6%" },
  { pair: "WIF/USDC", price: "$2.11", change: "+2.2%" },
]

const features = [
  {
    icon: Radar,
    title: "Live Arbitrage Scanning",
    description:
      "Continuously scans every Solana route through the Jupiter API to surface arbitrage windows the moment they appear.",
  },
  {
    icon: Bot,
    title: "Fully Automated Execution",
    description:
      "The engine routes swaps atomically, with slippage guardrails and automatic USDC funding from your real wallet.",
  },
  {
    icon: LineChart,
    title: "Real-Time Equity & PnL",
    description:
      "Equity curves, open positions and trade history stream live over a WebSocket engine to your dashboard.",
  },
  {
    icon: Wallet,
    title: "Paper Trading Included",
    description:
      "Stress-test strategies with market-fresh data and zero capital before you turn on live execution.",
  },
  {
    icon: ShieldCheck,
    title: "Non-Custodial & Secure",
    description:
      "Your keys never leave your wallet. The bot only ever signs transfers you authorize, through your connected wallet.",
  },
  {
    icon: Gauge,
    title: "One-Click Deployment",
    description:
      "Optimized for Vercel with a serverless build and a Postgres database that keeps your history persistent.",
  },
]

const steps = [
  {
    step: "01",
    title: "Connect your wallet",
    description:
      "Link your Phantom or Solana wallet. Your keys stay with you — the bot only reads balances and signs what you approve.",
  },
  {
    step: "02",
    title: "Pick a strategy",
    description:
      "Choose live arbitrage, momentum or paper trading. Set risk limits, slippage tolerance and position sizing in seconds.",
  },
  {
    step: "03",
    title: "Let the engine trade",
    description:
      "The engine runs 24/7, routing swaps via Jupiter and reporting live equity, fills and logs to your dashboard.",
  },
]

const pricing = [
  {
    name: "Starter",
    price: "5%",
    period: "fee · up to $1,000 capital",
    description: "Managed fee for small accounts getting started with live trading.",
    features: [
      "5% fee on managed capital",
      "Up to $1,000 capital",
      "28-day plan (2,419,200 s)",
      "Live arbitrage engine",
      "Real-time equity charts",
    ],
    cta: "Start trading",
    highlight: false,
  },
  {
    name: "Trader",
    price: "2%",
    period: "fee · up to $50,000 capital",
    description: "For active solo traders scaling capital on live strategies.",
    features: [
      "2% fee on managed capital",
      "Up to $50,000 capital",
      "28-day plan (2,419,200 s)",
      "5 concurrent strategies",
      "Priority WebSocket feed",
    ],
    cta: "Start trading",
    highlight: true,
  },
  {
    name: "Institutional",
    price: "1%",
    period: "fee · from $50,000 capital",
    description: "For funds scaling allocation across many wallets.",
    features: [
      "1% fee on managed capital",
      "From $50,000 capital",
      "28-day plan (2,419,200 s)",
      "Unlimited strategies",
      "SLA & dedicated deployment",
    ],
    cta: "Start trading",
    highlight: false,
  },
  {
    name: "Pay-as-you-go",
    price: "10%",
    period: "per use · no commitment",
    description: "Per-use billing with no stay time — pay only for what you run.",
    features: [
      "10% fee per use",
      "No commitment time",
      "Billed in seconds",
      "Cancel anytime",
      "All core features included",
    ],
    cta: "Start trading",
    highlight: false,
  },
]

const faqs = [
  {
    q: "Do you ever control my private keys?",
    a: "No. The bot is non-custodial — you connect your own wallet and every transaction is signed from your side. We never request or store private keys.",
  },
  {
    q: "Which network and API does the engine use?",
    a: "Solana mainnet through the Jupiter aggregation API. All token routes, prices and arbitrage paths are computed against live market data.",
  },
  {
    q: "Can I test before using real money?",
    a: "Absolutely. Every account starts with full paper trading on live market data so you can validate any strategy risk-free before enabling live funding.",
  },
  {
    q: "Where is my trade history stored?",
    a: "Trades, equity points and positions are persisted in a Postgres database connected to your deployment, so your dashboard survives restarts.",
  },
  {
    q: "How do I deploy the platform?",
    a: "The project builds cleanly for Vercel (serverless). Follow the deployment guide: connect the repo, add your DATABASE_URL and deploy in one click.",
  },
]

export default function MarketingPage() {
  return (
    <div className="relative min-h-screen overflow-x-clip bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[42rem] bg-[radial-gradient(60%_50%_at_50%_-10%,rgba(16,185,129,0.22),transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-[-10rem] top-40 -z-10 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,rgba(16,185,129,0.14),transparent_65%)]"
      />

      <header className="sticky top-0 z-40 border-b border-border/50 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <a href="#top" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
              <Zap className="size-4" />
            </span>
            <span>
              Jupiter<span className="text-emerald-400">Bot</span>
            </span>
          </a>
          <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#how-it-works" className="transition-colors hover:text-foreground">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-foreground">
              Pricing
            </a>
            <a href="#faq" className="transition-colors hover:text-foreground">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
              <Link href="/dashboard">Sign in</Link>
            </Button>
            <Button asChild size="sm" className="gap-1.5 bg-emerald-500 text-emerald-950 hover:bg-emerald-400">
              <Link href="/dashboard">
                Launch app <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <section id="top" className="pt-24 pb-16 text-center md:pt-32">
          <Badge variant="outline" className="mb-6 gap-1.5 border-emerald-500/30 text-emerald-400">
            <Sparkles className="size-3.5" />
            Automate Solana trading on Jupiter
          </Badge>
          <h1 className="mx-auto max-w-3xl text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl md:text-6xl">
            Trade Solana on autopilot with a{" "}
            <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              self-driving engine
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            JupiterBot scans every route, executes atomically through the Jupiter API and streams
            your equity live — so you can deploy, monitor and scale 24/7 without staring at
            charts.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg" className="gap-2 bg-emerald-500 px-7 text-emerald-950 hover:bg-emerald-400">
              <Link href="/dashboard">
                Open live dashboard <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="px-7">
              <Link href="#pricing">View pricing</Link>
            </Button>
          </div>
          <p className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-emerald-400" />
            No credit card required · Non-custodial · Live market data
          </p>
        </section>

        <section aria-label="Tickers" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border/40 md:grid-cols-4">
          {tickers.map((t) => (
            <div key={t.pair} className="bg-card px-5 py-4">
              <p className="text-sm font-medium">{t.pair}</p>
              <p className="mt-1 flex items-baseline justify-between gap-2">
                <span className="font-mono text-sm">{t.price}</span>
                <span className={t.change.startsWith("-") ? "text-xs text-rose-400" : "text-xs text-emerald-400"}>
                  {t.change}
                </span>
              </p>
            </div>
          ))}
        </section>

        <section id="features" className="scroll-mt-24 py-24">
          <div className="mx-auto max-w-2xl text-center">
            <Badge variant="outline" className="mb-4 text-emerald-400">
              Features
            </Badge>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              Everything an automated strategy needs
            </h2>
            <p className="mt-4 text-muted-foreground">
              A lean, deployable stack: Next.js dashboard, WebSocket trading engine and the
              Solana ecosystem — wired together.
            </p>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Card key={f.title} className="group border-border/70 bg-card/60 transition-colors hover:border-emerald-500/40">
                <CardHeader>
                  <div className="mb-3 flex size-11 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 transition-colors group-hover:bg-emerald-500/20">
                    <f.icon className="size-5" />
                  </div>
                  <CardTitle className="text-lg">{f.title}</CardTitle>
                  <CardDescription className="text-sm leading-relaxed">{f.description}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <Badge variant="outline" className="mb-4 text-emerald-400">
              How it works
            </Badge>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Live in three steps</h2>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.step} className="relative rounded-xl border border-border/70 bg-card/60 p-6">
                <span className="font-mono text-sm font-semibold text-emerald-400">{s.step}</span>
                <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="pricing" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <Badge variant="outline" className="mb-4 text-emerald-400">
              Pricing
            </Badge>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Simple plans that scale</h2>
            <p className="mt-4 text-muted-foreground">
              Transparent managed fees by capital tier — every plan runs for 28 days (2,419,200 s) or pay-per-use.
            </p>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {pricing.map((p) => (
              <Card
                key={p.name}
                className={
                  p.highlight
                    ? "relative border-emerald-500/50 bg-emerald-500/5 shadow-[0_0_40px_-12px_rgba(16,185,129,0.35)]"
                    : "border-border/70 bg-card/60"
                }
              >
                {p.highlight && (
                  <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-emerald-950">
                    Most popular
                  </Badge>
                )}
                <CardHeader>
                  <CardTitle className="text-lg">{p.name}</CardTitle>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-3xl font-extrabold tracking-tight">{p.price}</span>
                    <span className="text-sm text-muted-foreground">{p.period}</span>
                  </div>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <ul className="space-y-2.5 text-sm">
                    {p.features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Button
                    asChild
                    variant={p.highlight ? "default" : "outline"}
                    className={p.highlight ? "w-full bg-emerald-500 text-emerald-950 hover:bg-emerald-400" : "w-full"}
                  >
                    <Link href="/dashboard">{p.cta}</Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section id="faq" className="scroll-mt-24 pb-24">
          <div className="mx-auto max-w-2xl text-center">
            <Badge variant="outline" className="mb-4 text-emerald-400">
              FAQ
            </Badge>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Questions, answered</h2>
          </div>
          <div className="mx-auto mt-10 max-w-3xl">
            <Accordion type="single" collapsible className="w-full">
              {faqs.map((f, i) => (
                <AccordionItem key={f.q} value={`item-${i}`}>
                  <AccordionTrigger className="text-left">{f.q}</AccordionTrigger>
                  <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                    {f.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      </div>

      <section className="border-t border-border/50 bg-gradient-to-b from-emerald-500/10 to-transparent">
        <div className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
            <Cpu className="size-6" />
          </div>
          <h2 className="mx-auto mt-6 max-w-2xl text-3xl font-bold tracking-tight md:text-4xl">
            Put your Solana strategy on autopilot today
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Connect a wallet, choose a mode and watch the engine trade while you focus on
            everything else.
          </p>
          <Button asChild size="lg" className="mt-8 gap-2 bg-emerald-500 px-8 text-emerald-950 hover:bg-emerald-400">
            <Link href="/dashboard">
              Launch JupiterBot <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </section>

      <footer className="border-t border-border/50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
              <Zap className="size-3.5" />
            </span>
            JupiterBot — automate wire, keep control.
          </div>
          <div className="flex items-center gap-5">
            <span className="flex items-center gap-1.5">
              <Lock className="size-3.5" /> Non-custodial
            </span>
            <span className="flex items-center gap-1.5">
              <Activity className="size-3.5" /> Live market data
            </span>
            <Separator orientation="vertical" className="h-4" />
            <span>© {new Date().getFullYear()} JupiterBot</span>
          </div>
        </div>
      </footer>
    </div>
  )
}