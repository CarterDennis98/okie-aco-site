import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import Image from "next/image";
import { connection } from "next/server";

/**
 * Member hauls, from the success channel.
 *
 * DRIVEN BY THE DIRECTORY, not a database table or a hardcoded list. Photos change
 * a few times a year at most, and the alternative -- an upload endpoint, a storage
 * bucket, signed URLs, an admin screen -- is a lot of moving parts for a marketing
 * section. Dropping a file into public/success/ and pushing is the whole workflow, and
 * pushing is already how the site deploys.
 *
 * SHUFFLED ON EVERY PAGE LOAD, so the filename no longer decides the layout. A numeric
 * prefix like 01- is still stripped from the caption, which keeps the existing names
 * reading cleanly, but it orders nothing.
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

/**
 * Fisher-Yates, so every order is equally likely. The usual one-liner,
 * `sort(() => Math.random() - 0.5)`, is not: it favours some orders over others, so the
 * same few photos would keep landing first.
 */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function photos(): { file: string; caption: string }[] {
  if (!existsSync(DIR)) return [];
  return shuffled(readdirSync(DIR).filter((file) => EXTENSIONS.test(file))).map((file) => ({
    file,
    caption: captionFrom(file),
  }));
}

export async function MemberSuccess() {
  // The shuffle has to run per request, never at build. The home page is force-dynamic
  // today, so this changes nothing yet -- but a prerendered page would bake ONE order into
  // the build and serve it to everyone until the next deploy, which looks exactly like
  // the shuffle working on the first load and then never again.
  await connection();

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
              // Only the first row is likely above the fold -- whichever photos the shuffle
              // put there -- so the rest can wait. `preload` rather than `priority`, which
              // Next 16 deprecated in its favour: same behaviour, new name.
              preload={index < 3}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
