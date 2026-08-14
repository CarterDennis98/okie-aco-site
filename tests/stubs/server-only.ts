/**
 * Stub for the `server-only` package under Vitest.
 *
 * The real module throws unless it resolves through the `react-server` export
 * condition, which only Next's server build sets. Aliased in vitest.config.mts so the
 * database and auth modules -- which correctly mark themselves server-only -- can still
 * be exercised by tests running in plain Node.
 */
export {};
