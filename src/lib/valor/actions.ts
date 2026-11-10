"use server";

import { z } from "zod";
import { operatorId } from "@/lib/auth/admin-scope";
import { requireAdmin } from "@/lib/auth/guard";
import { buildValorPayload, type ValorPayloadResult } from "@/lib/valor/payload";

/**
 * The Valor export's one server step: what the vault says each asked-for instance should
 * hold. THE OPERATOR ONLY, as the Shikari export is (shikari/actions.ts) -- checked here,
 * where the secrets are, since a Server Action is a public POST endpoint.
 *
 * Nothing about the instances is saved: who runs where is a fixed rule (valor/split.ts), so
 * there is no setup to keep between drops.
 */

const request = z
  .object({
    instances: z
      .array(z.union([z.literal(1), z.literal(2)]))
      .min(1)
      .max(2)
      .refine((list) => new Set(list).size === list.length, "Each instance once."),
  })
  .strict();

export async function prepareValorExport(raw: unknown): Promise<ValorPayloadResult> {
  const viewer = await requireAdmin();
  if (viewer.discordUserId !== operatorId()) {
    return { ok: false, error: "Only the operator exports to Valor." };
  }
  const parsed = request.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "That request didn't come through. Reload the page and try again." };
  }
  try {
    return await buildValorPayload(viewer.discordUserId, parsed.data.instances);
  } catch (error) {
    // The message only, like every other action here: a vault error is written never to carry
    // plaintext, and the full error object can.
    console.error(
      "valor: building the export failed",
      error instanceof Error ? error.message : "unknown",
    );
    return {
      ok: false,
      error: "Couldn't read the vault for that export. Nothing was exported — try again.",
    };
  }
}
