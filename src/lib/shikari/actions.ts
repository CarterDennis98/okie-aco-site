"use server";

import { prisma } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";
import { operatorId } from "@/lib/auth/admin-scope";
import { requireAdmin } from "@/lib/auth/guard";
import { exportRequest } from "@/lib/shikari/config";
import { buildShikariPayload, type PayloadResult } from "@/lib/shikari/payload";

/**
 * The Shikari export's one server step: save how the instances are set up, and hand back
 * what the vault says each should hold.
 *
 * THE OPERATOR ONLY -- the first ADMIN_DISCORD_IDS entry, not every full admin. The Shikari
 * instances are the operator's bots, loaded with the operator's assignments, so this is the
 * operator's tool the way ACO credit is. Checked here, where the secrets are, and not only by
 * the page that shows the button: a Server Action is a public POST endpoint.
 */
export async function prepareShikariExport(raw: unknown): Promise<PayloadResult> {
  const viewer = await requireAdmin();
  if (viewer.discordUserId !== operatorId()) {
    return { ok: false, error: "Only the operator exports to Shikari." };
  }

  const parsed = exportRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "That setup didn't come through. Reload the page and try again." };
  }
  const { instances } = parsed.data;
  const positions = instances.map((i) => i.position);
  if (new Set(positions).size !== positions.length) {
    return { ok: false, error: "Two instances share a number. Reload the page and try again." };
  }

  // Saved first: the choices are worth keeping for next time even if this build is refused.
  await prisma.$transaction([
    prisma.shikariInstance.deleteMany({ where: { position: { notIn: positions } } }),
    ...instances.map(({ position, config }) =>
      prisma.shikariInstance.upsert({
        where: { position },
        create: {
          position,
          config: config as Prisma.InputJsonValue,
          updatedBy: viewer.discordUserId,
        },
        update: { config: config as Prisma.InputJsonValue, updatedBy: viewer.discordUserId },
      }),
    ),
  ]);

  try {
    return await buildShikariPayload(viewer.discordUserId, parsed.data);
  } catch (error) {
    // The message only, like every other action here: a vault error is written never to carry
    // plaintext, and the full error object can.
    console.error(
      "shikari: building the export failed",
      error instanceof Error ? error.message : "unknown",
    );
    return {
      ok: false,
      error: "Couldn't read the vault for that export. Nothing was exported — try again.",
    };
  }
}
