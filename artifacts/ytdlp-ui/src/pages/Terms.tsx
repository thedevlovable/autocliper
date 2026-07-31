import { LegalLayout, LegalSection } from '../components/LegalLayout';

export default function Terms() {
  return (
    <LegalLayout title="Terms of Service" updated="July 31, 2026">
      <LegalSection title="1. What AutoCliper does">
        <p>
          AutoCliper is an AI clipping tool: you paste a link to a long video (YouTube, Kick,
          Twitch, Google Drive or Dropbox), and we automatically find the best moments and cut
          them into short clips formatted for Shorts, Reels and TikTok. Extra tools (downloading,
          trimming, cropping, audio extraction) are part of the same service.
        </p>
      </LegalSection>

      <LegalSection title="2. Your account">
        <p>
          You need an account to generate clips. Keep your login details safe — everything done
          through your account is your responsibility. Provide a real email address so we can
          help you with billing and support. One person, one account: signup bonuses are meant
          for real new users, and we may remove duplicate accounts created to farm free credits.
        </p>
      </LegalSection>

      <LegalSection title="3. Credits & payments">
        <p>
          AutoCliper runs on credits. Generating one clip costs 50 credits; each extra tool run
          also costs 50 credits. New accounts get 150 free credits. Subscription plans add
          credits every month while active, and top-up packs never expire.
        </p>
        <p>
          Credits that have already been spent on completed clips or tool runs are not
          refundable. If a job fails on our side, the held credits are returned to your balance
          automatically. For any billing problem, contact us and we will make it right.
        </p>
      </LegalSection>

      <LegalSection title="4. Fair use — your content, your responsibility">
        <p>
          Only clip videos you own or have permission to use. You are responsible for following
          the terms of the platforms you clip from (YouTube, Kick, Twitch, Google Drive,
          Dropbox) and for how you use the clips afterwards. Do not use AutoCliper for illegal
          content or to infringe anyone&apos;s rights.
        </p>
      </LegalSection>

      <LegalSection title="5. Your clips & storage">
        <p>
          Finished clips are kept temporarily so you can download them — they expire
          automatically after a limited time. Download your clips promptly; expired clips can be
          regenerated (this costs credits again). We may remove content that violates these
          terms.
        </p>
      </LegalSection>

      <LegalSection title="6. Service availability">
        <p>
          We work hard to keep AutoCliper fast and available, but we cannot promise uninterrupted
          service. Source platforms sometimes block or rate-limit downloads — when that happens
          we tell you clearly and your credits for failed jobs are returned. Features and prices
          may change; active subscriptions keep their price until renewal.
        </p>
      </LegalSection>

      <LegalSection title="7. Liability">
        <p>
          AutoCliper is provided &quot;as is&quot;. To the maximum extent permitted by law, we
          are not liable for indirect damages, lost profits, or issues caused by third-party
          platforms. Our total liability is limited to the amount you paid us in the last 3
          months.
        </p>
      </LegalSection>

      <LegalSection title="8. Ending your account">
        <p>
          You can stop using AutoCliper anytime and ask us to delete your account. We may
          suspend accounts that break these terms — where reasonable, we will warn you first.
        </p>
      </LegalSection>

      <LegalSection title="9. Changes to these terms">
        <p>
          If we make important changes, we will update this page and the date above. Continuing
          to use AutoCliper after changes means you accept the new terms.
        </p>
      </LegalSection>

      <LegalSection title="10. Contact">
        <p>
          Questions? Email <a href="mailto:support@autocliper.com" className="text-[#D1FE17] hover:underline">support@autocliper.com</a>.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
