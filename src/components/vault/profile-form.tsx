"use client";

import { useActionState, useState } from "react";
import type { VaultProfileDetail } from "@/db/queries/vault";
import { detectBrand, expectedCvvLength } from "@/lib/vault/card";
import { saveProfile, type ActionResult } from "@/lib/vault/actions";
import { siteRequiresPhone, siteStyle, siteUsesAccounts } from "@/lib/sites";
import { POSTAL_CODE_RE } from "@/lib/vault/profile-input";
import { randomFirstName, randomLastName, randomPhone } from "@/lib/vault/random-identity";

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
   * that mean "required only sometimes" already say so -- `required={!isEdit}` on the
   * account password, `required={phoneRequired}` on the phone -- so passing this straight
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
      {hint && <p className="mt-1 text-[11px] text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function ProfileForm({
  siteKey,
  profile,
  nextName,
  siblings = [],
  onDone,
}: {
  siteKey: string;
  profile?: VaultProfileDetail;
  /** Preview of the name a new profile will be given. Display only. */
  nextName?: string;
  /**
   * The member's other profiles on this retailer, so a randomized name doesn't come back
   * as one they already use. Names only -- nothing here reads anything else off them.
   */
  siblings?: { firstName: string; lastName: string }[];
  onDone?: () => void;
}) {
  const isEdit = Boolean(profile);
  // Guest-checkout retailers have no login. The email stays -- it's where the order
  // confirmation goes -- but asking for a password invents a credential that does not
  // exist, and made the profile unsaveable because the field was required.
  const usesAccounts = siteUsesAccounts(siteKey);
  // Walmart will not check out without a phone number, so the field is required and gets no
  // die at all -- see requiresPhone in sites.ts.
  const phoneRequired = siteRequiresPhone(siteKey);
  const [sameBilling, setSameBilling] = useState(profile?.sameBillingAndShipping ?? true);
  const [cardBrand, setCardBrand] = useState(profile?.cardBrand ?? "Unknown");

  // Controlled, because the randomize buttons write to them.
  const [firstName, setFirstName] = useState(profile?.firstName ?? "");
  const [lastName, setLastName] = useState(profile?.lastName ?? "");
  const [phone, setPhone] = useState(profile?.phone ?? "");
  const [shipState, setShipState] = useState(profile?.shipState ?? "");

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

      {state && !state.ok && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-brand)]/40 bg-[var(--color-brand)]/10 px-3 py-2 text-sm text-[var(--color-fg)]"
        >
          {state.error}
        </p>
      )}

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
            defaultValue={profile?.email}
            required
            hint={
              usesAccounts
                ? "Must be unique — one account per profile."
                : "Must be unique — one per profile. Checkout is as a guest, so there's no password."
            }
          />
          {usesAccounts && (
            <Field
              name="accountPassword"
              label="Account password"
              type="password"
              placeholder={isEdit ? "•••••••• (unchanged)" : ""}
              required={!isEdit}
              hint={isEdit ? "Leave blank to keep the current password." : undefined}
            />
          )}
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-[var(--color-edge)] p-4">
        <legend className="px-1 text-xs font-semibold tracking-wide text-[var(--color-muted)] uppercase">
          Shipping
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
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
            defaultValue={profile?.shipLine1}
            required
            className="sm:col-span-2"
          />
          <Field
            name="shipLine2"
            label="Apt / suite"
            defaultValue={profile?.shipLine2}
            className="sm:col-span-2"
          />
          <Field name="shipCity" label="City" defaultValue={profile?.shipCity} required />
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
              defaultValue={profile?.shipPostalCode}
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
          <div className="grid gap-3 sm:grid-cols-2">
            <Field name="billFirstName" label="First name" defaultValue={profile?.billFirstName} />
            <Field name="billLastName" label="Last name" defaultValue={profile?.billLastName} />
            <Field
              name="billLine1"
              label="Address"
              defaultValue={profile?.billLine1}
              required
              className="sm:col-span-2"
            />
            <Field
              name="billLine2"
              label="Apt / suite"
              defaultValue={profile?.billLine2}
              className="sm:col-span-2"
            />
            <Field name="billCity" label="City" defaultValue={profile?.billCity} required />
            <div className="grid grid-cols-2 gap-3">
              <Field
                name="billState"
                label="State"
                defaultValue={profile?.billState}
                maxLength={2}
                required
              />
              <Field
                name="billPostalCode"
                label="ZIP"
                defaultValue={profile?.billPostalCode}
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

        {isEdit && (
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Currently <span className="text-[var(--color-fg)]">{profile!.cardLabel}</span>. Leave
            the number blank to keep it — we can&rsquo;t show it back to you.
          </p>
        )}

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
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add profile"}
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
