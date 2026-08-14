import "server-only";

import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";
import { prisma } from "@/db/client";
import { prismaAdapter } from "@/lib/auth/adapter";

/**
 * Discord sign-in.
 *
 * Two things here are security decisions rather than configuration:
 *
 *   - **Scopes are `identify guilds.members.read`, explicitly.** The built-in Discord
 *     provider defaults to `identify email`. Email is the only real-world-linkable PII
 *     this system could hold and there is no use for it -- the bot already DMs bills --
 *     so the override is what keeps it out. `guilds.members.read` returns the member
 *     object for ONE guild; the broader `guilds` scope would expose every server the
 *     person is in, which is none of our business.
 *
 *   - **Membership is checked before any row is written.** Auth.js runs the signIn
 *     callback (handleAuthorized) strictly before user creation (handleLoginOrRegister),
 *     so a stranger clicking "sign in" leaves nothing behind but a log line.
 */

const DISCORD_API = "https://discord.com/api/v10";
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const OG_ROLE_ID = process.env.DISCORD_OG_ROLE_ID;

/** 30 days. Long enough not to nag, short enough that a stale session ages out. */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

type DiscordProfile = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

type GuildMember = {
  roles?: string[];
  joined_at?: string;
  nick?: string | null;
};

type MembershipResult =
  | { kind: "member"; member: GuildMember }
  | { kind: "not-a-member" }
  | { kind: "error"; status: number };

/**
 * The 404 from this endpoint IS the membership check -- that is the whole reason for
 * the `guilds.members.read` scope. A non-404 failure is deliberately NOT treated as
 * "not a member": a Discord outage must read as a transient error, not as an
 * accusation that a paying member was thrown out.
 */
async function fetchGuildMembership(accessToken: string): Promise<MembershipResult> {
  if (!GUILD_ID) throw new Error("DISCORD_GUILD_ID is not set; refusing to authenticate.");

  const response = await fetch(`${DISCORD_API}/users/@me/guilds/${GUILD_ID}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    // pg and Discord both default to no timeout. Without this a hung request holds the
    // OAuth callback open until the platform kills it.
    signal: AbortSignal.timeout(8_000),
  });

  if (response.status === 404) return { kind: "not-a-member" };
  if (!response.ok) return { kind: "error", status: response.status };
  return { kind: "member", member: (await response.json()) as GuildMember };
}

/**
 * Refresh the canonical member record from what we just learned.
 *
 * This is why OG status is correct the moment someone logs in, without waiting on the
 * bot's role sync. It is also load-bearing for the adapter: `User.discordUserId` is a
 * foreign key to this table, so the row has to exist before createUser runs.
 */
async function syncDiscordMember(profile: DiscordProfile, member: GuildMember) {
  const roles = member.roles ?? [];
  // If the OG role isn't configured, leave isOg alone rather than silently demoting
  // every OG member to false on their next login.
  const ogPatch = OG_ROLE_ID ? { isOg: roles.includes(OG_ROLE_ID) } : {};
  const joinedAt = member.joined_at ? new Date(member.joined_at) : undefined;

  await prisma.discordMember.upsert({
    where: { discordUserId: profile.id },
    create: {
      discordUserId: profile.id,
      username: profile.username,
      globalName: profile.global_name ?? null,
      avatarHash: profile.avatar ?? null,
      roles,
      isOg: OG_ROLE_ID ? roles.includes(OG_ROLE_ID) : false,
      joinedAt,
      leftAt: null,
    },
    update: {
      username: profile.username,
      globalName: profile.global_name ?? null,
      avatarHash: profile.avatar ?? null,
      roles,
      ...ogPatch,
      ...(joinedAt ? { joinedAt } : {}),
      // Signing in proves present membership, so clear any stale departure stamp.
      leftAt: null,
      syncedAt: new Date(),
    },
  });
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: prismaAdapter,
  session: { strategy: "database", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/signin", error: "/signin" },

  providers: [
    Discord({
      clientId: process.env.AUTH_DISCORD_ID,
      clientSecret: process.env.AUTH_DISCORD_SECRET,
      authorization: { params: { scope: "identify guilds.members.read" } },

      profile(profile: DiscordProfile) {
        const avatar = profile.avatar
          ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.${
              profile.avatar.startsWith("a_") ? "gif" : "png"
            }`
          : null;

        return {
          id: profile.id,
          name: profile.global_name ?? profile.username,
          image: avatar,
          // Never populated: the email scope is not requested. Stated explicitly so a
          // future provider tweak can't quietly start collecting one.
          email: null as unknown as string,
          // Spread into createUser by Auth.js, which is how it reaches the column.
          discordUserId: profile.id,
        };
      },
    }),
  ],

  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== "discord" || !account.access_token) return false;

      const discord = profile as DiscordProfile | undefined;
      if (!discord?.id) return false;

      const result = await fetchGuildMembership(account.access_token);

      // A string return redirects instead of creating a session, so nothing is
      // persisted for someone who isn't in the guild.
      if (result.kind === "not-a-member") return "/not-a-member";
      if (result.kind === "error") {
        throw new Error(`Discord guild lookup failed with ${result.status}`);
      }

      await syncDiscordMember(discord, result.member);
      return true;
    },

    async session({ session, user }) {
      // Identity only. See src/types/next-auth.d.ts for why roles never live here.
      session.user.discordUserId = user.discordUserId ?? null;
      return session;
    },
  },
});
