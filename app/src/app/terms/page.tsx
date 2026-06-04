import type { Metadata } from "next";
import { LegalContact, LegalPage } from "@/components/legal/LegalPage";
import { LEGAL } from "@/lib/legal/config";

export const metadata: Metadata = {
  title: "Terms and Conditions | ShaSwap",
  description: "Terms and Conditions for using the ShaSwap site.",
};

/**
 * Terms and Conditions. Structure and language mirror SundaeSwap's public terms
 * (the comparable Cardano DEX we modeled our posture on) — the clauses they actually
 * rely on: entity↔protocol separation, eligibility self-attestation, assumption of
 * risk, "as is" disclaimer, limitation of liability, and a one-year limit on claims.
 * Adapted to ShaSwap's facts: an immutable protocol with no upgrade authority and no
 * governance token, non-custodial, no protocol fee. DRAFT — counsel must finalize.
 */
export default function TermsPage() {
  return (
    <LegalPage title="Terms and Conditions">
      <p>
        These Terms and Conditions (the &ldquo;Terms&rdquo;) govern your access to and
        use of the {LEGAL.protocol} website and interface (the &ldquo;Site&rdquo;).
        By accessing or using the Site, you agree to these Terms. If you do not agree,
        do not use the Site.
      </p>

      <h2>1. The Protocol</h2>
      <p>
        The {LEGAL.protocol} protocol (the &ldquo;Protocol&rdquo;) is free, public,
        open-source software consisting of a set of immutable and autonomous smart
        contracts deployed on the Cardano blockchain. It is a non-custodial,
        batch-auction decentralized exchange: orders are settled by untrusted,
        permissionless solvers and verified entirely on-chain. The Protocol does not
        hold your assets and does not constitute an account by which {LEGAL.entity} or
        any third party acts as a financial intermediary or custodian. Funds are
        controlled solely by your own keys and the public validator logic, and every
        well-formed order is reclaimable by its owner.
      </p>

      <h2>2. Relationship Between {LEGAL.entity} and the Protocol</h2>
      <p>
        Although {LEGAL.entity} developed much of the initial software code for the{" "}
        {LEGAL.protocol} Protocol, it does not provide, own, or control the Protocol,
        which runs independently as immutable smart contracts deployed on the Cardano
        blockchain. The Protocol&rsquo;s contracts are immutable: there is no admin key,
        no upgrade authority, and no privileged operator, and there is no governance
        token. Any new version is a separate, independent deployment. The Site is one of
        potentially many interfaces to the Protocol; you may interact with the Protocol
        through other interfaces or directly.
      </p>

      <h2>3. Eligibility</h2>
      <p>By accessing or using the Site, you represent and warrant that you:</p>
      <ul>
        <li>(i) are at least 18 years of age;</li>
        <li>
          (ii) are not barred from using the Protocol, the Site, or any connected
          services under any law applicable to you;
        </li>
        <li>
          (iii) will not interfere with the intended operation of the Protocol or the
          Site, including by hacking, submitting a virus, fraudulent information or
          tokens, or attempting to overload, &ldquo;flood,&rdquo; or &ldquo;crash&rdquo;
          the Protocol or the Site; and
        </li>
        <li>
          (iv) are, and your use of the Protocol is and will be, in compliance at all
          times with all laws, rules, regulations, or orders applicable to you.
        </li>
      </ul>

      <h2>4. Assumption of Risk</h2>
      <p>
        YOU EXPRESSLY AGREE THAT USE OF THE SITE OR THE PROTOCOL IS AT YOUR SOLE RISK.
        You acknowledge the risks of cryptographic and blockchain-based systems,
        including the volatility of digital assets, the irreversibility of blockchain
        transactions, the risk of losing access to your keys, and the risk that smart
        contracts may contain defects. You are solely responsible for evaluating any
        asset or transaction before acting and for the custody and security of your own
        wallet and keys.
      </p>

      <h2>5. Disclaimer of Warranties</h2>
      <p>
        THE PROTOCOL, THE SITE, AND ALL INFORMATION CONTAINED ON THE SITE ARE MADE
        ACCESSIBLE OR AVAILABLE ON AN &ldquo;AS IS&rdquo; AND &ldquo;AS
        AVAILABLE&rdquo; BASIS, WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR
        IMPLIED, INCLUDING THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
        PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
      </p>

      <h2>6. Limitation of Liability</h2>
      <p>
        IN NO EVENT SHALL {LEGAL.entity}, ITS AFFILIATES, OR THEIR RESPECTIVE OFFICERS,
        DIRECTORS, EMPLOYEES, OR CONTRACTORS BE LIABLE FOR ANY DAMAGES ARISING OUT OF OR
        RELATED TO: (I) YOUR USE OF OR INABILITY TO USE THE PROTOCOL OR THE SITE,
        INCLUDING (A) DIRECT, INDIRECT, INCIDENTAL, SPECIAL, PUNITIVE, OR CONSEQUENTIAL
        DAMAGES, AND (B) LOSS OF REVENUES, PROFITS, GOODWILL, CRYPTOCURRENCIES, TOKENS,
        OR ANYTHING ELSE OF VALUE.
      </p>

      <h2>7. Time Limitation on Claims</h2>
      <p>
        YOU AGREE THAT ANY CAUSE OF ACTION ARISING OUT OF OR RELATED TO THE SITE MUST
        COMMENCE WITHIN ONE (1) YEAR AFTER THE CAUSE OF ACTION ACCRUES, OR THE CAUSE OF
        ACTION IS PERMANENTLY BARRED.
      </p>

      <LegalContact section={8} document="these Terms" />
    </LegalPage>
  );
}
