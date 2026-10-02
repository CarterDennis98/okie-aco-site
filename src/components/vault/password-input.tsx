"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";

/**
 * A password input with an eye at its trailing edge, for checking what you typed.
 *
 * It shows WHAT WAS TYPED HERE and nothing else. The vault is write-only -- a stored
 * password or security code never comes back to the browser -- so there is no saved value
 * this could reveal. That is why the eye only appears once the field has something in it:
 * on an empty "(unchanged)" field it would read as a way to see the saved password, on a
 * page that promises nothing ever can.
 *
 * Masked again whenever it stops being looked at, or starts being sent:
 *
 *   - on submit, before the form is read. A browser may remember what was typed into a
 *     text input for next time; it never does for a password input.
 *   - when the tab is hidden. A password left on screen behind a switched tab is the
 *     realistic leak, the same reasoning as RevealAppPassword's timeout.
 *   - when the field is emptied or the form reset, so a new value always starts masked.
 *
 * While shown it is a plain text input, so spellcheck, autocorrect and autocapitalize are
 * off. Chrome's enhanced spellcheck sends text-field contents to Google, and a phone
 * keyboard would "correct" the next character typed into a password.
 */

type PasswordInputProps = Omit<ComponentProps<"input">, "type"> & {
  /** What the field holds, for the button: "Show password", "Show security code". */
  noun?: string;
};

export function PasswordInput({
  noun = "password",
  className = "",
  onInput,
  ...props
}: PasswordInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);
  const [filled, setFilled] = useState(false);
  // Where the caret was when the eye was pressed, so it can be put back. Swapping an input's
  // type sends it to the start, and the next keystroke would land there.
  const caret = useRef<[number | null, number | null] | null>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    // flushSync: an ordinary update would render after the submit had been handled, with
    // the field still a text input when the browser looked at it.
    const mask = () => flushSync(() => setShown(false));
    const clear = () => {
      setShown(false);
      setFilled(false);
    };
    form.addEventListener("submit", mask);
    form.addEventListener("reset", clear);
    return () => {
      form.removeEventListener("submit", mask);
      form.removeEventListener("reset", clear);
    };
  }, []);

  useEffect(() => {
    if (!shown) return;
    const maskIfHidden = () => {
      if (document.hidden) setShown(false);
    };
    document.addEventListener("visibilitychange", maskIfHidden);
    return () => document.removeEventListener("visibilitychange", maskIfHidden);
  }, [shown]);

  useLayoutEffect(() => {
    const input = ref.current;
    const saved = caret.current;
    caret.current = null;
    if (!input || !saved || document.activeElement !== input) return;
    // Layout FIRST. Chrome resets the caret when it lays out the retyped field, and left to
    // itself that happens after this effect -- so a caret set any earlier is overwritten,
    // which a real click shows and a scripted one does not.
    input.getBoundingClientRect();
    input.setSelectionRange(saved[0], saved[1]);
  }, [shown]);

  function toggle() {
    const input = ref.current;
    if (input) caret.current = [input.selectionStart, input.selectionEnd];
    setShown((value) => !value);
  }

  return (
    <div className="relative">
      <input
        {...props}
        ref={ref}
        type={shown ? "text" : "password"}
        onInput={(event) => {
          const hasValue = event.currentTarget.value !== "";
          setFilled(hasValue);
          if (!hasValue) setShown(false);
          onInput?.(event);
        }}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        // Room for the eye whether or not it is showing, so text never reflows under it.
        // Edge draws an eye of its own inside every password input; hidden, so there is one.
        className={`${className} pr-11 [&::-ms-reveal]:hidden`}
      />
      {filled && (
        // Same footprint as the profile form's die: the full height of the field and 44px
        // wide, so it is a real target on a phone. The label stays "Show <noun>" and
        // aria-pressed carries the state, so a screen reader hears one control that toggles
        // rather than a name that changes under it; the tooltip says what a click will do.
        <button
          type="button"
          // Keeps focus in the field, so typing carries on after a click and a phone's
          // keyboard stays up. Tab-then-Space still reaches it from the keyboard.
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
          aria-label={`Show ${noun}`}
          aria-pressed={shown}
          aria-controls={props.id}
          title={`${shown ? "Hide" : "Show"} ${noun}`}
          className={
            "absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg transition-colors hover:text-[var(--color-fg)] " +
            (shown ? "text-[var(--color-fg)]" : "text-[var(--color-muted)]")
          }
        >
          <EyeIcon struck={shown} />
        </button>
      )}
    </div>
  );
}

/**
 * Open while masked, struck through while shown: the icon is what a click does. Inline SVG
 * with `currentColor`, like the profile form's die, so it takes the button's colours and
 * renders the same on every platform.
 */
function EyeIcon({ struck }: { struck: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.5 8c1.6-3 3.8-4.5 6.5-4.5s4.9 1.5 6.5 4.5c-1.6 3-3.8 4.5-6.5 4.5S3.1 11 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
      {struck && <path d="M2.5 13.5 13.5 2.5" />}
    </svg>
  );
}
