import type { Metadata } from "next";
import { Instrument_Serif, Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const display = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
});
const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "QuanTrade",
  description: "Agent-proposed paper trading for NSE and US equities",
};

const NAV = [
  { href: "/", label: "Inbox" },
  { href: "/positions", label: "Positions" },
  { href: "/journal", label: "Journal" },
  { href: "/performance", label: "Performance" },
  { href: "/mind", label: "Mind" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${sans.variable} ${mono.variable} font-[family-name:var(--font-sans)]`}>
        <div className="min-h-dvh flex flex-col md:flex-row">
          <header className="md:w-52 md:shrink-0 border-b md:border-b-0 md:border-r border-[--color-border]">
            <div className="px-5 py-4">
              <Link href="/" className="font-[family-name:var(--font-display)] text-2xl tracking-tight">
                Quan<span className="text-[--color-accent]">Trade</span>
              </Link>
              <p className="text-xs text-[--color-muted] mt-1">Paper only. No real money.</p>
            </div>
            <nav className="hidden md:flex flex-col px-2 pb-4 gap-0.5">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="px-3 py-2 rounded-md text-sm text-[--color-muted] hover:text-[--color-text] hover:bg-[--color-surface]"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </header>

          <main className="flex-1 px-4 md:px-8 py-6 pb-24 md:pb-8 max-w-5xl w-full">{children}</main>

          {/* Bottom tabs on mobile — the approval flow happens on a phone. */}
          <nav className="md:hidden fixed bottom-0 inset-x-0 border-t border-[--color-border] bg-[--color-surface] grid grid-cols-5">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="py-3 text-center text-[11px] text-[--color-muted]">
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      </body>
    </html>
  );
}
