import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { BotsProvider } from "@/components/trading/BotsProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Jupiter Bot",
  description: "Automated Solana trading & arbitrage via Jupiter API — demo simulation with real market data.",
  keywords: ["Solana", "Jupiter", "Trading Bot", "Arbitrage", "DeFi", "Demo"],
  authors: [{ name: "Jupiter Bot" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Jupiter Bot",
    description: "Automated Solana trading & arbitrage via Jupiter API",
    siteName: "Jupiter Bot",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Jupiter Bot",
    description: "Automated Solana trading & arbitrage via Jupiter API",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* Mounted once at the root so every bot keeps running while the user
            moves between dashboards — they only stop on Stop (or a real-order
            rejection). */}
        <BotsProvider>{children}</BotsProvider>
        <Toaster />
      </body>
    </html>
  );
}
