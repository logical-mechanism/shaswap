import type { Metadata } from "next";
import Link from "next/link";
import { LegalContact, LegalPage } from "@/components/legal/LegalPage";
import { LEGAL } from "@/lib/legal/config";

export const metadata: Metadata = {
  title: "Privacy Policy | ShaSwap",
  description: "Privacy Policy for the ShaSwap site.",
};

/**
 * Privacy Policy. Modeled on SundaeSwap's: contemplates worldwide access, treats
 * on-chain (staking/payment) addresses as public blockchain data rather than personal
 * information, and describes no compliance-driven data collection. Kept honest to
 * ShaSwap's actual data flow: no accounts, no KYC, local-only preferences and
 * activity logs, and a chain-data provider (reads plus draft-tx evaluation) behind
 * the data-access abstraction.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        This Privacy Policy describes how {LEGAL.entity} (&ldquo;we&rdquo;) handles
        information in connection with the {LEGAL.protocol} website and interface (the
        &ldquo;Site&rdquo;). The Site is owned by {LEGAL.entity} and may be accessed in
        the United States and abroad.
      </p>

      <h2>1. No Accounts, No KYC</h2>
      <p>
        The Site does not require you to create an account and does not collect names,
        email addresses, government identifiers, or other identity information to use
        it. The {LEGAL.protocol} protocol (the &ldquo;Protocol&rdquo;) is non-custodial:
        you interact with it directly from your own wallet, and we do not take custody
        of your assets.
      </p>

      <h2>2. On-Chain Information</h2>
      <p>
        Cardano is a public blockchain. Wallet addresses (including staking and payment
        addresses), balances, and transactions are public on-chain data, visible to
        anyone, and are not treated by us as personal information. We do not link wallet
        addresses to your identity.
      </p>

      <h2>3. Information Stored Locally</h2>
      <p>
        The Site stores data in your browser&rsquo;s local storage on your device: your
        display-theme preference, a record that you accepted the current{" "}
        <Link href="/terms">Terms</Link> and this Privacy Policy, the name of the wallet
        you connected (so the Site can reconnect to it), a short-lived log of your
        recent orders and liquidity actions keyed to your wallet address (kept for
        about a day so the Site can show pending activity), and minor interface state
        such as dismissed hints. This data stays on your device and is not transmitted
        to us. You can clear it at any time through your browser.
      </p>

      <h2>4. Chain Data Provider</h2>
      <p>
        To display pools, balances, and quotes, the Site reads public blockchain data
        through a third-party data provider. These reads are server-side. For some
        actions (such as reclaims and liquidity transactions), the draft transaction you
        build in the app is also sent through the same provider to estimate its
        execution budget; a draft contains only data that becomes public if you submit
        the transaction. Signed transactions are submitted by your own wallet, not by
        the Site. We do not sell your information and do not use it for advertising.
      </p>

      <h2>5. Server Logs</h2>
      <p>
        Like most websites, our hosting provider may automatically record standard
        technical request data (such as IP address, browser type, and timestamps) for
        security and reliability. We do not use this data to identify you and do not
        combine it with on-chain activity.
      </p>

      <h2>6. Changes</h2>
      <p>
        We may update this Privacy Policy from time to time. The &ldquo;Last
        updated&rdquo; date above reflects the current version.
      </p>

      <LegalContact section={7} document="this Privacy Policy" />
    </LegalPage>
  );
}
