import type { DropStats } from "@/lib/products/stats";
import { count } from "@/lib/format";

/**
 * The summary above the products, for admins: who is being run, on how many profiles, and
 * for what. Every figure counts what an export would build from the picks as they stand -- a
 * pick that runs on no active profile counts for nothing.
 */

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="px-3 py-3">
      <dt className="text-[10px] tracking-[0.12em] text-[var(--color-muted)] uppercase">{label}</dt>
      <dd className="text-xl font-bold text-white">{value}</dd>
    </div>
  );
}

export function DropStatsPanel({ stats }: { stats: DropStats }) {
  return (
    <section
      aria-labelledby="drop-stats-title"
      className="mt-6 rounded-2xl border border-[var(--color-edge)] bg-[var(--color-surface)] p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="drop-stats-title" className="text-sm font-bold text-white">
          Summary
        </h2>
        <span className="text-xs text-[var(--color-muted)]">Admins only · every runner</span>
      </div>

      <dl className="mt-3 grid grid-cols-2 rounded-lg bg-[var(--color-elevated)]/50 sm:grid-cols-3">
        <Tile value={`${count(stats.running)} / ${count(stats.members)}`} label="Members running" />
        <Tile
          value={`${count(stats.profilesRunning)} / ${count(stats.profiles)}`}
          label="Profiles running"
        />
        <Tile value={count(stats.selections)} label="Selections" />
        <Tile value={count(stats.runs)} label="Checkout lines" />
        <Tile value={count(stats.products)} label="Products live" />
        <Tile value={count(stats.watched)} label="Watched" />
      </dl>

      {stats.top.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-[var(--color-muted)]">Most run</h3>
          <ol className="mt-1 space-y-1 text-sm">
            {stats.top.map((product) => (
              <li key={product.id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="min-w-0 truncate text-white">{product.name}</span>
                <span className="text-xs text-[var(--color-muted)]">
                  {product.setName} · {count(product.profiles)} profile
                  {product.profiles === 1 ? "" : "s"}, {count(product.members)} member
                  {product.members === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {stats.idle.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs font-semibold text-[var(--color-muted)] hover:text-[var(--color-fg)]">
            {count(stats.idle.length)} member{stats.idle.length === 1 ? "" : "s"} with nothing
            running
          </summary>
          {/* One name a line, in alphabetical columns: a run-on paragraph of eighty handles
              is a wall nobody can find a name in. */}
          <ul className="mt-2 columns-2 gap-x-6 rounded-lg bg-[var(--color-elevated)]/50 px-3 py-2 text-sm sm:columns-3 lg:columns-4">
            {stats.idle.map((member) => (
              <li
                key={member.discordUserId}
                title={member.name}
                className="truncate py-0.5 text-[var(--color-fg)]"
              >
                {member.name}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
