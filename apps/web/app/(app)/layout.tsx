import Link from "next/link";
import { SignOutButton } from "@/components/SignOutButton";

const NAV = [
  { href: "/", label: "Inbox" },
  { href: "/positions", label: "Positions" },
  { href: "/journal", label: "Journal" },
  { href: "/performance", label: "Performance" },
  { href: "/mind", label: "Mind" },
];

/** Chrome for the signed-in pages only. /login sits outside this group. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex flex-col md:flex-row">
      <header className="md:w-52 md:shrink-0 border-b md:border-b-0 md:border-r border-border md:min-h-dvh flex md:flex-col">
        <div className="px-5 py-4 flex-1">
          <Link href="/" className="serif text-2xl tracking-tight">
            Quan<span className="text-accent">Trade</span>
          </Link>
          <p className="text-xs text-muted mt-1">Paper only. No real money.</p>

          <nav className="hidden md:flex flex-col mt-6 gap-0.5">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="px-3 py-2 -mx-3 rounded-md text-sm text-muted hover:text-text hover:bg-surface transition-colors"
              >
                {n.label}
              </Link>
            ))}

            {/* In the flow rather than pinned to the bottom, where the dev
                tools badge sits on top of it. */}
            <div className="mt-6 pt-4 border-t border-border">
              <SignOutButton />
            </div>
          </nav>
        </div>
      </header>

      <main className="flex-1 px-4 md:px-8 py-6 pb-24 md:pb-10 max-w-5xl w-full">{children}</main>

      {/* Bottom tabs on mobile — approvals happen on a phone. */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 border-t border-border bg-surface grid grid-cols-5 z-10">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="py-3 text-center text-[11px] text-muted">
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
