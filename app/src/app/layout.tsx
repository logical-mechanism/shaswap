import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "@meshsdk/react/styles.css";
import { Providers } from "@/components/Providers";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ShaSwap — Cardano batch-auction DEX",
  description:
    "Non-custodial, MEV-resistant batch-auction DEX on Cardano. Skeleton preview.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* suppressHydrationWarning: browser extensions (Grammarly, etc.) inject
          attributes like data-gr-ext-installed onto <body> before React hydrates,
          which is otherwise reported as a hydration mismatch. Suppresses only this
          element's attribute diff, one level deep — not our descendants. */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        <Providers>
          <Nav />
          <main className="flex flex-1 flex-col">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
