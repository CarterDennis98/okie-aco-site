"use client";

import { useActionState, useState } from "react";
import type { VaultProfileDetail } from "@/db/queries/vault";
import { detectBrand, expectedCvvLength } from "@/lib/vault/card";
import { saveProfile, type ActionResult } from "@/lib/vault/actions";
import { siteUsesAccounts } from "@/lib/sites";

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

function Field({
  name,
  label: text,
  defaultValue,
  placeholder,
  required,
  maxLength,
  type = "text",
  className = "",
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  type?: string;
  className?: string;
  hint?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={name} className={label}>
        {text}
        {required && <span className="ml-0.5 text-[var(--color-brand)]">*</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
        maxLength={maxLength}
        // Browsers and password managers should not be storing these for us.
        autoComplete="off"
        className={field}
      />
      {hint && <p className="mt-1 text-[11px] text-[var(--color-muted)]">{hint}</p>}
    </div>
  );
}

export function ProfileForm({
  siteKey,
  profile,
  nextName,
  onDone,
}: {
  siteKey: string;
  profile?: VaultProfileDetail;
  /** Preview of the name a new profile will be given. Display only. */
  nextName?: string;
  onDone?: () => void;
}) {
  const isEdit = Boolean(profile);
  // Guest-checkout retailers have no login. The email stays -- it's where the order
  // confirmation goes -- but asking for a password invents a credential that does not
  // exist, and made the profile unsaveable because the field was required.
  const usesAccounts = siteUsesAccounts(siteKey);
  const [sameBilling, setSameBilling] = useState(profile?.sameBillingAndShipping ?? true);
  const [cardBrand, setCardBrand] = useState(profile?.cardBrand ?? "Unknown");

  const [state, formAction, pending] = useActionState(
    async (_previous: ActionResult | null, formData: FormData) => {
      const result = await saveProfile(formData);
      if (result.ok) onDone?.();
      return result;
    },
    null,
  );

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
        <Field name="phone" label="Phone" defaultValue={profile?.phone} placeholder="4055551234" />
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
          <Field name="firstName" label="First name" defaultValue={profile?.firstName} required />
          <Field name="lastName" label="Last name" defaultValue={profile?.lastName} required />
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
            <Field
              name="shipState"
              label="State"
              defaultValue={profile?.shipState}
              maxLength={2}
              placeholder="OK"
              required
            />
            <Field
              name="shipPostalCode"
              label="ZIP"
              defaultValue={profile?.shipPostalCode}
              maxLength={10}
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
