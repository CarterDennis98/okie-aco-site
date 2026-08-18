import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import Image from "next/image";

/**
 * Member hauls, from the success channel.
 *
 * DRIVEN BY THE DIRECTORY, not a database table or a hardcoded list. Photos change
 * a few times a year at most, and the alternative -- an upload endpoint, a storage
 * bucket, signed URLs, an admin screen -- is a lot of moving parts for a marketing
 * section. Dropping a file into public/success/ and pushing is the whole workflow, and
 * pushing is already how the site deploys.
 *
 * Ordered by FILENAME, so a numeric prefix controls the layout: 01-, 02-, and so on.
 *
 * Renders nothing at all when the directory is empty or missing. The section has to be
 * able to not exist -- otherwise the page ships with an empty heading and a hole in it.
 */

const DIR = path.join(process.cwd(), "public", "success");
const EXTENSIONS = /\.(jpe?g|png|webp|avif)$/i;

/** Alt text has to say something. The filename after its ordering prefix is the caption. */
function captionFrom(file: string): string {
  const base = file.replace(EXTENSIONS, "").replace(/^\d+[-_]/, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  return words ? `Member haul — ${words}` : "Member haul";
}

function photos(): { file: string; caption: string }[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((file) => EXTENSIONS.test(file))
    .sort()
    .map((file) => ({ file, caption: captionFrom(file) }));
}

export function MemberSuccess() {
  const images = photos();
  if (images.length === 0) return null;

  return (
    <section className="mt-16">
      {/* Same heading treatment as the other sections. Repeated rather than shared,
          matching SupportedSites -- the page's own SectionHeading is local to it, and
          this section has to be able to render nothing, heading included. */}
      <h2 className="mb-4 flex items-center gap-2.5 text-xl font-bold tracking-tight">
        <span aria-hidden className="h-5 w-1 rounded-full bg-[var(--color-brand)]" />
        Member success
      </h2>
      <p className="mb-5 max-w-2xl text-sm text-[var(--color-muted)]">
        Real hauls posted by members after a drop.
      </p>

      {/* Fixed aspect boxes with object-cover: the photos arrive in whatever shape a phone
          took them, and letting each set its own height turns the grid into a staircase. */}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {images.map(({ file, caption }, index) => (
          <li
            key={file}
            className="relative aspect-square overflow-hidden rounded-xl border border-[var(--color-edge)] bg-[var(--color-surface)]"
          >
            <Image
              src={`/success/${file}`}
              alt={caption}
              fill
              // Two columns on mobile, three from the sm breakpoint, inside a centred
              // max-width container -- so the largest a tile ever renders is ~1/3 of it.
              sizes="(max-width: 640px) 50vw, 33vw"
              className="object-cover"
              // Only the first row is likely above the fold; the rest can wait.
              priority={index < 3}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
