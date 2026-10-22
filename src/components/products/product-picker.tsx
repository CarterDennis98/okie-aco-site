"use client";

import { useCallback, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { CatalogProduct, ProductLine, SetDetails } from "@/db/queries/products";
import { money } from "@/lib/money";
import { saveProductChoice } from "@/lib/products/actions";
import { setDropProductActive } from "@/lib/products/admin-actions";
import type { Choice } from "@/lib/products/selection";
import {
  groupByLine,
  groupBySet,
  matchesSearch,
  searchGroups,
  searchTerms,
} from "@/lib/products/sets";
import { LineEditor } from "@/components/products/line-editor";
import { ProductEditor } from "@/components/products/product-editor";
import { SetArranger } from "@/components/products/set-arranger";
import { SetEditor } from "@/components/products/set-editor";

/**
 * Target Products: every product, by set, and whether to be run for it.
 *
 * Each switch saves the moment it is flipped -- the point is a member changing their mind
 * an hour before a drop and having it count, not a form they might forget to submit. The
 * switch moves first and the save follows; if the save is refused it moves back and says
 * why. A product is locked while its own save is in flight, so two quick clicks can't land
 * out of order.
 *
 * "All profiles" is the default and means every profile they hold on Target, including any
 * they add later -- what a ✅ on the drop channel always meant. "Only some" narrows it to the
 * ones they tick, and is only offered to a member with more than one profile to choose from.
 *
 * Built for hundreds of products: a search across names, SKUs and sets, and every set can be
 * folded away to its heading -- remembered in this browser, so the sets someone is done with
 * stay out of their way.
 */

type Profile = { id: string; name: string; active: boolean };
type Counts = Record<string, { members: number; profiles: number }>;

function Switch({
  on,
  disabled,
  label,
  onChange,
}: {
  on: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    // 44px to hit on touch, around a 36x20 pill -- the same switch as the profile list's.
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center disabled:opacity-50"
    >
      <span
        className={
          "relative block h-5 w-9 rounded-full transition-colors " +
          (on ? "bg-[var(--color-brand)]" : "bg-[var(--color-elevated)]")
        }
      >
        <span
          className={
            "absolute top-0.5 size-4 rounded-full bg-white transition-[left] " +
            (on ? "left-[1.125rem]" : "left-0.5")
          }
        />
      </span>
    </button>
  );
}

function ProductImage({ src }: { src: string | null }) {
  if (!src) {
    return <span aria-hidden className="size-16 shrink-0 rounded-lg bg-[var(--color-elevated)]" />;
  }
  return (
    // A plain <img> on purpose: the operator pastes whatever host Target serves images from,
    // and next/image would need that host allowlisted. See ProductEditor.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="size-16 shrink-0 rounded-lg bg-white object-contain p-1"
    />
  );
}

// ---------------------------------------------------------------------------
// Which lines and sets are folded away: this browser's own, kept in localStorage.
// ---------------------------------------------------------------------------

/** A list of folded keys -- set names, or line ids -- kept in localStorage under `key`. */
function foldedStore(key: string) {
  const listeners = new Set<() => void>();
  /** This page's copy: what storage held when first read, then every change made here. */
  let folded: string | null = null;

  const snapshot = (): string => {
    if (folded === null) {
      try {
        folded = window.localStorage.getItem(key) ?? "[]";
      } catch {
        // Storage blocked (a private window, say): folding still works, for this visit.
        folded = "[]";
      }
    }
    return folded;
  };

  const save = (keys: string[]) => {
    folded = JSON.stringify(keys);
    try {
      window.localStorage.setItem(key, folded);
    } catch {
      // Kept for this visit only.
    }
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    // Another tab folding one is picked up too.
    const fromStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      folded = null;
      listener();
    };
    listeners.add(listener);
    window.addEventListener("storage", fromStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", fromStorage);
    };
  };

  return { snapshot, save, subscribe };
}

const setFolds = foldedStore("okie:products:folded-sets");
const lineFolds = foldedStore("okie:products:folded-lines");
/** The key "Other" is folded under. Line ids are UUIDs, so never this. */
const OTHER = "other";

/**
 * What's folded. Read through useSyncExternalStore so the server -- which can't see this
 * browser's storage -- and the first render agree on "nothing folded", and the browser's own
 * choice follows straight after.
 */
function useFolded(store: ReturnType<typeof foldedStore>): Set<string> {
  const raw = useSyncExternalStore(store.subscribe, store.snapshot, () => "[]");
  return useMemo(() => {
    try {
      const keys: unknown = JSON.parse(raw);
      return new Set(Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [raw]);
}

const quiet =
  "inline-flex min-h-11 items-center rounded-lg px-2.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-40 sm:min-h-0 sm:py-1";

export function ProductPicker({
  products,
  retired,
  profiles,
  initialChoices,
  admin,
  counts,
  sets,
  setOrder,
  setDetails,
  lines,
}: {
  products: CatalogProduct[];
  retired: CatalogProduct[];
  profiles: Profile[];
  initialChoices: Record<string, Choice>;
  admin: boolean;
  counts: Counts | null;
  sets: string[];
  /** The sets as an admin arranged them, by name; see groupBySet. */
  setOrder: string[];
  /** Each set's logo and product line, by set name. A set with neither is absent. */
  setDetails: Record<string, SetDetails>;
  /** The product lines, in their order. */
  lines: ProductLine[];
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>(initialChoices);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const lineOf = useCallback(
    (setName: string) => setDetails[setName]?.lineId ?? null,
    [setDetails],
  );
  const lineNameOf = useCallback(
    (setName: string) => lines.find((l) => l.id === lineOf(setName))?.name ?? "",
    [lines, lineOf],
  );
  const groups = useMemo(() => groupBySet(products, setOrder), [products, setOrder]);
  const terms = useMemo(() => searchTerms(query), [query]);
  const shown = useMemo(() => searchGroups(groups, terms, lineNameOf), [groups, terms, lineNameOf]);
  const allByLine = useMemo(() => groupByLine(groups, lines, lineOf), [groups, lines, lineOf]);
  const shownByLine = useMemo(() => groupByLine(shown, lines, lineOf), [shown, lines, lineOf]);
  // Headings for lines only once a set is in one; until then the page is the sets alone.
  const lined = allByLine.some((g) => g.line !== null);
  const searching = terms.length > 0;
  const foldedSets = useFolded(setFolds);
  const foldedLines = useFolded(lineFolds);
  const active = profiles.filter((p) => p.active);
  const choosable = active.length > 1;

  /** Saves `next` for these products: null switches them off. Optimistic, undone on refusal. */
  async function save(productIds: string[], next: Choice | null) {
    const before = Object.fromEntries(productIds.map((id) => [id, choices[id]]));
    setChoices((current) => {
      const copy = { ...current };
      for (const id of productIds) {
        if (next) copy[id] = next;
        else delete copy[id];
      }
      return copy;
    });
    setErrors((current) => {
      const copy = { ...current };
      for (const id of productIds) delete copy[id];
      return copy;
    });
    setSaving((current) => new Set([...current, ...productIds]));

    const result = await saveProductChoice({
      productIds,
      mode: next === null ? "off" : next.all ? "all" : "some",
      profileIds: next && !next.all ? next.profileIds : [],
    }).catch(() => ({ ok: false as const, error: "That didn't save. Check your connection." }));

    setSaving((current) => new Set([...current].filter((id) => !productIds.includes(id))));
    if (!result.ok) {
      setChoices((current) => {
        const copy = { ...current };
        for (const id of productIds) {
          if (before[id]) copy[id] = before[id];
          else delete copy[id];
        }
        return copy;
      });
      setErrors((current) => ({
        ...current,
        ...Object.fromEntries(productIds.map((id) => [id, result.error])),
      }));
    }
  }

  // Only what's still listed is remembered: a deleted set's or line's fold needn't outlive it.
  const setNames = groups.map((g) => g.setName);
  const lineKeys = lined ? allByLine.map((g) => g.line?.id ?? OTHER) : [];
  const foldSets = (names: Set<string>) =>
    setFolds.save(setNames.filter((name) => names.has(name)));
  const foldLines = (keys: Set<string>) => lineFolds.save(lineKeys.filter((key) => keys.has(key)));
  const toggle = (folded: Set<string>, key: string, on: boolean) => {
    const next = new Set(folded);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };
  // "Collapse all" folds the lines and the sets in them: a line opened again lists its sets'
  // headings, to pick from.
  const allFolded =
    groups.length > 0 &&
    setNames.every((name) => foldedSets.has(name)) &&
    lineKeys.every((key) => foldedLines.has(key));
  const runningCount = products.filter((p) => choices[p.id]).length;
  const found = shown.reduce((sum, g) => sum + g.products.length, 0);
  const retiredShown = searching
    ? retired.filter((p) => matchesSearch(p, terms, lineNameOf(p.setName)))
    : retired;
  const setCounts = Object.fromEntries(
    allByLine.flatMap((g) => (g.line ? [[g.line.id, g.sets.length]] : [])),
  );

  const setSection = (group: (typeof shown)[number]) => (
    <SetSection
      key={group.setName}
      setName={group.setName}
      logo={setDetails[group.setName]?.logoUrl ?? null}
      nested={lined}
      products={group.products}
      // A search opens every set it finds something in: a match folded away is no match.
      folded={!searching && foldedSets.has(group.setName)}
      canFold={!searching}
      onFold={(on) => foldSets(toggle(foldedSets, group.setName, on))}
      choices={choices}
      saving={saving}
      errors={errors}
      counts={counts}
      admin={admin}
      editor={
        admin && (
          <SetEditor
            setName={group.setName}
            products={products}
            retired={retired}
            sets={sets}
            details={setDetails}
            lines={lines}
          />
        )
      }
      sets={sets}
      active={active}
      choosable={choosable}
      save={save}
    />
  );

  return (
    // Folded sets sit close together; an open one takes its own room below (SetSection).
    <div className="mt-8 space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--color-fg)]">
            {products.length === 0
              ? "No products are listed yet."
              : `You're in for ${runningCount} of ${products.length} product${products.length === 1 ? "" : "s"}.`}
          </p>
          {admin && (
            <div className="flex flex-wrap gap-2">
              <LineEditor lines={lines} setCounts={setCounts} />
              {groups.length > 1 && (
                <SetArranger
                  sections={
                    lined
                      ? allByLine.map((g) => ({
                          title: g.line?.name ?? "Other",
                          sets: g.sets.map((s) => ({
                            name: s.setName,
                            products: s.products.length,
                          })),
                        }))
                      : [
                          {
                            title: null,
                            sets: groups.map((g) => ({
                              name: g.setName,
                              products: g.products.length,
                            })),
                          },
                        ]
                  }
                />
              )}
              <SetEditor
                products={products}
                retired={retired}
                sets={sets}
                details={setDetails}
                lines={lines}
              />
            </div>
          )}
        </div>

        {products.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search products, SKUs or sets"
              aria-label="Search products, SKUs or sets"
              className="w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-base text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none sm:w-80 sm:text-sm"
            />
            {searching ? (
              <span role="status" className="text-xs text-[var(--color-muted)]">
                {found === 0
                  ? "Nothing matches."
                  : `${found} of ${products.length} product${products.length === 1 ? "" : "s"}`}
              </span>
            ) : (
              (groups.length > 1 || lined) && (
                <button
                  type="button"
                  onClick={() => {
                    foldSets(allFolded ? new Set() : new Set(setNames));
                    foldLines(allFolded ? new Set() : new Set(lineKeys));
                  }}
                  className={quiet}
                >
                  {allFolded ? "Expand all" : "Collapse all"}
                </button>
              )
            )}
          </div>
        )}
      </div>

      {lined
        ? shownByLine.map(({ line, sets: lineSets }) => {
            const key = line?.id ?? OTHER;
            const inLine = lineSets.flatMap((g) => g.products);
            return (
              <LineSection
                key={key}
                name={line?.name ?? "Other"}
                logo={line?.logoUrl ?? null}
                sets={lineSets.length}
                products={inLine.length}
                on={inLine.filter((p) => choices[p.id]).length}
                folded={!searching && foldedLines.has(key)}
                canFold={!searching}
                onFold={(on) => foldLines(toggle(foldedLines, key, on))}
              >
                {lineSets.map(setSection)}
              </LineSection>
            );
          })
        : shown.map(setSection)}

      {admin && retiredShown.length > 0 && (
        <details className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] px-4 py-3">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-[var(--color-muted)] hover:text-[var(--color-fg)] sm:min-h-0">
            Retired ({retiredShown.length})
          </summary>
          <ul className="mt-2 divide-y divide-[var(--color-edge)]">
            {retiredShown.map((product) => (
              <li key={product.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate text-[var(--color-fg)]">
                  {product.name}{" "}
                  <span className="text-xs text-[var(--color-muted)]">
                    · {product.setName} · SKU {product.sku}
                  </span>
                </span>
                <RetireButton id={product.id} active={false} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * One product line -- or "Other", the sets in none -- and its sets. Its heading folds the
 * whole line away, and says what's in it while folded.
 */
function LineSection({
  name,
  logo,
  sets,
  products,
  on,
  folded,
  canFold,
  onFold,
  children,
}: {
  name: string;
  logo: string | null;
  sets: number;
  products: number;
  /** How many of its products the member is in for. */
  on: number;
  folded: boolean;
  canFold: boolean;
  onFold: (folded: boolean) => void;
  children: ReactNode;
}) {
  const listId = useId();
  return (
    <section>
      <h2 className="border-b border-[var(--color-edge)] pb-2 text-xl font-black tracking-tight text-white">
        <button
          type="button"
          onClick={() => onFold(!folded)}
          disabled={!canFold}
          aria-expanded={!folded}
          aria-controls={listId}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 text-left disabled:cursor-default"
        >
          <svg
            aria-hidden
            viewBox="0 0 20 20"
            className={
              "size-5 shrink-0 text-[var(--color-muted)] transition-transform " +
              (folded ? "" : "rotate-90")
            }
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
          {logo && (
            // A plain <img>, as for products: see ProductImage. Its name is beside it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-10 w-auto max-w-32 shrink-0 object-contain"
            />
          )}
          <span className="min-w-0 break-words">{name}</span>
          {folded && (
            <span className="shrink-0 text-xs font-normal tracking-normal text-[var(--color-muted)]">
              {sets} set{sets === 1 ? "" : "s"} · {products} product{products === 1 ? "" : "s"}
              {on > 0 && ` · ${on} active`}
            </span>
          )}
        </button>
      </h2>
      {!folded && (
        // Stepped in, so its sets' chevrons sit under the line's name.
        <div id={listId} className="mt-5 space-y-6 pl-3 sm:pl-8">
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * One set: its heading -- which folds it away, and says what's in it while folded -- and
 * its products. "All on" and "All off" take what the set shows: while searching, only the
 * products found.
 */
function SetSection({
  setName,
  logo,
  nested,
  products,
  folded,
  canFold,
  onFold,
  choices,
  saving,
  errors,
  counts,
  admin,
  editor,
  sets,
  active,
  choosable,
  save,
}: {
  setName: string;
  logo: string | null;
  /** Under a product line's heading: a step down from it. */
  nested: boolean;
  products: CatalogProduct[];
  folded: boolean;
  canFold: boolean;
  onFold: (folded: boolean) => void;
  choices: Record<string, Choice>;
  saving: Set<string>;
  errors: Record<string, string>;
  counts: Counts | null;
  admin: boolean;
  editor: ReactNode;
  sets: string[];
  active: Profile[];
  choosable: boolean;
  save: (productIds: string[], next: Choice | null) => void;
}) {
  const listId = useId();
  const ids = products.map((p) => p.id);
  const off = ids.filter((id) => !choices[id]);
  const on = ids.filter((id) => choices[id]);
  const busy = ids.some((id) => saving.has(id));
  const Heading = nested ? "h3" : "h2";

  return (
    <section className={folded ? undefined : "pb-4"}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Heading className="min-w-0 text-lg font-bold tracking-tight text-white">
          <button
            type="button"
            onClick={() => onFold(!folded)}
            disabled={!canFold}
            aria-expanded={!folded}
            aria-controls={listId}
            className="flex min-h-11 items-center gap-2.5 text-left disabled:cursor-default sm:min-h-0"
          >
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className={
                "size-4 shrink-0 text-[var(--color-muted)] transition-transform " +
                (folded ? "" : "rotate-90")
              }
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
            <span aria-hidden className="h-5 w-1 shrink-0 rounded-full bg-[var(--color-brand)]" />
            {logo && (
              // A plain <img>, as for products: see ProductImage. No backdrop: set logos are
              // cut out to sit on anything. Its name is beside it, so it says nothing itself.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logo}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-8 w-auto max-w-24 shrink-0 object-contain"
              />
            )}
            {/* Centred by what the eye reads: the name's capitals, and the count's lowercase.
                `text-box` trims each box to just that band, so `items-center` lines the two up
                exactly. Without it (older browsers), the count sits a pixel low. */}
            <span className="min-w-0 break-words [text-box:trim-both_cap_alphabetic]">
              {setName}
            </span>
            {folded && (
              <span className="shrink-0 text-xs font-normal tracking-normal text-[var(--color-muted)] [text-box:trim-both_ex_alphabetic]">
                {products.length} product{products.length === 1 ? "" : "s"}
                {on.length > 0 && ` · ${on.length} active`}
              </span>
            )}
          </button>
        </Heading>
        <div className="flex gap-1">
          {editor}
          <button
            type="button"
            disabled={busy || off.length === 0}
            onClick={() => save(off, { all: true, profileIds: [] })}
            className={quiet}
          >
            All on
          </button>
          <button
            type="button"
            disabled={busy || on.length === 0}
            onClick={() => save(on, null)}
            className={quiet}
          >
            All off
          </button>
        </div>
      </div>

      {!folded && (
        <ul
          id={listId}
          className="divide-y divide-[var(--color-edge)] overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]"
        >
          {products.map((product) => {
            const choice = choices[product.id];
            const busyHere = saving.has(product.id);
            const count = counts?.[product.id];
            return (
              // The switch first, centred on the row: it's what the row is for.
              <li key={product.id} className="flex items-center gap-4 px-4 py-3">
                <Switch
                  on={Boolean(choice)}
                  disabled={busyHere}
                  label={`Run me for ${product.name}`}
                  onChange={() => save([product.id], choice ? null : { all: true, profileIds: [] })}
                />
                <ProductImage src={product.imageUrl} />
                <div className="min-w-0 flex-1">
                  {/* Underlined throughout, so it reads as a link without an icon. The price
                      follows it outside the link, and wraps as one piece. */}
                  <a
                    href={product.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold break-words text-white underline decoration-[var(--color-muted)] underline-offset-2 transition-colors hover:decoration-white"
                  >
                    {product.name}
                    <span className="sr-only"> (opens Target in a new tab)</span>
                  </a>
                  {product.priceCents !== null && (
                    <span className="ml-1.5 text-xs whitespace-nowrap text-[var(--color-muted)] tabular-nums">
                      {money(product.priceCents)}
                    </span>
                  )}
                  {/* One fact a line: run together, they wrap mid-way on a phone. */}
                  <div className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {product.pasFeeCents !== null && <p>PAS: {money(product.pasFeeCents)}/unit</p>}
                    <p>
                      SKU <span className="tabular-nums">{product.sku}</span>
                    </p>
                    {count && (
                      <p>
                        {count.members} member{count.members === 1 ? "" : "s"}, {count.profiles}{" "}
                        profile{count.profiles === 1 ? "" : "s"}
                      </p>
                    )}
                  </div>

                  {choice && choosable && (
                    <ProfileChoice
                      productName={product.name}
                      choice={choice}
                      profiles={active}
                      disabled={busyHere}
                      onChange={(next) => save([product.id], next)}
                    />
                  )}

                  {errors[product.id] && (
                    <p role="alert" className="mt-1.5 text-xs text-[var(--color-warn)]">
                      {errors[product.id]}
                    </p>
                  )}

                  {admin && (
                    <div className="mt-1 -ml-2 flex flex-wrap items-center">
                      <ProductEditor product={product} sets={sets} />
                      <RetireButton id={product.id} active />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** "All profiles" or "Only some", and which. */
function ProfileChoice({
  productName,
  choice,
  profiles,
  disabled,
  onChange,
}: {
  productName: string;
  choice: Choice;
  profiles: Profile[];
  disabled: boolean;
  onChange: (next: Choice) => void;
}) {
  // Switching to "Only some" starts with every profile ticked, so nothing silently drops off
  // until the member unticks it themselves.
  const picked = choice.all ? profiles.map((p) => p.id) : choice.profileIds;
  // A switched-off profile isn't listed here but keeps its tick, so switching it back on
  // brings back what they chose. It doesn't count towards the one that must stay ticked.
  const listed = new Set(profiles.map((p) => p.id));
  const pickedHere = picked.filter((id) => listed.has(id));
  return (
    <div className="mt-2">
      <div
        role="radiogroup"
        aria-label={`Which profiles for ${productName}`}
        className="flex flex-wrap gap-1.5"
      >
        {[
          { all: true, label: `All profiles (${profiles.length})` },
          { all: false, label: "Only some" },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={choice.all === option.all}
            disabled={disabled}
            onClick={() =>
              choice.all !== option.all &&
              onChange(
                option.all ? { all: true, profileIds: [] } : { all: false, profileIds: picked },
              )
            }
            className={
              "inline-flex min-h-11 items-center rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-60 sm:min-h-0 sm:py-1 " +
              (choice.all === option.all
                ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-white"
                : "border-[var(--color-edge)] text-[var(--color-muted)] hover:text-[var(--color-fg)]")
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      {!choice.all && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {profiles.map((profile) => {
            const checked = picked.includes(profile.id);
            // The last one can't be unticked: no profiles is "off", which is the switch's job.
            const last = checked && pickedHere.length === 1;
            return (
              <li key={profile.id}>
                <label
                  title={last ? "Switch the product off instead" : undefined}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-[var(--color-fg)] sm:min-h-0"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || last}
                    onChange={() =>
                      onChange({
                        all: false,
                        profileIds: checked
                          ? picked.filter((id) => id !== profile.id)
                          : [...picked, profile.id],
                      })
                    }
                    className="size-4 accent-[var(--color-brand)]"
                  />
                  {profile.name}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RetireButton({ id, active }: { id: string; active: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const form = new FormData();
          form.set("id", id);
          form.set("active", active ? "false" : "true");
          const result = await setDropProductActive(form);
          setBusy(false);
          if (!result.ok) setError(result.error);
        }}
        className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-50 sm:min-h-0 sm:py-1"
      >
        {busy ? "…" : active ? "Retire" : "Restore"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-[var(--color-warn)]">
          {error}
        </span>
      )}
    </>
  );
}
