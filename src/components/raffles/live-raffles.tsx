"use client";

import { useState } from "react";
import {
  ProductImage,
  ProfileChoice,
  Switch,
  type PickProfile,
} from "@/components/products/pick-controls";
import { DeleteRaffleButton, RaffleEditor } from "@/components/raffles/raffle-editor";
import type { CatalogProduct } from "@/db/queries/products";
import type { RaffleCount } from "@/db/queries/raffles";
import { money } from "@/lib/money";
import { saveRaffleEntry } from "@/lib/raffles/actions";
import { enteredWith, type EntryChoice, type RaffleView } from "@/lib/raffles/entries";

/**
 * Live Raffles, at the top of Target Products: the raffles Target is running, and whether to
 * be entered in each.
 *
 * Entering works exactly like switching a product on -- the switch saves the moment it's
 * flipped, every profile by default, "Only some" to narrow it -- and goes on working until
 * entries are due, before the raffle starts included. After that a raffle moves under "Past
 * raffles", folded away and read-only, where everyone can see what they entered -- until an
 * admin deletes it, which also takes its group out of the Shikari exports (see Raffle in
 * schema.prisma).
 *
 * Full admins also list, edit and delete raffles here, and see how many members and profiles
 * each one enters.
 */

const allIn = (): EntryChoice => ({ all: true, profileIds: [] });

export function LiveRaffles({
  raffles,
  profiles,
  initialEntries,
  admin,
  counts,
  products,
}: {
  /** Open raffles for a member; for an admin, closed ones too, after them. */
  raffles: RaffleView[];
  profiles: PickProfile[];
  initialEntries: Record<string, EntryChoice>;
  admin: boolean;
  counts: Record<string, RaffleCount> | null;
  /** The products listed on Target Products, for an admin to raffle one of. */
  products: CatalogProduct[];
}) {
  const [entries, setEntries] = useState<Record<string, EntryChoice>>(initialEntries);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const active = profiles.filter((p) => p.active);
  const choosable = active.length > 1;
  const open = raffles.filter((r) => r.phase !== "closed");
  const closed = raffles.filter((r) => r.phase === "closed");

  // Nothing to enter or look back on, and nobody to list one: no section at all.
  if (!admin && raffles.length === 0) return null;

  /** Saves `next` for a raffle: null withdraws. Optimistic, undone on refusal. */
  async function save(raffleId: string, next: EntryChoice | null) {
    const before = entries[raffleId];
    setEntries((current) => {
      const copy = { ...current };
      if (next) copy[raffleId] = next;
      else delete copy[raffleId];
      return copy;
    });
    setErrors((current) => {
      const copy = { ...current };
      delete copy[raffleId];
      return copy;
    });
    setSaving((current) => new Set([...current, raffleId]));

    const result = await saveRaffleEntry({
      raffleId,
      mode: next === null ? "off" : next.all ? "all" : "some",
      profileIds: next && !next.all ? next.profileIds : [],
    }).catch(() => ({ ok: false as const, error: "That didn't save. Check your connection." }));

    setSaving((current) => new Set([...current].filter((id) => id !== raffleId)));
    if (!result.ok) {
      setEntries((current) => {
        const copy = { ...current };
        if (before) copy[raffleId] = before;
        else delete copy[raffleId];
        return copy;
      });
      setErrors((current) => ({ ...current, [raffleId]: result.error }));
    }
  }

  const entered = open.filter((r) => entries[r.id]).length;

  return (
    <section aria-labelledby="live-raffles" className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2
          id="live-raffles"
          className="flex items-center gap-2.5 text-xl font-black tracking-tight text-white"
        >
          <span aria-hidden className="h-5 w-1 shrink-0 rounded-full bg-[var(--color-brand)]" />
          Live Raffles
        </h2>
        {admin && <RaffleEditor raffle={null} products={products} />}
      </div>
      <p className="mb-3 max-w-2xl text-sm text-[var(--color-muted)]">
        {open.length === 0
          ? "No raffles are taking entries right now."
          : `Target draws the winners. Switch one on to be entered with your Target profiles, all of them or only some — you can change it until entries are due. You're entered in ${entered} of ${open.length}.`}
      </p>

      {open.length > 0 && (
        <ul className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
          {open.map((raffle) => {
            const entry = entries[raffle.id];
            const busy = saving.has(raffle.id);
            const count = counts?.[raffle.id];
            return (
              // The switch first, centred on the row, as on a product.
              <li key={raffle.id} className="flex items-center gap-4 px-4 py-3">
                <Switch
                  on={Boolean(entry)}
                  disabled={busy}
                  label={`Enter me in the ${raffle.name} raffle`}
                  onChange={() => save(raffle.id, entry ? null : allIn())}
                />
                <ProductImage src={raffle.imageUrl} />
                <div className="min-w-0 flex-1">
                  <RaffleTitle raffle={raffle} />
                  <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                    <When raffle={raffle} />
                    <p>
                      SKU <span className="tabular-nums">{raffle.sku}</span>
                    </p>
                    {count && <Counted count={count} />}
                  </div>

                  {entry && choosable && (
                    <ProfileChoice
                      productName={raffle.name}
                      choice={entry}
                      profiles={active}
                      disabled={busy}
                      onChange={(next) => save(raffle.id, next)}
                    />
                  )}

                  {errors[raffle.id] && (
                    <p role="alert" className="mt-1.5 text-xs text-[var(--color-warn)]">
                      {errors[raffle.id]}
                    </p>
                  )}

                  {admin && (
                    <div className="mt-1 -ml-2 flex flex-wrap items-center">
                      <RaffleEditor raffle={raffle} products={products} />
                      <DeleteRaffleButton raffleId={raffle.id} entries={count?.entries ?? 0} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {closed.length > 0 && (
        <PastRaffles
          raffles={closed}
          entries={entries}
          profiles={profiles}
          admin={admin}
          counts={counts}
          products={products}
        />
      )}
    </section>
  );
}

/**
 * Past raffles: the ones whose entries are due, folded under one line that's closed until
 * opened -- the line says how many there are, and how many you were entered in, so it rarely
 * needs opening. Inside, each one's due date and what you entered with, read-only: there's
 * nothing left to change. An admin also gets each one's counts, Edit (a later due date opens
 * it again) and Delete, which takes it off this list and its group out of Shikari exports.
 */
function PastRaffles({
  raffles,
  entries,
  profiles,
  admin,
  counts,
  products,
}: {
  raffles: RaffleView[];
  entries: Record<string, EntryChoice>;
  profiles: PickProfile[];
  admin: boolean;
  counts: Record<string, RaffleCount> | null;
  products: CatalogProduct[];
}) {
  const entered = raffles.filter((r) => entries[r.id]).length;
  return (
    <details className="group mt-3 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className="size-4 shrink-0 transition-transform group-open:rotate-90"
        >
          <path
            d="M7.5 4.5 13 10l-5.5 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>
          Past raffles ({raffles.length})
          {entered > 0 && (
            <span className="text-xs">
              {" "}
              · you were entered in {entered === raffles.length ? "all" : entered}
            </span>
          )}
        </span>
      </summary>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        {admin
          ? "Entries are closed on these. Each stays in Shikari exports until you delete it, and a later due date opens it again."
          : "Entries are closed on these, so nothing here can change."}
      </p>
      <ul className="mt-1 divide-y divide-[var(--color-edge)]">
        {raffles.map((raffle) => {
          const count = counts?.[raffle.id];
          return (
            <li key={raffle.id} className="py-2.5 text-sm">
              <RaffleTitle raffle={raffle} />
              <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                <p>
                  Entries were due {raffle.dueLabel} · SKU{" "}
                  <span className="tabular-nums">{raffle.sku}</span>
                </p>
                <EnteredWith mine={enteredWith(entries[raffle.id], profiles)} />
                {count && <Counted count={count} />}
              </div>
              {admin && (
                <div className="mt-1 -ml-2 flex flex-wrap items-center">
                  <RaffleEditor raffle={raffle} products={products} />
                  <DeleteRaffleButton raffleId={raffle.id} entries={count?.entries ?? 0} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** "Entered with carter - 1, carter - 3", "Entered with all your profiles (3)", or not. */
function EnteredWith({ mine }: { mine: ReturnType<typeof enteredWith> }) {
  if (!mine) return <p>You weren&rsquo;t entered.</p>;
  if (mine.names.length === 0) {
    return <p>Entered, but with no active profile to enter.</p>;
  }
  return (
    <p>
      <span className="font-semibold text-[var(--color-good)]">Entered</span> with{" "}
      <span className="text-[var(--color-fg)]">
        {mine.all ? `all your profiles (${mine.names.length})` : mine.names.join(", ")}
      </span>
    </p>
  );
}

function RaffleTitle({ raffle }: { raffle: RaffleView }) {
  return (
    <>
      {/* Underlined throughout, so it reads as a link without an icon -- as a product's does. */}
      <a
        href={raffle.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-semibold break-words text-white underline decoration-[var(--color-muted)] underline-offset-2 transition-colors hover:decoration-white"
      >
        {raffle.name}
        <span className="sr-only"> (opens Target in a new tab)</span>
      </a>
      {raffle.priceCents !== null && (
        <span className="ml-1.5 text-xs whitespace-nowrap text-[var(--color-muted)] tabular-nums">
          {money(raffle.priceCents)}
        </span>
      )}
    </>
  );
}

/** "Live now · entries due Sun, Nov 23, 11:59 PM CT", or when it starts and when they're due. */
function When({ raffle }: { raffle: RaffleView }) {
  if (raffle.phase === "live") {
    return (
      <p>
        <span className="font-semibold text-[var(--color-good)]">Live now</span> · entries due{" "}
        {raffle.dueLabel}
      </p>
    );
  }
  return (
    <>
      <p>Starts {raffle.startsLabel}</p>
      <p>Entries due {raffle.dueLabel}</p>
    </>
  );
}

function Counted({ count }: { count: RaffleCount }) {
  return (
    <p>
      {count.members} member{count.members === 1 ? "" : "s"}, {count.profiles} profile
      {count.profiles === 1 ? "" : "s"} entered
    </p>
  );
}
