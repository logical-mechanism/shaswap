import Link from "next/link";
import { NetworkSwitcher } from "@/components/NetworkSwitcher";

const GITHUB_URL = "https://github.com/logical-mechanism/shaswap";

export function Footer() {
  return (
    <footer className="border-t border-border py-5 text-center text-xs text-muted">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-3 px-4 sm:flex-row sm:px-6">
        <span>
          ShaSwap — Pip’s fair little batch market on Cardano. Your keys, your coins.
        </span>
        <nav className="flex items-center gap-4">
          <Link href="/terms" className="transition-colors hover:text-accent">
            Terms
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-accent">
            Privacy
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="ShaSwap on GitHub"
            title="GitHub"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-accent"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub
          </a>
        </nav>
        <NetworkSwitcher />
      </div>
    </footer>
  );
}
