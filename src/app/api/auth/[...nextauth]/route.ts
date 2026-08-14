import { handlers } from "@/lib/auth";

/**
 * Auth.js OAuth endpoints: /api/auth/signin, /callback/discord, /signout, /session.
 *
 * The Discord application's redirect URI must be `<origin>/api/auth/callback/discord`.
 * Register both the localhost and production forms on the same application.
 */
export const { GET, POST } = handlers;
