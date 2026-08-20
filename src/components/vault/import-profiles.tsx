"use client";

import { useActionState, useState } from "react";
import { importAycdProfiles, type ImportResult } from "@/lib/vault/import-actions";
import { siteStyle } from "@/lib/sites";

/**
 * Bulk import from an AYCD profile export.
 *
 * The counterpart to the operator's export, so a member who already keeps fifteen
 * profiles in AYCD Toolbox doesn't retype them.
 *
 * Two files, because one isn't enough: AYCD's profile export holds cards and addresses
 * but no retailer logins, so a profile for an account this site has never seen needs its
 * password supplied too. The copy says that up front rather than letting someone upload,
 * wait, and then be told half their profiles were skipped.
 *
 * The result panel reports per-profile problems by NAME AND POSITION only -- the action
 * never sends a value back, and this never asks for one.
 */

const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] file:mr-3 file:rounded file:border-0 file:bg-[var(--color-elevated)] file:px-2 file:py-1 file:text-xs file:text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:outline-none";

export function ImportProfiles({ siteKeys }: { siteKeys: string[] }) {
  const [open, setOpen] = useState(false);

  const [state, formAction, pending] = useActionState(
    async (_previous: ImportResult | null, formData: FormData) => importAycdProfiles(formData),
    null,
  );

  return (
    <section className="mt-12">
      <h2 className="mb-2 flex items-center gap-2.5 text-xl font-bold tracking-tight">
        <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
        Import from AYCD
      </h2>
      <p className="mb-4 max-w-2xl text-sm text-[var(--color-muted)]">
        Already have your profiles in AYCD Toolbox? Export them and upload the file here instead of
        adding each one by hand. Profiles you already have are matched by email and updated;
        anything new is added with the next name in your sequence.
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 sm:min-h-0"
        >
          Import a file
        </button>
      ) : (
        <form
          action={formAction}
          className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label
                htmlFor="siteKey"
                className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
              >
                Retailer
              </label>
              <select id="siteKey" name="siteKey" defaultValue="" className={field} required>
                <option value="" disabled>
                  Pick one
                </option>
                {siteKeys.map((key) => (
                  <option key={key} value={key}>
                    {siteStyle(key).label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                An AYCD export doesn&rsquo;t say which store it&rsquo;s for, so pick it here.
              </p>
            </div>

            <div>
              <label
                htmlFor="profiles"
                className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
              >
                Profiles <span className="font-normal">(.json)</span>
              </label>
              <input
                id="profiles"
                name="profiles"
                type="file"
                accept=".json,application/json"
                required
                className={field}
              />
            </div>

            <div>
              <label
                htmlFor="accounts"
                className="mb-1 block text-xs font-medium text-[var(--color-muted)]"
              >
                Logins <span className="font-normal">(optional, .txt)</span>
              </label>
              <input
                id="accounts"
                name="accounts"
                type="file"
                accept=".txt,.csv,text/plain"
                className={field}
              />
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                One <code>email:password</code> per line. Needed only for accounts we don&rsquo;t
                already have — the profile export doesn&rsquo;t include logins.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60 sm:min-h-0"
            >
              {pending ? "Importing…" : "Import"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
            >
              Cancel
            </button>
            <span className="text-xs text-[var(--color-muted)]">
              Card numbers and security codes are encrypted on arrival and never shown again.
            </span>
          </div>
        </form>
      )}

      {state && <ImportReport result={state} />}
    </section>
  );
}

function ImportReport({ result }: { result: ImportResult }) {
  if (!result.ok) {
    return (
      <div
        role="alert"
        className="mt-4 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-4 py-3"
      >
        <p className="text-sm font-semibold text-white">{result.error}</p>
        {result.issues && result.issues.length > 0 && <IssueList issues={result.issues} />}
      </div>
    );
  }

  const { created, updated, skipped, needPassword, issues } = result;

  return (
    <div className="mt-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-3">
      <p className="text-sm font-semibold text-white">
        {created} added · {updated} updated
        {skipped > 0 && ` · ${skipped} skipped`}
      </p>

      {needPassword.length > 0 && (
        <div className="mt-2 text-xs text-[var(--color-warn)]">
          <p>
            {needPassword.length} account{needPassword.length === 1 ? "" : "s"} had no login, so
            those profiles weren&rsquo;t created. Add them to a logins file and import again:
          </p>
          <ul className="mt-1 list-inside list-disc text-[var(--color-muted)]">
            {needPassword.slice(0, 8).map((email) => (
              <li key={email}>{email}</li>
            ))}
            {needPassword.length > 8 && <li>and {needPassword.length - 8} more</li>}
          </ul>
        </div>
      )}

      {issues.length > 0 && <IssueList issues={issues} />}

      {created + updated > 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Reload the page to see them in the lists above.
        </p>
      )}
    </div>
  );
}

function IssueList({
  issues,
}: {
  issues: { position: number; name: string; problem: string; severity: string }[];
}) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {issues.slice(0, 25).map((issue, i) => (
        <li
          key={`${issue.position}-${i}`}
          className={
            issue.severity === "error" ? "text-[var(--color-warn)]" : "text-[var(--color-muted)]"
          }
        >
          {issue.name && <span className="font-medium">{issue.name}</span>}
          {issue.name && " — "}
          {issue.problem}
        </li>
      ))}
      {issues.length > 25 && (
        <li className="text-[var(--color-muted)]">and {issues.length - 25} more</li>
      )}
    </ul>
  );
}
