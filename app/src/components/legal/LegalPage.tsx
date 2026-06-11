import { LEGAL } from "@/lib/legal/config";

/**
 * Shared shell for the static legal documents (`/terms`, `/privacy`). Server
 * component — no client JS. Owns the page container, the title + "Last Updated"
 * line, and the prose styling (via arbitrary variants) so the document files
 * stay pure content.
 */
export function LegalPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">
        {title}
      </h1>
      <p className="mt-1 text-xs text-muted">Last updated: {LEGAL.lastUpdated}</p>

      {/* Prose styling lives here so the document files are content-only. */}
      <article
        className="mt-7 text-sm leading-relaxed text-muted
          [&_h2]:mt-7 [&_h2]:font-display [&_h2]:text-base [&_h2]:font-extrabold [&_h2]:text-ink
          [&_p]:mt-3
          [&_strong]:text-ink
          [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5
          [&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2"
      >
        {children}
      </article>
    </div>
  );
}

/**
 * The shared "Contact" section, identical across the legal documents apart from the
 * section number and which document it names.
 */
export function LegalContact({
  section,
  document,
}: {
  section: number;
  document: string;
}) {
  return (
    <>
      <h2>{section}. Contact</h2>
      <p>
        Questions about {document} may be sent to{" "}
        <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>.
      </p>
    </>
  );
}
