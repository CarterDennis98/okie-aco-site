import "server-only";

import { prisma } from "@/db/client";
import { VaultAction, VaultEntity } from "@/generated/prisma/enums";

/**
 * Change recording and operator notification.
 *
 * Two separate jobs, deliberately in that order:
 *
 *   1. Write a `vault_changes` row. Durable, in the same database as the change.
 *   2. Try to post a Discord webhook, and stamp `notifiedAt` if it lands.
 *
 * A failed webhook therefore leaves a row with `notifiedAt = null` rather than losing
 * the notification -- the same outbox shape the bot uses for checkouts, so a Discord
 * outage during a drop costs a delay, not a record.
 *
 * **Field NAMES only, never values.** An audit log holding card numbers would defeat
 * the encryption it exists to police, and a webhook posts into a Discord channel that
 * is backed up, searchable, and outside our control.
 */

const WEBHOOK_URL = process.env.DISCORD_VAULT_WEBHOOK_URL;
const WEBHOOK_TIMEOUT_MS = 5_000;

export type ChangeRecord = {
  actorDiscordId: string;
  ownerDiscordId: string;
  entity: VaultEntity;
  entityId: string;
  action: VaultAction;
  siteKey?: string | null;
  /** Human-readable subject, e.g. the profile name. Never a secret. */
  label?: string | null;
  /** Column names that changed. Never their values. */
  fields?: string[];
};

const ACTION_VERB: Record<VaultAction, string> = {
  CREATE: "added",
  UPDATE: "updated",
  DELETE: "removed",
  ACTIVATE: "enabled",
  DEACTIVATE: "disabled",
};

const ENTITY_NOUN: Record<VaultEntity, string> = {
  VAULT_PROFILE: "profile",
  VAULT_ACCOUNT: "account",
  EMAIL_CREDENTIAL: "email app password",
  EMAIL_ALIAS: "email forwarding",
};

function describe(change: ChangeRecord, actorName: string): string {
  const verb = ACTION_VERB[change.action];
  const noun = ENTITY_NOUN[change.entity];
  const site = change.siteKey ? `${change.siteKey} ` : "";
  const subject = change.label ? ` \`${change.label}\`` : "";
  const fields = change.fields?.length ? `\n-# changed: ${change.fields.join(", ")}` : "";
  return `**${actorName}** ${verb} ${site}${noun}${subject}${fields}`;
}

/**
 * Record a change and notify. Never throws.
 *
 * Callers are mutations that have already succeeded -- failing the member's save
 * because an audit write or a webhook failed would be the wrong trade. Failures are
 * logged and, for the webhook, recoverable from the unstamped row.
 */
export async function recordChange(change: ChangeRecord, actorName: string): Promise<void> {
  let changeId: string | null = null;

  try {
    const row = await prisma.vaultChange.create({
      data: {
        actorDiscordId: change.actorDiscordId,
        ownerDiscordId: change.ownerDiscordId,
        entity: change.entity,
        entityId: change.entityId,
        action: change.action,
        siteKey: change.siteKey ?? null,
        label: change.label ?? null,
        fields: change.fields ?? [],
      },
      select: { id: true },
    });
    changeId = row.id;
  } catch (error) {
    console.error("vault: failed to record a change", error);
    return;
  }

  if (!WEBHOOK_URL) return;

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: describe(change, actorName),
        // A change notice must never ping anyone, even if a label contains an @.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);

    await prisma.vaultChange.update({
      where: { id: changeId },
      data: { notifiedAt: new Date() },
    });
  } catch (error) {
    // Left unstamped on purpose: the row is the durable record and can be re-sent.
    console.error("vault: change recorded but not notified", error);
  }
}

/**
 * Record many changes at once, and notify ONCE.
 *
 * A bulk import is still N changes and gets N rows -- the audit trail has to be able to
 * answer "when did this profile appear" per profile. But it is one action by one person,
 * and posting fifteen webhook lines for one upload trains the operator to ignore the
 * channel, which costs more than it gains.
 *
 * Never throws, for the same reason as recordChange: the writes it describes have
 * already succeeded.
 */
export async function recordBulkChange(
  changes: ChangeRecord[],
  actorName: string,
  summary: string,
): Promise<void> {
  if (changes.length === 0) return;

  let ids: string[] = [];
  try {
    // createMany doesn't return rows, so the ids are generated here to stamp later.
    const rows = changes.map((change) => ({
      id: crypto.randomUUID(),
      actorDiscordId: change.actorDiscordId,
      ownerDiscordId: change.ownerDiscordId,
      entity: change.entity,
      entityId: change.entityId,
      action: change.action,
      siteKey: change.siteKey ?? null,
      label: change.label ?? null,
      fields: change.fields ?? [],
    }));
    await prisma.vaultChange.createMany({ data: rows });
    ids = rows.map((r) => r.id);
  } catch (error) {
    console.error("vault: failed to record bulk changes", error);
    return;
  }

  if (!WEBHOOK_URL) return;

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `**${actorName}** ${summary}`,
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);

    await prisma.vaultChange.updateMany({
      where: { id: { in: ids } },
      data: { notifiedAt: new Date() },
    });
  } catch (error) {
    console.error("vault: changes recorded but not notified", error);
  }
}

/**
 * Which fields differ, for the audit trail.
 *
 * Compares only the keys present in `next`, so a partial update doesn't report every
 * untouched column as changed. Secrets are handled by the caller, which knows whether
 * a blank input meant "leave unchanged" -- this never sees a plaintext value.
 */
export function changedFields<T extends Record<string, unknown>>(
  previous: T,
  next: Partial<T>,
): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (previous[key as keyof T] !== value) changed.push(key);
  }
  return changed;
}
