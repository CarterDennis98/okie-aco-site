"use client";

import { useActionState, useState } from "react";
import {
  addressLine,
  addressTitle,
  cardTitle,
  MAX_LABEL_LENGTH,
  type AddressBook as Book,
  type SavedAddressSummary,
  type SavedCardSummary,
} from "@/lib/vault/address-book";
import {
  deleteSavedAddress,
  deleteSavedCard,
  saveProfileToAddressBook,
  saveSavedAddress,
  saveSavedCard,
  type CopyToBookResult,
} from "@/lib/vault/address-book-actions";
import type { ActionResult } from "@/lib/vault/actions";
import { POSTAL_CODE_RE } from "@/lib/vault/profile-input";
import { siteStyle } from "@/lib/sites";
import { PasswordInput } from "@/components/vault/password-input";

/**
 * The member's address book: their addresses and cards, kept once, to fill a new profile on
 * any retailer from (see the pickers on ProfileForm).
 *
 * A convenience and nothing else, and the copy says so: editing an entry here changes none of
 * their profiles, and none of it ever reaches a bot. The card follows the profile's rules --
 * write-only, shown back as brand and last four.
 *
 * "Copy from a profile" is the fast way in for a member who already has profiles: the address
 * and card of one of them go into the book, server-side, with nothing retyped.
 */

/* 16px on a phone, for the reason profile-form.tsx gives: Mobile Safari zooms into anything
   smaller and doesn't zoom back out. */
const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const label = "mb-1 block text-xs font-medium text-[var(--color-muted)]";
const quiet =
  "inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0 sm:text-xs";
const outline =
  "inline-flex min-h-11 items-center rounded-lg border border-[var(--color-edge)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand)]/50 sm:min-h-0";
const primary =
  "inline-flex min-h-11 items-center rounded-lg bg-[var(--color-brand)] px-4 py-2 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60 sm:min-h-0";

const ZIP_PATTERN = POSTAL_CODE_RE.source.replace(/^\^/, "").replace(/\$$/, "");
const ZIP_TITLE = "Five digits, or ZIP+4 like 73069-1234.";

function Input({
  name,
  text,
  defaultValue,
  required,
  className = "",
  ...rest
}: {
  name: string;
  text: string;
  defaultValue?: string | null;
  required?: boolean;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  pattern?: string;
  title?: string;
  inputMode?: "numeric";
}) {
  // Ids are scoped by the form they sit in, so two open forms can't share one.
  return (
    <div className={className}>
      <label className={label}>
        {text}
        {required && <span className="ml-0.5 text-[var(--color-brand)]">*</span>}
        <input
          name={name}
          defaultValue={defaultValue ?? ""}
          required={required}
          autoComplete="off"
          className={`${field} mt-1 font-normal`}
          {...rest}
        />
      </label>
    </div>
  );
}

function ErrorLine({ result }: { result: ActionResult | null }) {
  if (!result || result.ok) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-3 py-2 text-sm text-[var(--color-fg)]"
    >
      {result.error}
    </p>
  );
}

function AddressForm({ entry, onDone }: { entry?: SavedAddressSummary; onDone: () => void }) {
  const [sameBilling, setSameBilling] = useState(entry?.sameBillingAndShipping ?? true);
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => {
      const result = await saveSavedAddress(formData);
      if (result.ok) onDone();
      return result;
    },
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {entry && <input type="hidden" name="addressId" value={entry.id} />}
      <ErrorLine result={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          name="label"
          text="Nickname"
          defaultValue={entry?.label}
          placeholder="Home"
          maxLength={MAX_LABEL_LENGTH}
        />
        <Input name="phone" text="Phone" defaultValue={entry?.phone} placeholder="4055551234" />
        <Input name="firstName" text="First name" defaultValue={entry?.firstName} required />
        <Input name="lastName" text="Last name" defaultValue={entry?.lastName} required />
        <Input
          name="shipLine1"
          text="Address"
          defaultValue={entry?.shipLine1}
          required
          className="sm:col-span-2"
        />
        <Input
          name="shipLine2"
          text="Apt / suite"
          defaultValue={entry?.shipLine2}
          className="sm:col-span-2"
        />
        <Input name="shipCity" text="City" defaultValue={entry?.shipCity} required />
        <div className="grid grid-cols-2 gap-3">
          <Input
            name="shipState"
            text="State"
            defaultValue={entry?.shipState}
            maxLength={2}
            placeholder="OK"
            required
          />
          <Input
            name="shipPostalCode"
            text="ZIP"
            defaultValue={entry?.shipPostalCode}
            maxLength={10}
            pattern={ZIP_PATTERN}
            title={ZIP_TITLE}
            required
          />
        </div>
      </div>

      <label className="flex min-h-11 items-center gap-2.5 text-sm text-[var(--color-fg)] sm:min-h-0">
        <input
          type="checkbox"
          name="sameBillingAndShipping"
          checked={sameBilling}
          onChange={(e) => setSameBilling(e.target.checked)}
          className="size-4 accent-[var(--color-brand)]"
        />
        Billing address is the same as shipping
      </label>

      {!sameBilling && (
        <div className="grid gap-3 rounded-lg border border-[var(--color-edge)] p-4 sm:grid-cols-2">
          <Input
            name="billFirstName"
            text="Billing first name"
            defaultValue={entry?.billFirstName}
          />
          <Input name="billLastName" text="Billing last name" defaultValue={entry?.billLastName} />
          <Input
            name="billLine1"
            text="Billing address"
            defaultValue={entry?.billLine1}
            required
            className="sm:col-span-2"
          />
          <Input
            name="billLine2"
            text="Apt / suite"
            defaultValue={entry?.billLine2}
            className="sm:col-span-2"
          />
          <Input name="billCity" text="City" defaultValue={entry?.billCity} required />
          <div className="grid grid-cols-2 gap-3">
            <Input
              name="billState"
              text="State"
              defaultValue={entry?.billState}
              maxLength={2}
              required
            />
            <Input
              name="billPostalCode"
              text="ZIP"
              defaultValue={entry?.billPostalCode}
              maxLength={10}
              pattern={ZIP_PATTERN}
              title={ZIP_TITLE}
              required
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Saving…" : entry ? "Save address" : "Add address"}
        </button>
        <button type="button" onClick={onDone} className={quiet}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CardForm({ card, onDone }: { card?: SavedCardSummary; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => {
      const result = await saveSavedCard(formData);
      if (result.ok) onDone();
      return result;
    },
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {card && <input type="hidden" name="cardId" value={card.id} />}
      <ErrorLine result={state} />
      {card && (
        <p className="text-xs text-[var(--color-muted)]">
          Currently <span className="text-[var(--color-fg)]">{card.cardLabel}</span>. Leave the
          number blank to keep it — we can&rsquo;t show it back to you. A new expiry on its own is
          fine.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          name="label"
          text="Nickname"
          defaultValue={card?.label}
          placeholder="Chase Sapphire"
          maxLength={MAX_LABEL_LENGTH}
          className="sm:col-span-2"
        />
        <Input
          name="cardNumber"
          text="Card number"
          inputMode="numeric"
          placeholder={card ? "•••• (unchanged)" : ""}
          required={!card}
          className="sm:col-span-2"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            name="cardExpMonth"
            text="Exp. month"
            defaultValue={card?.cardExpMonth}
            maxLength={2}
            placeholder="09"
            required
          />
          <Input
            name="cardExpYear"
            text="Exp. year"
            defaultValue={card?.cardExpYear}
            maxLength={4}
            placeholder="2030"
            required
          />
        </div>
        <div>
          <label className={label}>
            Security code
            {/* A new card always has a number, so it always needs its code. An edit needs one
                only with a new number, which no attribute can say -- the action checks. */}
            {!card && <span className="ml-0.5 text-[var(--color-brand)]">*</span>}
            <span className="mt-1 block font-normal">
              <PasswordInput
                name="cardCvv"
                maxLength={4}
                placeholder={card ? "•••" : ""}
                autoComplete="off"
                required={!card}
                noun="security code"
                className={field}
              />
            </span>
          </label>
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            {card ? "Only needed with a new number." : "3 digits on the back — 4 for Amex."}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? "Saving…" : card ? "Save card" : "Add card"}
        </button>
        <button type="button" onClick={onDone} className={quiet}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Remove, in two clicks: the first one only asks. An entry is cheap to re-add, not free. */
function Remove({
  name,
  id,
  action,
}: {
  name: "addressId" | "cardId";
  id: string;
  action: (form: FormData) => Promise<ActionResult>;
}) {
  const [asking, setAsking] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => action(formData),
    null,
  );

  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className={quiet}>
        Remove
      </button>
    );
  }
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name={name} value={id} />
      <span className="text-xs text-[var(--color-muted)]">
        {state && !state.ok ? state.error : "Remove it?"}
      </span>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-11 items-center text-xs font-semibold text-[var(--color-brand)] disabled:opacity-60 sm:min-h-0"
      >
        {pending ? "Removing…" : "Yes"}
      </button>
      <button type="button" onClick={() => setAsking(false)} className={quiet}>
        No
      </button>
    </form>
  );
}

/** One of the member's profiles, as the copy picker lists it. */
export type CopyableProfile = { id: string; name: string; siteKey: string };

function CopyFromProfile({ profiles }: { profiles: CopyableProfile[] }) {
  const [state, formAction, pending] = useActionState(
    async (_previous: CopyToBookResult | null, formData: FormData) =>
      saveProfileToAddressBook(formData),
    null,
  );

  const bySite = new Map<string, CopyableProfile[]>();
  for (const profile of profiles) {
    bySite.set(profile.siteKey, [...(bySite.get(profile.siteKey) ?? []), profile]);
  }

  return (
    <form
      action={formAction}
      className="mt-4 rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-4"
    >
      <label htmlFor="copyProfile" className="text-sm font-semibold text-white">
        Copy from one of your profiles
      </label>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Adds that profile&rsquo;s address and card to your address book — nothing to retype, and
        anything already here is skipped.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          id="copyProfile"
          name="profileId"
          required
          defaultValue=""
          className={`${field} max-w-sm flex-1`}
        >
          <option value="" disabled>
            Pick a profile…
          </option>
          {[...bySite.entries()].map(([siteKey, list]) => (
            <optgroup key={siteKey} label={siteStyle(siteKey).label}>
              {list.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="submit" disabled={pending} className={outline}>
          {pending ? "Copying…" : "Copy to address book"}
        </button>
      </div>
      {state &&
        (state.ok ? (
          <p className="mt-2 text-xs text-[var(--color-good)]">{state.message}</p>
        ) : (
          <p role="alert" className="mt-2 text-xs text-[var(--color-warn)]">
            {state.error}
          </p>
        ))}
    </form>
  );
}

export function AddressBook({
  book,
  profiles,
}: {
  book: Book;
  /** Their profiles on every retailer, for "Copy from one of your profiles". */
  profiles: CopyableProfile[];
}) {
  // One form open at a time across the whole section: "address:new", "card:<id>", ...
  const [open, setOpen] = useState<string | null>(null);
  const close = () => setOpen(null);
  const toggle = (key: string) => setOpen((current) => (current === key ? null : key));

  return (
    <section id="address-book" className="mt-12 scroll-mt-6">
      <h2 className="mb-2 flex items-center gap-2.5 text-xl font-bold tracking-tight">
        <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
        Address book
      </h2>
      <p className="mb-4 max-w-2xl text-sm text-[var(--color-muted)]">
        Save the addresses and cards you use once, then fill a new profile on any retailer from them
        with <span className="text-[var(--color-fg)]">Add profile</span>. Only you see these, and
        editing one here doesn&rsquo;t change a profile you already made from it. Cards are
        encrypted the moment you save them, like your profiles&rsquo; are.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- addresses --- */}
        <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
          <header className="flex items-center justify-between gap-3 border-b border-[var(--color-edge)] px-4 py-3">
            <h3 className="text-sm font-semibold text-white">
              Addresses{" "}
              <span className="font-normal text-[var(--color-muted)]">{book.addresses.length}</span>
            </h3>
            <button type="button" onClick={() => toggle("address:new")} className={outline}>
              {open === "address:new" ? "Cancel" : "Add address"}
            </button>
          </header>
          {open === "address:new" && (
            <div className="border-b border-[var(--color-edge)] p-4">
              <AddressForm onDone={close} />
            </div>
          )}
          {book.addresses.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
              No saved addresses yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-edge)]">
              {book.addresses.map((entry) => (
                <li key={entry.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white">{addressTitle(entry)}</p>
                      <p className="mt-0.5 text-xs break-words text-[var(--color-muted)]">
                        {entry.label && `${entry.firstName} ${entry.lastName} · `}
                        {addressLine(entry)}
                        {entry.phone && ` · ${entry.phone}`}
                        {!entry.sameBillingAndShipping && " · separate billing address"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(`address:${entry.id}`)}
                      className={quiet}
                    >
                      {open === `address:${entry.id}` ? "Close" : "Edit"}
                    </button>
                    <Remove name="addressId" id={entry.id} action={deleteSavedAddress} />
                  </div>
                  {open === `address:${entry.id}` && (
                    <div className="mt-3">
                      <AddressForm key={entry.id} entry={entry} onDone={close} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* --- cards --- */}
        <div className="rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]">
          <header className="flex items-center justify-between gap-3 border-b border-[var(--color-edge)] px-4 py-3">
            <h3 className="text-sm font-semibold text-white">
              Cards{" "}
              <span className="font-normal text-[var(--color-muted)]">{book.cards.length}</span>
            </h3>
            <button type="button" onClick={() => toggle("card:new")} className={outline}>
              {open === "card:new" ? "Cancel" : "Add card"}
            </button>
          </header>
          {open === "card:new" && (
            <div className="border-b border-[var(--color-edge)] p-4">
              <CardForm onDone={close} />
            </div>
          )}
          {book.cards.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-[var(--color-muted)]">
              No saved cards yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-edge)]">
              {book.cards.map((card) => (
                <li key={card.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
                        {cardTitle(card)}
                        {card.cardExpired && (
                          <span className="inline-flex items-center rounded-full bg-[var(--color-brand)]/15 px-2 py-1 text-[10px] leading-none font-medium tracking-wide text-[var(--color-fg)] uppercase">
                            Expired
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        exp {card.cardExpMonth}/{card.cardExpYear.slice(-2)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggle(`card:${card.id}`)}
                      className={quiet}
                    >
                      {open === `card:${card.id}` ? "Close" : "Edit"}
                    </button>
                    <Remove name="cardId" id={card.id} action={deleteSavedCard} />
                  </div>
                  {open === `card:${card.id}` && (
                    <div className="mt-3">
                      <CardForm key={card.id} card={card} onDone={close} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {profiles.length > 0 && <CopyFromProfile profiles={profiles} />}
    </section>
  );
}
