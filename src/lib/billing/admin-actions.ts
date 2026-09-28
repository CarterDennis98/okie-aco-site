"use server";

import { getAdHocDetail, type AdHocDetail } from "@/db/queries/ad-hoc";
import { getBillCheckouts, type BillCheckouts } from "@/db/queries/drop-checkouts";
import { chargeScopeOf, requireAnyAdmin } from "@/lib/auth/guard";

/**
 * Admin-only billing reads.
 *
 * Kept out of billing/actions.ts so the guard used by each file stays obvious at a glance,
 * the same split the vault actions use: every export here calls `requireAnyAdmin()` and
 * scopes what it reads to the charges that admin handles. A Server Action is an
 * individually-addressable POST endpoint, so mixing guards in one module is exactly how
 * the wrong one ends up on the wrong action.
 */

/**
 * What the member on a charge actually checked out during its drop window.
 *
 * An action rather than a prop on the charges table: a page of 50 charges would otherwise
 * fetch and ship every member's checkouts for every drop on screen just in case one row
 * gets expanded. This costs nothing until someone opens one.
 *
 * Returns null for a bill that doesn't exist or belongs to a dry run -- a preview nobody
 * was billed for is not a charge, so there is nothing to break down.
 */
export async function loadBillCheckouts(billId: string): Promise<BillCheckouts | null> {
  const viewer = await requireAnyAdmin();
  if (!billId) return null;
  // A runner opens only charges owed to them; anyone else's reads as not found.
  return getBillCheckouts(billId, chargeScopeOf(viewer));
}

/**
 * The same expansion for a fee issued by hand, which has no checkouts to show: who issued
 * it, against which profile, and its lines. Scoped exactly like loadBillCheckouts.
 */
export async function loadAdHocDetail(billId: string): Promise<AdHocDetail | null> {
  const viewer = await requireAnyAdmin();
  if (!billId) return null;
  return getAdHocDetail(billId, chargeScopeOf(viewer));
}
