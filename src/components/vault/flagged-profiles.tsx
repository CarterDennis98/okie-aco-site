"use client";

import { useState } from "react";
import Image from "next/image";
import type { VaultProfileDetail, VaultProfileSummary } from "@/db/queries/vault";
import { relativeTime } from "@/lib/format";
import { siteStyle } from "@/lib/sites";
import { loadProfileForEdit } from "@/lib/vault/actions";
import type { AddressBook } from "@/lib/vault/address-book";
import { HIGH_RISK_AT } from "@/lib/vault/failure-flags";
import { FailureChip } from "@/components/vault/failure-flag";
import { FAILURE_ROW_ACCENT } from "@/components/vault/failure-styles";
import { ProfileForm } from "@/components/vault/profile-form";

/**
 * Every profile of theirs with failed checkouts counting against it, on every retailer at
 * once -- the "Flagged" tab on the profiles page.
 *
 * Worst first: the red ones (HIGH_RISK_AT failures without a change), then by how many, then
 * by how recently. Each opens its edit form right where it is listed, and saving a change
 * clears the flag -- the page re-renders and the profile leaves this list, which is the
 * confirmation that it worked.
 */
export function FlaggedProfiles({
  profiles,
  profilesBySite,
  logos,
  addressBook,
}: {
  /** The flagged ones, any retailer. */
  profiles: VaultProfileSummary[];
  /** Everything on each retailer, for the edit form's siblings (names, shared cards). */
  profilesBySite: Record<string, VaultProfileSummary[]>;
  logos: Record<string, string | null>;
  addressBook: AddressBook;
}) {
  const [editing, setEditing] = useState<VaultProfileDetail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const sorted = [...profiles].sort((a, b) => {
    const fa = a.failures!;
    const fb = b.failures!;
    if (fa.risk !== fb.risk) return fa.risk === "high" ? -1 : 1;
    if (fa.count !== fb.count) return fb.count - fa.count;
    return fb.lastAt.getTime() - fa.lastAt.getTime();
  });

  async function onEdit(id: string) {
    if (editing?.id === id) {
      setEditing(null);
      return;
    }
    setLoading(id);
    const detail = await loadProfileForEdit(id);
    setLoading(null);
    if (detail) setEditing(detail);
  }

  return (
    <section className="mt-10">
      <header className="mb-4">
        <p className="max-w-2xl text-sm text-[var(--color-muted)]">
          Profiles with checkouts that failed since they were last changed — a declined card, an
          order the retailer cancelled, a checkout that errored — on every retailer. Most often the
          card, the billing address or the login needs updating. Fix what&rsquo;s wrong and save: a
          saved change clears the flag.{" "}
          <span className="text-[var(--color-fg)]">
            {HIGH_RISK_AT} or more failures without a change turn it red.
          </span>
        </p>
      </header>

      {sorted.length === 0 ? (
        <p className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-muted)]">
          <span className="font-bold text-[var(--color-good)]">✓</span> Nothing flagged — none of
          your profiles has a failed checkout since it was last changed.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
          {sorted.map((profile) => {
            const flag = profile.failures!;
            const style = siteStyle(profile.siteKey);
            const logo = logos[profile.siteKey];
            const open = editing?.id === profile.id;

            return (
              <li
                key={profile.id}
                className={"px-4 py-3.5 sm:px-5 " + FAILURE_ROW_ACCENT[flag.risk]}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm font-semibold text-white">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-[11px] font-medium text-[var(--color-fg)]"
                        style={{
                          backgroundColor: `color-mix(in oklab, ${style.tint} 14%, transparent)`,
                          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${style.tint} 35%, transparent)`,
                        }}
                      >
                        {logo ? (
                          <Image
                            src={logo}
                            alt=""
                            width={16}
                            height={16}
                            className="size-4 rounded-full object-contain"
                            style={
                              style.needsLightBacking
                                ? { backgroundColor: "#fff", padding: 1 }
                                : undefined
                            }
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="size-4 rounded-full"
                            style={{ backgroundColor: style.tint }}
                          />
                        )}
                        {style.label}
                      </span>
                      <span
                        className={profile.active ? "" : "text-[var(--color-muted)] line-through"}
                      >
                        {loading === profile.id ? `${profile.name}…` : profile.name}
                      </span>
                      <FailureChip flag={flag} />
                    </p>
                    <p className="mt-1 text-xs break-words text-[var(--color-muted)]">
                      Last failed {relativeTime(flag.lastAt)}
                      {flag.lastReason && (
                        <>
                          {" · "}
                          <span className="text-[var(--color-fg)]">{flag.lastReason}</span>
                        </>
                      )}
                      {flag.lastProduct && ` · ${flag.lastProduct}`}
                      {" · "}
                      {profile.email} · {profile.cardLabel} · exp {profile.cardExpMonth}/
                      {profile.cardExpYear.slice(-2)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onEdit(profile.id)}
                    className="-my-2 flex min-h-11 shrink-0 items-center self-center rounded-lg border border-[var(--color-edge)] px-3 text-sm font-medium text-[var(--color-fg)] transition-colors hover:text-white sm:my-0 sm:min-h-0 sm:py-1.5 sm:text-xs"
                  >
                    {open ? "Close" : "Fix"}
                  </button>
                </div>

                {open && editing && (
                  <div className="mt-4 rounded-xl border border-[var(--color-brand)]/40 bg-[var(--color-ink)]/40 p-4 sm:p-5">
                    {/* Keyed on the profile, for the reason ProfileManager keys its own: a
                        second Fix must remount the form, not inherit the first one's fields. */}
                    <ProfileForm
                      key={editing.id}
                      siteKey={editing.siteKey}
                      profile={editing}
                      siblings={(profilesBySite[editing.siteKey] ?? []).filter(
                        (p) => p.id !== editing.id,
                      )}
                      addressBook={addressBook}
                      onDone={() => setEditing(null)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
