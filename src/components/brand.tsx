import Image from "next/image";

/** public/okie-logo.png -- 1254x1254 RGBA, square canvas with the lockup inset. */
const LOGO_SRC = "/okie-logo.png";

/**
 * @param height rendered height in px. The canvas is square, so the lockup sits
 *   smaller than this within it -- hence the header uses a larger value than a
 *   horizontal wordmark would need.
 *
 * width/height are the RENDERED size, not the file's intrinsic 1254px. That's what
 * makes next/image generate small 1x/2x variants from `imageSizes` instead of
 * treating this as a full-width hero and shipping a 3840px file.
 */
export function Logo({ height = 40, className }: { height?: number; className?: string }) {
  return (
    <Image
      src={LOGO_SRC}
      alt="Okie ACO"
      width={height}
      height={height}
      priority
      className={className}
    />
  );
}
