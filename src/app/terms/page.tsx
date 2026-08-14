import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms for using Okie ACO's checkout service.",
};

/**
 * DRAFT — describes how the service actually works today. Not legal advice; the
 * operator should read every line before this ships, particularly the fee, refund, and
 * liability sections, which are the ones that would matter in a dispute.
 */
export default function TermsPage() {
  return (
    <LegalPage title="Terms" lastUpdated="13 August 2026">
      <p>
        Okie ACO runs automated checkout for high-demand collectibles on behalf of its Discord
        members. Using the service means you agree to what follows.
      </p>

      <h2>What the service is</h2>
      <p>
        When a drop goes live, our bots attempt to check out the products you have asked for, using
        your own retailer accounts and your own payment methods. <strong>You are the buyer.</strong>{" "}
        Okie ACO is not a reseller and never takes ownership of the goods — we charge a convenience
        fee per item successfully checked out, and nothing else.
      </p>

      <h2>Fees</h2>
      <ul>
        <li>Fees are charged per unit successfully checked out. Failed attempts cost nothing.</li>
        <li>
          The fee for a drop is set by Okie staff and is stated in the itemized message you receive
          after each drop.
        </li>
        <li>
          Any discount that applies to your account is shown on the itemized message and on the
          charge page, rounded in your favour.
        </li>
        <li>Fees are due when billed. Payment methods are posted in the Discord server.</li>
        <li>
          A fee already billed is never retroactively changed. If a fee is edited, it applies to
          future drops only.
        </li>
      </ul>

      <h2>What we can&rsquo;t promise</h2>
      <p>
        Drops sell out in seconds and retailers actively work against automated checkout.{" "}
        <strong>We cannot guarantee a successful checkout for any drop</strong>, and a failed
        attempt is not a breach of anything. We also can&rsquo;t control what the retailer does
        afterwards — cancellations, order limits, payment declines, restocks, and price changes are
        between you and them.
      </p>
      <p>
        If the retailer cancels an order that we successfully checked out, tell Okie staff and the
        fee for that item will be dropped or refunded.
      </p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Keep enough funds available on the payment method you use for drops.</li>
        <li>Make sure your retailer account details are current.</li>
        <li>
          Don&rsquo;t share your membership, or the server&rsquo;s drop information, with
          non-members.
        </li>
        <li>
          Follow the retailers&rsquo; own terms. What you do with your accounts is your call and
          your risk.
        </li>
      </ul>

      <h2>Membership</h2>
      <p>
        Membership is through the Discord server and can be ended by either side at any time.
        Leaving, or being removed, does not cancel fees already owed for drops you were checked out
        on. Okie staff may remove anyone for abuse, chargebacks, or sharing drop information outside
        the server.
      </p>

      <h2>Liability</h2>
      <p>
        Okie ACO is a small operation run in good faith, not a company with a support department. It
        is provided as-is. To the extent the law allows, Okie ACO is not liable for missed drops,
        cancelled orders, retailer account actions, or any indirect or consequential loss. Where
        liability can&rsquo;t be excluded, it is limited to the fees you paid for the drop in
        question.
      </p>

      <h2>Questions and disputes</h2>
      <p>
        Message Okie staff on Discord. Every charge has a page on this site showing its full
        breakdown and the exact message that was sent to you, which is usually enough to settle a
        question in one look.
      </p>
    </LegalPage>
  );
}
