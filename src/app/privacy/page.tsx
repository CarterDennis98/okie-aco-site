import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Okie ACO stores, how it is protected, and what it never collects.",
};

/**
 * DRAFT — describes what the system actually does, not a template. Every claim is
 * checkable against the code:
 *
 *   "no email"            src/lib/auth/index.ts requests `identify guilds.members.read`
 *   "no OAuth tokens"     src/lib/auth/adapter.ts linkAccount, covered by adapter.test.ts
 *   "secrets encrypted"   src/lib/vault/crypto.ts, AES-256-GCM per field
 *   "cards never shown"   no read path for card_number_enc / card_cvv_enc outside the export
 *   "reveals are logged"  vault_reveals table, written before the decrypt
 *   "exports are logged"  vault_exports table
 *   "feed is delayed"     FEED_DELAY_MS in src/db/queries/public.ts
 *   "feed is anonymous"   getPublicFeed selects no member-identifying column
 *
 * The vault section below replaced a flat "we never store card numbers", which stopped
 * being true the moment profile storage shipped. If what is stored changes again, this
 * page changes with it -- a privacy policy that lags the schema is worse than none.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" lastUpdated="14 August 2026">
      <p>
        Okie ACO is a small, Oklahoma-run Discord community. This page describes exactly what the
        website and the Discord bot store about you, how it is protected, and what they deliberately
        do not collect.
      </p>

      <h2>What we collect when you sign in</h2>
      <p>
        Signing in uses Discord&rsquo;s OAuth with two permissions and no others:{" "}
        <strong>identify</strong>, and <strong>guilds.members.read</strong> scoped to the Okie ACO
        server alone. From those we store your Discord user ID, username, display name, avatar, your
        roles in this server, and when you joined it.
      </p>
      <p>
        <strong>We do not request or store your email address for sign-in.</strong> We also do not
        request the list of other servers you are in — the permission we use returns your membership
        in this one server only. Discord issues an access token during sign-in; we discard it rather
        than saving it, because nothing here ever acts on Discord as you.
      </p>

      <h2>Your checkout profiles and accounts</h2>
      <p>
        If you use the profile manager, we store what a checkout needs: your retailer account email
        and password, your name and phone number, your shipping and billing addresses, and your card
        number, expiry date, and security code. You choose to put this here so that drops can run
        without you sending details over again each time.
      </p>
      <p>
        <strong>
          Card numbers, security codes, and account passwords are encrypted before they reach the
          database
        </strong>
        , each with its own AES-256-GCM envelope. The key is held separately from the data and is
        never stored alongside it, so a copy of the database on its own is unreadable.
      </p>
      <p>
        <strong>Card numbers and security codes are never shown back to you.</strong> Once saved,
        they can be replaced but not displayed again — not on your own page, and not on the staff
        page either. What anyone sees is the card brand, the last four digits, and the expiry. The
        only time those values are decrypted is when they are loaded into the checkout bots, and
        every one of those exports is logged with who ran it, when, and how many records it covered.
      </p>
      <p>
        <strong>Email app passwords are the one exception.</strong> You can reveal your own, and
        staff can reveal yours, because an app password is issued by your email provider for a
        single application and you can revoke it at any time from your provider&rsquo;s account
        settings — which is not true of a card number. Nothing is decrypted until someone clicks to
        reveal it, and each reveal is recorded with who did it, whose password it was, and when.
      </p>
      <p>
        Being straight about the limit: this data has to be decryptable, because the bots need it to
        check out for you. Encryption protects you against a stolen copy of the database. It does
        not protect against someone who compromises the running service itself. If you would rather
        not have card details stored, you can use the profile manager for everything else and give
        Okie staff the card another way.
      </p>
      <p>
        Your card details are never sold, shared, or sent anywhere except the retailer&rsquo;s own
        checkout. We are not a payment processor and we never charge your card — the retailer does,
        and our fee is billed separately.
      </p>

      <h2>Email app passwords</h2>
      <p>
        If you add an app password for your email, it is encrypted the same way and used for one
        purpose: reading the verification codes retailers send during a checkout, so nobody has to
        chase you for a code mid-drop. An app password is separate from your real password and you
        can revoke it at any time from your email provider, without changing anything else about
        your account.
      </p>

      <h2>What we collect when you check out</h2>
      <p>
        When a bot checks out on your behalf we record the product, quantity, retailer, time, and
        the checkout profile the order was placed under. Those records are linked to your Discord
        account so your dashboard can show them.
      </p>

      <h2>Billing records</h2>
      <p>
        For each billing run we keep the itemized fees, the total, any discount applied, and the
        exact text of the message sent to you. That message text is kept specifically so the website
        and your DMs can never disagree about what you were asked to pay.
      </p>

      <h2>The public feed</h2>
      <p>
        The home page shows recent checkouts to anyone, including people who are not members. Those
        entries are <strong>anonymous</strong> — the query behind them selects no name, no profile,
        and no Discord ID, so there is nothing there to attribute to you. They are also delayed by
        30 minutes, and never show fees or dollar amounts.
      </p>
      <p>
        If you would rather your checkouts were excluded from the public feed entirely, message Okie
        staff on Discord and we&rsquo;ll switch it off for your account.
      </p>

      <h2>Cookies</h2>
      <p>
        One cookie, holding your session. It exists so you stay signed in and is deleted when you
        sign out. No analytics, no advertising, no third-party trackers.
      </p>

      <h2>Who else sees this</h2>
      <p>
        Nobody outside Okie ACO. Your data is not sold, rented, or shared with third parties. It
        lives in a private database we run on Google Cloud. Okie staff can see your profile details
        in order to run drops and fix problems, and can export them into the checkout bots — but not
        the card numbers, security codes, or passwords, which stay unreadable in the interface and
        are logged whenever they are exported.
      </p>

      <h2>Changing and deleting</h2>
      <p>
        You can edit or delete any profile or account from the profile manager at any time, and
        deleting one removes its stored secrets with it. To have your whole account and its data
        deleted, message Okie staff on Discord. Checkout and billing records are kept as long as
        Okie ACO runs, because they are the record of what you were charged, and records for fees
        already paid may be retained as proof of the transaction.
      </p>

      <h2>Changes</h2>
      <p>
        If this page changes in a way that affects what is collected or how it is protected, it will
        be announced in the Discord server rather than quietly edited.
      </p>
    </LegalPage>
  );
}
