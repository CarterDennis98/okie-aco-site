"use client";

/**
 * The controls a member picks with on Target Products -- a product's switch, its picture, and
 * "All profiles" or "Only some" -- shared by the product list and Live Raffles, so entering a
 * raffle works exactly like switching a product on.
 */

/** Anything picked for every profile, or for the ones listed: a product pick, a raffle entry. */
export type ProfilePick = { all: boolean; profileIds: string[] };

export type PickProfile = { id: string; name: string; active: boolean };

export function Switch({
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

export function ProductImage({ src }: { src: string | null }) {
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

/** "All profiles" or "Only some", and which. */
export function ProfileChoice<T extends ProfilePick>({
  productName,
  choice,
  profiles,
  disabled,
  onChange,
}: {
  productName: string;
  choice: T;
  profiles: PickProfile[];
  disabled: boolean;
  onChange: (next: T) => void;
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
                option.all
                  ? { ...choice, all: true, profileIds: [] }
                  : { ...choice, all: false, profileIds: picked },
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
                  title={last ? "Switch it off instead" : undefined}
                  className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-[var(--color-fg)] sm:min-h-0"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || last}
                    onChange={() =>
                      onChange({
                        ...choice,
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
