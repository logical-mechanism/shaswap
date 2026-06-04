import type { Metadata } from "next";
import { Baloo_2, Nunito, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Nav } from "@/components/Nav";
import { MobileNav } from "@/components/MobileNav";
import { Footer } from "@/components/Footer";
import { BackdropDecor } from "@/components/decor";

// Rounded, friendly display face for headings + the wordmark.
const baloo = Baloo_2({
  variable: "--font-baloo",
  weight: ["500", "600", "700", "800"],
  subsets: ["latin"],
});

// Rounded, highly readable UI face for body + numbers.
const nunito = Nunito({
  variable: "--font-nunito",
  weight: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});

// Mono only for tx hashes / addresses (kept legible and aligned).
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Resolves the OG/Twitter image to an absolute URL (silences the build warning and
  // makes share cards work in production). Set NEXT_PUBLIC_SITE_URL on deploy.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  ),
  title: "ShaSwap: swap with Pip",
  description:
    "A cozy batch swap on Cardano. Non-custodial. Your keys, your coins.",
  openGraph: {
    title: "ShaSwap: swap with Pip",
    description: "A cozy batch swap on Cardano.",
    siteName: "ShaSwap",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ShaSwap: swap with Pip",
    description: "A cozy batch swap on Cardano.",
  },
};

// Applies the saved (or system) theme to <html> BEFORE first paint, so there's no
// flash of the wrong theme. Runs as the first thing in <body>.
const NO_FLASH_THEME = `(function(){try{var p=new URLSearchParams(location.search).get('theme');var t=p||localStorage.getItem('shaswap-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // suppressHydrationWarning: the no-FOUC script below adds the `dark` class to
      // <html> before React hydrates, so the server/client className differ by design.
      suppressHydrationWarning
      className={`${baloo.variable} ${nunito.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* suppressHydrationWarning: browser extensions (Grammarly, etc.) inject
          attributes like data-gr-ext-installed onto <body> before React hydrates,
          which is otherwise reported as a hydration mismatch. Suppresses only this
          element's attribute diff, one level deep — not our descendants. */}
      <body
        className="flex min-h-full flex-col pb-16 sm:pb-0"
        suppressHydrationWarning
      >
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
        {/* First focusable element: lets keyboard users skip the nav straight to content. */}
        <a
          href="#main"
          className="sr-only rounded-full bg-surface px-4 py-2 text-sm font-bold text-accent shadow-lg outline-2 outline-accent focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[70] focus:outline"
        >
          Skip to content
        </a>
        <BackdropDecor />
        <Providers>
          <Nav />
          <main id="main" tabIndex={-1} className="flex flex-1 flex-col">
            {children}
          </main>
          <Footer />
          <MobileNav />
        </Providers>
      </body>
    </html>
  );
}
