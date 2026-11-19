/**
 * Which addresses of a selection one bulk "Forwards to" can point at an inbox, and why the
 * rest can't.
 *
 * The rules are saveEmailAlias's, decided for many addresses at once, plus one more: an
 * address is only taken if it is on one of the member's OWN logins. One address at a time,
 * the picker only ever offers those. Two hundred from a form is a different matter, because
 * a forwarded address is unique across members: a selection padded with somebody else's
 * addresses would leave them unable to forward their own.
 *
 * Pure, so the rules are tested without a database: the action reads the rows, this sorts
 * them, and the action writes what it says.
 */

export type ForwardSkip = { email: string; why: string };

export type ForwardPlan = {
  /** Addresses to start forwarding into the inbox. */
  create: string[];
  /** The member's own forwarded addresses that point at another inbox, to move to this one. */
  repoint: { id: string; email: string }[];
  /** Left as they are, each with the reason, in the order they were asked for. */
  skipped: ForwardSkip[];
};

export function planForwards({
  emails,
  inbox,
  viewerId,
  logins,
  ownPasswords,
  aliases,
}: {
  /** The addresses asked for. */
  emails: string[];
  /** The inbox they forward into, already checked to be the member's own. */
  inbox: { id: string; email: string };
  viewerId: string;
  /** Every address on the member's logins. */
  logins: string[];
  /** Every address the member has an app password for. */
  ownPasswords: string[];
  /** The forwarded addresses among the ones asked for, whoever's they are. */
  aliases: { id: string; email: string; discordUserId: string; credentialId: string }[];
}): ForwardPlan {
  const lower = (email: string) => email.trim().toLowerCase();
  const onLogins = new Set(logins.map(lower));
  const withPassword = new Set(ownPasswords.map(lower));
  const aliasOf = new Map(aliases.map((alias) => [lower(alias.email), alias]));
  const target = lower(inbox.email);

  const plan: ForwardPlan = { create: [], repoint: [], skipped: [] };
  for (const email of new Set(emails.map(lower).filter(Boolean))) {
    const alias = aliasOf.get(email);
    const skip = (why: string) => plan.skipped.push({ email, why });

    if (!onLogins.has(email)) skip("isn't on any of your logins");
    else if (email === target) skip("is the inbox itself");
    else if (withPassword.has(email)) skip("has its own app password");
    else if (alias && alias.discordUserId !== viewerId) skip("is already claimed");
    else if (alias?.credentialId === inbox.id) skip("already forwards there");
    else if (alias) plan.repoint.push({ id: alias.id, email });
    else plan.create.push(email);
  }
  return plan;
}
