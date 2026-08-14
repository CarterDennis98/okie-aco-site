import "server-only";

import type { Adapter, AdapterSession, AdapterUser } from "next-auth/adapters";
import { prisma } from "@/db/client";

/**
 * Auth.js adapter over our Prisma client.
 *
 * Written by hand rather than using `@auth/prisma-adapter`, for three reasons that all
 * come from this schema being deliberately unlike the one that adapter assumes:
 *
 *   1. `PrismaAdapter` is typed against `PrismaClient` from `@prisma/client`. Prisma 7's
 *      `prisma-client` generator emits into `src/generated/prisma`, so passing our
 *      client needs a cast that would silently swallow a real schema drift later.
 *   2. We never request the `email` scope, so `User.email` is genuinely null. The
 *      adapter contract types it as a required string, and the usual workaround is to
 *      fabricate an address -- putting something that looks like PII into a column that
 *      has none.
 *   3. `User.discordUserId` is the foreign key everything else hangs off. Writing it at
 *      createUser time is the only way it is never briefly null.
 *
 * The surface here is exactly what a single OAuth provider with database sessions
 * calls. Verified against @auth/core's handle-login flow, not assumed:
 * `getUserByEmail` is only reached via `profile.email ? ... : null`, and verification
 * tokens are email-provider only. Both are therefore absent or inert below.
 */

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  discordUserId: true,
} as const;

type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  emailVerified: Date | null;
  image: string | null;
  discordUserId: string | null;
};

/**
 * `AdapterUser.email` is typed as a required string but ours is null by design. The
 * cast is confined to this one function so the untruth has exactly one home; nothing in
 * the app reads it, and Auth.js only branches on it in the email-linking path, which a
 * single OAuth provider never enters.
 */
function toAdapterUser(row: UserRow): AdapterUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email as unknown as string,
    emailVerified: row.emailVerified,
    image: row.image,
    discordUserId: row.discordUserId,
  };
}

function toAdapterSession(row: {
  sessionToken: string;
  userId: string;
  expires: Date;
}): AdapterSession {
  return { sessionToken: row.sessionToken, userId: row.userId, expires: row.expires };
}

export const prismaAdapter: Adapter = {
  async createUser(user) {
    // NOTE: User.discordUserId is a foreign key to DiscordMember. The signIn callback
    // upserts that row from the guild-member lookup BEFORE this runs, and Auth.js
    // guarantees that ordering (handleAuthorized precedes handleLoginOrRegister). If
    // the callback ever stops upserting, this insert starts failing on the FK -- which
    // is the loud failure we want, not a null key.
    const row = await prisma.user.create({
      data: {
        name: user.name,
        image: user.image,
        email: null,
        discordUserId: user.discordUserId ?? null,
        lastLoginAt: new Date(),
      },
      select: USER_SELECT,
    });
    return toAdapterUser(row);
  },

  async getUser(id) {
    const row = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    return row ? toAdapterUser(row) : null;
  },

  /**
   * Always null. We hold no email addresses, so there is nothing to look one up by --
   * and returning a match here is how Auth.js decides to merge two provider accounts
   * onto one user. With a single provider there is nothing legitimate to merge.
   */
  async getUserByEmail() {
    return null;
  },

  async getUserByAccount({ provider, providerAccountId }) {
    const account = await prisma.account.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      select: { user: { select: USER_SELECT } },
    });
    return account ? toAdapterUser(account.user) : null;
  },

  async updateUser(user) {
    const row = await prisma.user.update({
      where: { id: user.id },
      // Name and avatar are refreshed from Discord on each sign-in; email and
      // discordUserId are deliberately not updatable through this path.
      data: {
        ...(user.name !== undefined ? { name: user.name } : {}),
        ...(user.image !== undefined ? { image: user.image } : {}),
        lastLoginAt: new Date(),
      },
      select: USER_SELECT,
    });
    return toAdapterUser(row);
  },

  async deleteUser(userId) {
    // Accounts and sessions cascade.
    await prisma.user.deleteMany({ where: { id: userId } });
  },

  async linkAccount(account) {
    // Tokens are deliberately NOT stored. We never call Discord as the user -- the bot
    // holds its own token for anything guild-related -- so keeping a live credential
    // would be pure liability. The columns stay in the schema because Auth.js's shape
    // expects them; they simply stay null.
    await prisma.account.create({
      data: {
        userId: account.userId,
        type: account.type,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        scope: account.scope ?? null,
      },
    });
    return account;
  },

  async unlinkAccount({ provider, providerAccountId }) {
    await prisma.account.deleteMany({ where: { provider, providerAccountId } });
  },

  async createSession(session) {
    const row = await prisma.session.create({
      data: {
        sessionToken: session.sessionToken,
        userId: session.userId,
        expires: session.expires,
      },
      select: { sessionToken: true, userId: true, expires: true },
    });
    return toAdapterSession(row);
  },

  async getSessionAndUser(sessionToken) {
    const row = await prisma.session.findUnique({
      where: { sessionToken },
      select: {
        sessionToken: true,
        userId: true,
        expires: true,
        user: { select: USER_SELECT },
      },
    });
    if (!row) return null;
    return { session: toAdapterSession(row), user: toAdapterUser(row.user) };
  },

  async updateSession(session) {
    // deleteSession may have already removed it (sign-out racing a request), so this
    // must tolerate a miss rather than throw P2025 into a page render.
    const rows = await prisma.session.updateManyAndReturn({
      where: { sessionToken: session.sessionToken },
      data: { ...(session.expires ? { expires: session.expires } : {}) },
      select: { sessionToken: true, userId: true, expires: true },
    });
    return rows[0] ? toAdapterSession(rows[0]) : null;
  },

  async deleteSession(sessionToken) {
    // deleteMany, not delete: signing out twice must not 500.
    await prisma.session.deleteMany({ where: { sessionToken } });
  },
};
