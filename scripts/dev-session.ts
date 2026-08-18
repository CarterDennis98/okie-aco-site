/**
 * Mint a signed-in session against the LOCAL database, for testing pages with curl.
 *
 *   npx tsx --conditions=react-server scripts/dev-session.ts <discordUserId>
 *   curl -H "Cookie: authjs.session-token=<token>" http://localhost:3000/dashboard
 *
 * REFUSES to run against anything but localhost. This mints a valid login for an
 * arbitrary member without going through Discord; pointed at production it would be a
 * back door, so the check is on the connection string rather than on remembering.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`Refusing to run: DATABASE_URL points at "${host || "an unparseable host"}".`);
  console.error("This mints a login without authentication and is local-only.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main() {
  const discordUserId = process.argv[2];
  if (!/^\d{15,25}$/.test(discordUserId ?? "")) {
    throw new Error("Pass a Discord user id.");
  }

  const member = await prisma.discordMember.findUnique({ where: { discordUserId } });
  if (!member) throw new Error(`No discord_members row for ${discordUserId}.`);

  const user =
    (await prisma.user.findFirst({ where: { discordUserId } })) ??
    (await prisma.user.create({ data: { discordUserId, name: member.username } }));

  const sessionToken = randomUUID();
  await prisma.session.create({
    data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 3_600_000) },
  });

  console.log(sessionToken);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
