"use client";

import { useState } from "react";
import { flagLabel, type FailureFlag } from "@/lib/vault/failure-flags";
import { FAILURE_CHIP, failureDetail } from "@/components/vault/failure-styles";

/**
 * A failed-checkout flag on a profile, which explains itself on tap -- no hover on a phone, the
 * reason profile-manager's HintChip exists. The title stays for a mouse. Its looks are in
 * failure-styles.ts, shared with the pages that only show it.
 */
export function FailureChip({ flag }: { flag: FailureFlag }) {
  const [open, setOpen] = useState(false);
  const detail = failureDetail(flag);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={detail}
        className={FAILURE_CHIP[flag.risk]}
      >
        <span aria-hidden>⚠</span>
        {flagLabel(flag)}
      </button>
      {open && (
        <span className="basis-full text-[11px] leading-snug font-normal text-[var(--color-muted)]">
          {detail}
        </span>
      )}
    </>
  );
}
