"use client";

import { useActionState, useState } from "react";
import type { VaultLoginSummary, VaultProfileDetail } from "@/db/queries/vault";
import {
  addressLine,
  addressTitle,
  cardTitle,
  EMPTY_ADDRESS_BOOK,
  profilesUsingCard,
  type AddressBook,
  type SavedAddressSummary,
} from "@/lib/vault/address-book";
import { detectBrand, expectedCvvLength } from "@/lib/vault/card";
import { saveProfile, type ActionResult } from "@/lib/vault/actions";
import {
  siteMembership,
  siteRequiresPhone,
  siteStoresPassword,
  siteStyle,
  siteUsesAccounts,
} from "@/lib/sites";
import { POSTAL_CODE_RE } from "@/lib/vault/profile-input";
import { randomFirstName, randomLastName, randomPhone } from "@/lib/vault/random-identity";
import { PasswordInput } from "@/components/vault/password-input";

/**
 * The server's ZIP rule, handed to the browser.
 *
 * DERIVED from POSTAL_CODE_RE rather than retyped, so the field a member types into and
 * the check that refuses their save cannot drift apart. `pattern` is implicitly anchored,
 * which is why the ^ and $ come off.
 *
 * No `inputMode="numeric"`: the numeric keypad on iOS has no hyphen, so it would make a
 * ZIP+4 untypeable on a phone -- and ZIP+4 is valid.
 */
const ZIP_PATTERN = POSTAL_CODE_RE.source.replace(/^\^/, "").replace(/\$$/, "");
const ZIP_TITLE = "Five digits, or ZIP+4 like 73069-1234.";

/**
 * Add / edit form for one checkout profile.
 *
 * The secret fields (card number, security code, account password) are WRITE-ONLY: on
 * an existing profile they render empty with a "leave blank to keep" hint, because
 * nothing can read the stored value back to prefill them. That is the whole point --
 * a form that could prefill a card number is a form that can leak one.
 *
 * Client-side validation here is a convenience only. `saveProfile` re-validates
 * everything server-side, since a Server Action is a public POST endpoint.
 *
 * Given a `login` instead of a profile, it FINISHES that login: a new profile on the
 * account already on file, which has the email and usually the password and is missing
 * only the address and the card. Every Costco login from before Costco took full profiles
 * is finished this way. The email arrives filled in, and the password is asked for only if
 * none was saved -- the stored one is kept unless a new one is typed.
 *
 * Given the member's ADDRESS BOOK, it offers to fill itself from it. An address is copied into
 * the fields, where the member can still change anything -- addresses are shown on this form
 * anyway. A card is not: it is named by id in `savedCardId`, and `saveProfile` copies its
 * number and code across on the server, so the browser never holds them. A number typed into
 * the card field wins over a picked card.
 */

/*
 * `text-base sm:text-sm` -- 16px on a phone, 14px from `sm` up, and the 16 is not a taste
 * call. Mobile Safari zooms the page in on any input whose font-size is under 16px and
 * does not zoom back out when the field blurs, so filling this form on an iPhone left you
 * scrolled sideways inside a magnified page for every field after the first. The same
 * threshold applies to every input and select on the site.
 */
const field =
  "w-full rounded-lg border border-[var(--color-edge)] bg-[var(--color-ink)] px-3 py-2 text-base sm:text-sm text-[var(--color-fg)] placeholder:text-[var(--color-muted)]/60 focus:border-[var(--color-brand)] focus:outline-none";
const label = "mb-1 block text-xs font-medium text-[var(--color-muted)]";

/**
 * A die, for the in-field randomize control.
 *
 * Inline SVG rather than a text glyph or an emoji: the arrows and refresh characters all
 * read as "undo" or "reload" next to a filled-in field, and 🎲 renders at a different
 * weight and baseline on every platform. `currentColor` so it inherits the hover state.
 */
function DieIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden
    >
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" />
      <circle cx="5.6" cy="5.6" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="10.4" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Uncontrolled by default, controlled when `value` is passed.
 *
 * The fields a randomize button writes to have to be controlled -- a click has to change
 * what is on screen -- and the rest have no reason to re-render this form on every
 * keystroke. Passing `value` opts one field in.
 *
 * `randomize` puts a die at the trailing edge of the input. It sits INSIDE the field rather
 * than beside it so the control is unmistakably attached to the one value it rewrites --
 * with three of them on this form, a row of buttons underneath would leave you guessing
 * which was which. The input gains right padding to match, so a long value scrolls under
 * the label rather than beneath the button.
 */
function Field({
  name,
  label: text,
  defaultValue,
  value,
  onChange,
  placeholder,
  required,
  maxLength,
  type = "text",
  className = "",
  hint,
  pattern,
  patternTitle,
  randomize,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /**
   * Draws the asterisk AND refuses a blank in the browser.
   *
   * It used to do only the first, so every "required" field on this form was a red star
   * over an input that submitted happily empty and came back with a server error. Callers
   * that mean "required only sometimes" already say so -- `required={!keepsPassword}` on
   * the account password, `required={phoneRequired}` on the phone -- so passing this straight
   * through is what those were always describing.
   *
   * NOT used where the rule is conditional on another field: the security code is required
   * only when a new card number is entered, which no HTML attribute can express, so it
   * stays unmarked here and `validateProfileForm` owns it.
   */
  required?: boolean;
  maxLength?: number;
  type?: string;
  className?: string;
  hint?: string;
  /**
   * Native constraint validation, for fields with a shape a browser can check.
   *
   * `title` is what the browser puts in the bubble when the pattern fails, so it has to
   * read as an instruction rather than a label. This is a CONVENIENCE, not the rule --
   * `validateProfileForm` re-checks server-side, because a pattern attribute is one
   * devtools edit away from gone.
   */
  pattern?: string;
  patternTitle?: string;
  /** Tooltip text plus the handler. Renders a die inside the trailing edge of the input. */
  randomize?: { title: string; onClick: () => void };
}) {
  const controlled = value !== undefined;

  return (
    <div className={className}>
      <label htmlFor={name} className={label}>
        {text}
        {required && <span className="ml-0.5 text-[var(--color-brand)]">*</span>}
      </label>
      {type === "password" ? (
        // The show / hide eye takes the trailing edge, so a password field never gets a die.
        // Never prefilled either: the value is write-only, so there is nothing to put in it.
        <PasswordInput
          id={name}
          name={name}
          placeholder={placeholder}
          maxLength={maxLength}
          required={required}
          pattern={pattern}
          title={patternTitle}
          autoComplete="off"
          noun={text.toLowerCase()}
          className={field}
        />
      ) : (
        <div className="relative">
          <input
            id={name}
            name={name}
            type={type}
            {...(controlled
              ? { value, onChange: (e) => onChange?.(e.currentTarget.value) }
              : { defaultValue: defaultValue ?? "" })}
            placeholder={placeholder}
            maxLength={maxLength}
            required={required}
            pattern={pattern}
            title={patternTitle}
            // Browsers and password managers should not be storing these for us.
            autoComplete="off"
            className={field + (randomize ? " pr-11" : "")}
          />
          {randomize && (
            // `title` is the hover tooltip and `aria-label` carries the same text, because a
            // tooltip does not exist for a screen reader or on a touch screen. 44px wide and
            // the full height of the field, so it is a real target on a phone.
            <button
              type="button"
              onClick={randomize.onClick}
              title={randomize.title}
              aria-label={randomize.title}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-[var(--color-muted)] transition-colors hover:text-[var(--color-brand)]"
            >
              <DieIcon />
            </button>
          )}
        </div>
      )}
      {hint && <p className="mt-1 text-[11px] text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

/** The member's other profiles on this retailer, as far as this form reads them. */
type Sibling = {
  firstName: string;
  lastName: string;
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: string;
  cardExpYear?: string;
};

export function ProfileForm({
  siteKey,
  profile,
  login,
  nextName,
  siblings = [],
  addressBook = EMPTY_ADDRESS_BOOK,
  onDone,
}: {
  siteKey: string;
  profile?: VaultProfileDetail;
  /** A login with no profile behind it, to finish into one. Never with `profile`. */
  login?: VaultLoginSummary;
  /** Preview of the name a new profile will be given. Display only. */
  nextName?: string;
  /**
   * The member's other profiles on this retailer: so a randomized name doesn't come back as
   * one they already use, and so the card picker can say which saved card is already on some
   * of them. Names and the card's clear columns -- nothing here reads anything else off them.
   */
  siblings?: Sibling[];
  /** Their saved addresses and cards, to fill this form from. See lib/vault/address-book.ts. */
  addressBook?: AddressBook;
  onDone?: () => void;
}) {
  const isEdit = Boolean(profile);
  // Finishing a login whose password is already on file: the field may stay blank, exactly
  // as on an edit, and `saveProfile` keeps the stored one. See the note on this component.
  const keepsPassword = isEdit || Boolean(login?.hasPassword);
  // Guest-checkout retailers have no login. The email stays -- it's where the order
  // confirmation goes -- but asking for a password invents a credential that does not
  // exist, and made the profile unsaveable because the field was required.
  const usesAccounts = siteUsesAccounts(siteKey);
  // Mattel has an account, but its bot needs only the email it is registered to -- so no
  // password field, and the account's paid membership is asked for in its place. See
  // storesPassword and membership in sites.ts.
  const storesPassword = siteStoresPassword(siteKey);
  const membership = siteMembership(siteKey);
  const retailer = siteStyle(siteKey).label;
  // Walmart will not check out without a phone number, so the field is required and gets no
  // die at all -- see requiresPhone in sites.ts.
  const phoneRequired = siteRequiresPhone(siteKey);
  const [sameBilling, setSameBilling] = useState(profile?.sameBillingAndShipping ?? true);
  const [cardBrand, setCardBrand] = useState(profile?.cardBrand ?? "Unknown");

  // Controlled, because the randomize buttons -- and the address book -- write to them.
  const [firstName, setFirstName] = useState(profile?.firstName ?? "");
  const [lastName, setLastName] = useState(profile?.lastName ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [shipState, setShipState] = useState(profile?.shipState ?? "");

  // The address book entry last filled in, and how many times one has been. The rest of the
  // address fields are uncontrolled, and an uncontrolled input reads its defaultValue only
  // when it mounts -- so filling bumps the count, which is the key those fields sit under,
  // and they remount holding the entry's values. Anything typed into them is replaced, which
  // is what picking an address means.
  const [filled, setFilled] = useState<SavedAddressSummary | null>(null);
  const [fills, setFills] = useState(0);
  const address = filled ?? profile;

  // A saved card picked to pay with, by id. Its number never comes to the browser.
  const [savedCardId, setSavedCardId] = useState("");
  const savedCard = addressBook.cards.find((card) => card.id === savedCardId) ?? null;

  function fillAddress(id: string) {
    const entry = addressBook.addresses.find((a) => a.id === id);
    if (!entry) return;
    setFirstName(entry.firstName);
    setLastName(entry.lastName);
    // A phone already on the form beats none: an entry may simply not have one.
    if (entry.phone) setPhone(entry.phone);
    setShipState(entry.shipState);
    setSameBilling(entry.sameBillingAndShipping);
    setFilled(entry);
    setFills((n) => n + 1);
  }

  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => {
      const result = await saveProfile(formData);
      if (result.ok) onDone?.();
      return result;
    },
    null,
  );

  /*
   * One die per field, and ONLY on these three.
   *
   * The address and the card are what the payment actually clears against, so a random one
   * there is a declined order rather than a disguised one. Name and phone are the only
   * fields where an invention beats a repeat -- retailers throttle orders that look like one
   * person checking out five times, and those are the values they key on.
   *
   * Each name draw is checked against the member's other profiles on this retailer, on the
   * PAIR rather than the single field: a new first name is fine or not depending on the last
   * name already sitting next to it.
   */
  const randomizeFirstName = () => setFirstName(randomFirstName(lastName, siblings));
  const randomizeLastName = () => setLastName(randomLastName(firstName, siblings));
  // Area code follows the shipping state, so the number is plausible for the address.
  const randomizePhone = () => setPhone(randomPhone(shipState));

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <input type="hidden" name="siteKey" value={siteKey} />
      {profile && <input type="hidden" name="profileId" value={profile.id} />}
      {login && <input type="hidden" name="loginId" value={login.id} />}
      {savedCard && <input type="hidden" name="savedCardId" value={savedCard.id} />}

      {state && !state.ok && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-3 py-2 text-sm text-[var(--color-fg)]"
        >
          {state.error}
        </p>
      )}

      <AddressBookPicker
        book={addressBook}
        isEdit={isEdit}
        retailer={retailer}
        siblings={siblings}
        filledId={filled?.id ?? ""}
        onAddress={fillAddress}
        savedCardId={savedCardId}
        onCard={setSavedCardId}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={label}>Profile name</span>
          {/* Read-only, and not a form field at all -- names are generated server-side
              and never read from the submission, so there is nothing here for a crafted
              POST to override. */}
          <p className="rounded-lg border border-dashed border-[var(--color-edge)] px-3 py-2 text-sm text-[var(--color-fg)]">
            {profile ? profile.name : (nextName ?? "Assigned on save")}
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-muted)]">
            {profile
              ? "Fixed once created — your checkout history refers to it by name."
              : "Assigned automatically, counting on from your existing profiles."}
          </p>
        </div>
        <Field
          name="phone"
          label="Phone"
          value={phone}
          onChange={setPhone}
          placeholder="4055551234"
          required={phoneRequired}
          hint={
            phoneRequired
              ? `${siteStyle(siteKey).label} checkout won't complete without one — and it has to be a number you can actually receive a call or text on.`
              : undefined
          }
          // No die where the number has to reach the member: Walmart calls or texts it.
          randomize={
            phoneRequired
              ? undefined
              : { title: "Generate a random phone number", onClick: randomizePhone }
          }
        />
      </div>

      <fieldset className="rounded-lg border border-[var(--color-edge)] p-4">
        <legend className="px-1 text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
          {usesAccounts ? "Retailer account" : "Checkout email"}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            name="email"
            label={usesAccounts ? "Account email" : "Email"}
            type="email"
            defaultValue={profile?.email ?? login?.email}
            required
            hint={
              !usesAccounts
                ? "Must be unique — one per profile. Checkout is as a guest, so there's no password."
                : storesPassword
                  ? "Must be unique — one account per profile."
                  : `The email your ${retailer} account is registered to — no password needed. One account per profile.`
            }
          />
          {storesPassword && (
            <Field
              name="accountPassword"
              label="Account password"
              type="password"
              placeholder={
                isEdit ? "•••••••• (unchanged)" : keepsPassword ? "•••••••• (saved)" : ""
              }
              required={!keepsPassword}
              hint={
                isEdit
                  ? "Leave blank to keep the current password."
                  : keepsPassword
                    ? "Already saved with this login — leave blank to keep it."
                    : undefined
              }
            />
          )}
          {/* Where the password would be: it is the other half of what the bot needs to know
              about this account. A checkbox, not a required choice -- most accounts won't
              have it, and unticked is an honest default. */}
          {membership && (
            <div>
              <span className={label}>{membership.name}</span>
              <label className="flex min-h-11 items-center gap-2.5 rounded-lg border border-[var(--color-edge)] px-3 py-2 text-sm text-[var(--color-fg)]">
                <input
                  type="checkbox"
                  name="hasMembership"
                  defaultChecked={profile?.hasMembership ?? false}
                  className="size-4 accent-[var(--color-brand)]"
                />
                This account has {membership.short}
              </label>
              <p className="mt-1 text-[11px] text-[var(--color-muted)]">{membership.hint}</p>
            </div>
          )}
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-[var(--color-edge)] p-4">
        <legend className="px-1 text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
          Shipping
        </legend>
        {/* Keyed on the fill count -- see `fills`. */}
        <div key={fills} className="grid gap-3 sm:grid-cols-2">
          <Field
            name="firstName"
            label="First name"
            value={firstName}
            onChange={setFirstName}
            required
            randomize={{ title: "Generate a random first name", onClick: randomizeFirstName }}
          />
          <Field
            name="lastName"
            label="Last name"
            value={lastName}
            onChange={setLastName}
            required
            randomize={{ title: "Generate a random last name", onClick: randomizeLastName }}
          />
          <Field
            name="shipLine1"
            label="Address"
            defaultValue={address?.shipLine1}
            required
            className="sm:col-span-2"
          />
          <Field
            name="shipLine2"
            label="Apt / suite"
            defaultValue={address?.shipLine2}
            className="sm:col-span-2"
          />
          <Field name="shipCity" label="City" defaultValue={address?.shipCity} required />
          <div className="grid grid-cols-2 gap-3">
            {/* Controlled only so `randomize` can read it: the generated phone takes its
                area code from the state, so a member who fills the address first gets a
                number that matches it. */}
            <Field
              name="shipState"
              label="State"
              value={shipState}
              onChange={setShipState}
              maxLength={2}
              placeholder="OK"
              required
            />
            <Field
              name="shipPostalCode"
              label="ZIP"
              defaultValue={address?.shipPostalCode}
              maxLength={10}
              pattern={ZIP_PATTERN}
              patternTitle={ZIP_TITLE}
              required
            />
          </div>
        </div>
      </fieldset>

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
        <fieldset className="rounded-lg border border-[var(--color-edge)] p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
            Billing
          </legend>
          <div key={fills} className="grid gap-3 sm:grid-cols-2">
            <Field name="billFirstName" label="First name" defaultValue={address?.billFirstName} />
            <Field name="billLastName" label="Last name" defaultValue={address?.billLastName} />
            <Field
              name="billLine1"
              label="Address"
              defaultValue={address?.billLine1}
              required
              className="sm:col-span-2"
            />
            <Field
              name="billLine2"
              label="Apt / suite"
              defaultValue={address?.billLine2}
              className="sm:col-span-2"
            />
            <Field name="billCity" label="City" defaultValue={address?.billCity} required />
            <div className="grid grid-cols-2 gap-3">
              <Field
                name="billState"
                label="State"
                defaultValue={address?.billState}
                maxLength={2}
                required
              />
              <Field
                name="billPostalCode"
                label="ZIP"
                defaultValue={address?.billPostalCode}
                maxLength={10}
                pattern={ZIP_PATTERN}
                patternTitle={ZIP_TITLE}
                required
              />
            </div>
          </div>
        </fieldset>
      )}

      <fieldset className="rounded-lg border border-[var(--color-edge)] p-4">
        <legend className="px-1 text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
          Card
        </legend>

        {isEdit && !savedCard && (
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Currently <span className="text-[var(--color-fg)]">{profile!.cardLabel}</span>. Leave
            the number blank to keep it — we can&rsquo;t show it back to you.
          </p>
        )}

        {/* A picked card stands in for the whole number-code-expiry block: those come from the
            address book on the server (saveProfile), so there is nothing to type, and a field
            left showing would invite typing a number that then silently wins. */}
        {savedCard ? (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/5 px-3 py-2.5">
            <p className="text-sm text-[var(--color-fg)]">
              {isEdit ? "Switching to " : "Paying with "}
              <span className="font-semibold text-white">{cardTitle(savedCard)}</span>, exp{" "}
              {savedCard.cardExpMonth}/{savedCard.cardExpYear.slice(-2)}
              {savedCard.cardExpired && (
                <span className="ml-1.5 text-[var(--color-warn)]">— expired</span>
              )}
              <span className="block text-[11px] text-[var(--color-muted)]">
                From your address book. Its number and security code are copied in when you save.
              </span>
            </p>
            <button
              type="button"
              onClick={() => setSavedCardId("")}
              className="inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0 sm:text-xs"
            >
              {isEdit ? "Keep the current card" : "Type a card instead"}
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="cardNumber" className={label}>
                Card number
                {!isEdit && <span className="ml-0.5 text-[var(--color-brand)]">*</span>}
              </label>
              <input
                id="cardNumber"
                name="cardNumber"
                inputMode="numeric"
                autoComplete="off"
                placeholder={isEdit ? "•••• (unchanged)" : ""}
                // Its own input rather than a Field, for the brand detection -- so it needs
                // the rule spelled out here. Matches the asterisk above it and the server:
                // required to create a profile, blank on edit means "keep the current card".
                required={!isEdit}
                onChange={(e) => setCardBrand(detectBrand(e.target.value))}
                className={field}
              />
              {cardBrand !== "Unknown" && (
                <p className="mt-1 text-[11px] text-[var(--color-muted)]">Detected: {cardBrand}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field
                name="cardExpMonth"
                label="Exp. month"
                defaultValue={profile?.cardExpMonth}
                maxLength={2}
                placeholder="09"
                required
              />
              <Field
                name="cardExpYear"
                label="Exp. year"
                defaultValue={profile?.cardExpYear}
                maxLength={4}
                placeholder="2030"
                required
              />
            </div>

            <Field
              name="cardCvv"
              label="Security code"
              type="password"
              maxLength={4}
              placeholder={isEdit ? "•••" : ""}
              hint={
                isEdit
                  ? "Only needed when changing the card."
                  : `${expectedCvvLength(detectBrand(""))} digits on the back — 4 for Amex.`
              }
            />
          </div>
        )}

        {/* `onlyCheckoutOnce` is deliberately not offered here. The column stays, because
            the AYCD export and import round-trip it and imported profiles carry a real
            value, but it is the operator's call rather than a per-member setting. */}
        <div className="mt-4 flex flex-col gap-2">
          <label className="flex min-h-11 items-center gap-2.5 text-sm text-[var(--color-fg)] sm:min-h-0">
            <input
              type="checkbox"
              name="matchNameOnCardAndAddress"
              defaultChecked={profile?.matchNameOnCardAndAddress ?? true}
              className="size-4 accent-[var(--color-brand)]"
            />
            Name on the card matches the billing name
          </label>
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-brand)] px-5 py-2.5 text-sm font-semibold text-[var(--color-on-brand)] transition-colors hover:bg-[var(--color-brand-dark)] disabled:opacity-60 sm:min-h-0"
        >
          {pending ? "Saving…" : isEdit ? "Save changes" : login ? "Finish profile" : "Add profile"}
        </button>
        {onDone && (
          <button
            type="button"
            onClick={onDone}
            className="inline-flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)] sm:min-h-0"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * "From your address book": an address to fill the form with, and a card to pay with.
 *
 * With an empty book it is one line saying the book exists -- on the add form, where it would
 * have saved the typing, and not on an edit, where there is nothing left to type.
 *
 * The card list says which saved card is already on some of this retailer's profiles, the same
 * advice the profile list's "Shared card" chip gives: one card across many profiles on one
 * retailer is what makes its orders likelier to fail. Said, never refused.
 */
function AddressBookPicker({
  book,
  isEdit,
  retailer,
  siblings,
  filledId,
  onAddress,
  savedCardId,
  onCard,
}: {
  book: AddressBook;
  isEdit: boolean;
  retailer: string;
  siblings: Sibling[];
  filledId: string;
  onAddress: (id: string) => void;
  savedCardId: string;
  onCard: (id: string) => void;
}) {
  if (book.addresses.length === 0 && book.cards.length === 0) {
    if (isEdit) return null;
    return (
      <p className="-mb-2 text-[11px] text-[var(--color-muted)]">
        Tip: keep the addresses and cards you use in your{" "}
        <a
          href="#address-book"
          className="underline underline-offset-2 hover:text-[var(--color-fg)]"
        >
          address book
        </a>{" "}
        and fill this form from them in one click, on any retailer.
      </p>
    );
  }

  const picked = book.cards.find((card) => card.id === savedCardId);
  const pickedUses = picked ? profilesUsingCard(siblings, picked) : 0;

  return (
    <fieldset className="rounded-lg border border-dashed border-[var(--color-edge)] p-4">
      <legend className="px-1 text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
        From your address book
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {book.addresses.length > 0 && (
          <div>
            <label htmlFor="bookAddress" className={label}>
              Address
            </label>
            {/* No `name`: what is submitted is the fields it fills, which the member can still
                change. Picking one again re-fills them. */}
            <select
              id="bookAddress"
              value={filledId}
              onChange={(e) => onAddress(e.currentTarget.value)}
              className={field}
            >
              <option value="" disabled>
                Fill in an address…
              </option>
              {book.addresses.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {addressTitle(entry)} — {addressLine(entry)}
                </option>
              ))}
            </select>
          </div>
        )}
        {book.cards.length > 0 && (
          <div>
            <label htmlFor="bookCard" className={label}>
              Card
            </label>
            <select
              id="bookCard"
              value={savedCardId}
              onChange={(e) => onCard(e.currentTarget.value)}
              className={field}
            >
              <option value="">{isEdit ? "Keep this profile's card" : "Type a card below"}</option>
              {book.cards.map((card) => {
                const uses = profilesUsingCard(siblings, card);
                return (
                  <option key={card.id} value={card.id}>
                    {cardTitle(card)} · exp {card.cardExpMonth}/{card.cardExpYear.slice(-2)}
                    {card.cardExpired ? " · expired" : ""}
                    {uses > 0 ? ` · on ${uses} ${retailer} profile${uses === 1 ? "" : "s"}` : ""}
                  </option>
                );
              })}
            </select>
            {pickedUses > 0 && (
              <p className="mt-1 text-[11px] text-[var(--color-warn)]">
                Already on {pickedUses} of your {retailer} profiles. Reusing a card on one retailer
                can make its orders more likely to fail.
              </p>
            )}
          </div>
        )}
      </div>
    </fieldset>
  );
}
