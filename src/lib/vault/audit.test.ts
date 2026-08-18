/**
 * The bulk-change notification body.
 *
 * Two things worth pinning: the operator can see WHICH profiles moved and on which
 * retailer, and the message can never grow past what Discord accepts -- a rejected
 * webhook leaves `notifiedAt` null and reads as an outage rather than a long selection.
 */
import { describe, expect, it } from "vitest";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";
import { detailBlock, type ChangeRecord } from "@/lib/vault/audit";

function change(siteKey: string, label: string): ChangeRecord {
  return {
    actorDiscordId: "1",
    ownerDiscordId: "1",
    entity: VaultEntity.VAULT_PROFILE,
    entityId: label,
    action: VaultAction.DEACTIVATE,
    siteKey,
    label,
  };
}

describe("detailBlock", () => {
  it("names the retailer and every profile, in a text fence", () => {
    const block = detailBlock([
      change("walmart", "Walmart 2"),
      change("walmart", "Walmart 1"),
      change("pokemon-center", "PKC 1"),
    ]);

    expect(block).toContain("```text");
    // Display label, not the internal key.
    expect(block).toContain("Pokémon Center (1)");
    expect(block).toContain("Walmart (2)");
    expect(block).toContain("Walmart 1");
    expect(block).toContain("Walmart 2");
    expect(block).toContain("PKC 1");
  });

  it("sorts so the same selection always reads the same way", () => {
    const block = detailBlock([change("target", "Target 3"), change("target", "Target 1")]);
    expect(block.indexOf("Target 1")).toBeLessThan(block.indexOf("Target 3"));
  });

  it("stays well under Discord's 2000-character limit for a huge selection", () => {
    const many = Array.from({ length: 400 }, (_, i) => change("walmart", `Walmart ${i + 1}`));
    const block = detailBlock(many);

    expect(block.length).toBeLessThan(1500);
    expect(block).toContain("Walmart (400)");
    // Truncated, and honest about it rather than silently dropping the rest.
    expect(block).toMatch(/and \d+ more/);
  });

  it("does not lose changes that carry no retailer", () => {
    const block = detailBlock([{ ...change("walmart", "W1"), siteKey: null }]);
    expect(block).toContain("Other");
  });
});
