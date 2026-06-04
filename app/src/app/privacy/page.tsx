import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/LegalPage";
import { LEGAL } from "@/lib/legal/config";

export const metadata: Metadata = {
  title: "Privacy Policy | ShaSwap",
  description: "Privacy Policy for the ShaSwap site.",
};

/**
 * Privacy Policy. Modeled on SundaeSwap's: contemplates worldwide access, treats
 * on-chain (staking/payment) addresses as public blockchain data rather than personal
 * information, and describes no compliance-driven data collection. Kept honest to
 * ShaSwap's actual data flow: no accounts, no KYC, local-only preferences, and a
 * read-only chain-data provider behind the data-access abstraction. DRAFT — counsel
 * must finalize.
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
        it. {LEGAL.protocol} is non-custodial: you interact with the Protocol directly
        from your own wallet, and we do not take custody of your assets.
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
        The Site stores a small amount of data in your browser&rsquo;s local storage on
        your device &mdash; for example, your display-theme preference and a record that
        you accepted the current{" "}
        <a href="/terms">Terms</a> and this Privacy Policy. This data stays on your
        device and is not transmitted to us. You can clear it at any time through your
        browser.
      </p>

      <h2>4. Chain Data Provider</h2>
      <p>
        To display pools, balances, and quotes, the Site reads public blockchain data
        through a third-party data provider. These reads are server-side and read-only;
        we do not sell your information and do not use it for advertising.
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

      <h2>7. Contact</h2>
      <p>
        Questions about this Privacy Policy may be sent to{" "}
        <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.
      </p>
    </LegalPage>
  );
}
