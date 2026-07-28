import type { Metadata } from "next";
import { Instrument_Serif, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const display = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-serif-src",
});
const sans = Geist({ subsets: ["latin"], variable: "--font-sans-src" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-src" });

export const metadata: Metadata = {
  title: "QuanTrade",
  description: "Agent-proposed paper trading for NSE and US equities",
};

/**
 * Root layout carries fonts and the page shell only. The signed-in navigation
 * lives in app/(app)/layout.tsx, so /login never renders authenticated chrome.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${display.variable} ${sans.variable} ${mono.variable} bg-bg text-text antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
