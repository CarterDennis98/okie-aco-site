import { siteHiddenGroup } from "@/lib/sites";

/**
 * The files the operator's profile export can write: the same profiles, in whichever shape the
 * bot loading them reads.
 *
 *   aycd     AYCD's profile JSON. Every retailer, and what a URL with no `format` gets.
 *   hidden   Hidden AIO's profile CSV. Only where the retailer names a Hidden group to file the
 *            rows under -- Costco. See hidden.ts and `hiddenGroup` in sites.ts.
 *
 * Shared by the export route, which writes them and refuses one a retailer doesn't offer, and
 * the profiles page, which offers the choice. Pure, so a client component can import it.
 */
export const PROFILE_FORMATS = {
  aycd: "AYCD",
  hidden: "Hidden",
} as const satisfies Record<string, string>;

export type ProfileFormat = keyof typeof PROFILE_FORMATS;

/** What a profile URL with no `format` gets: the file every bot was loaded with before the choice. */
export const DEFAULT_PROFILE_FORMAT: ProfileFormat = "aycd";

export function isProfileFormat(value: unknown): value is ProfileFormat {
  return typeof value === "string" && Object.hasOwn(PROFILE_FORMATS, value);
}

/** The bot's own name -- "AYCD", "Hidden" -- which is how a runner knows the file. */
export function profileFormatLabel(format: ProfileFormat): string {
  return PROFILE_FORMATS[format];
}

/** The formats this retailer's export offers, in the order the picker lists them: AYCD's first. */
export function siteProfileFormats(site: string | null | undefined): ProfileFormat[] {
  return siteHiddenGroup(site) ? ["aycd", "hidden"] : ["aycd"];
}
