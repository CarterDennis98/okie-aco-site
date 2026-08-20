/**
 * The URL token for the pending-changes queue's "no retailer" bucket.
 *
 * Lives in its own module because both sides need it at RUNTIME: the query builds a `where`
 * from it, and the client component builds the filter tabs from it. `db/queries/admin-vault`
 * is `server-only`, so a client component importing the constant from there would throw at
 * build time -- a `import type` would have been fine, a value is not.
 *
 * A token rather than an empty string because `site_key IS NULL` is a real bucket here, not
 * the absence of a filter: app passwords and forwarding belong to a person, not a retailer,
 * and "" already means "everything".
 */
export const EMAIL_BUCKET = "__email__";

/** The query param the queue filter travels in. Deliberately not `site`, which the profile
 *  table below the queue already owns -- filtering the queue must not switch that table. */
export const CHANGE_FILTER_PARAM = "changes";
