import { LegalLayout, LegalSection } from '../components/LegalLayout';

export default function Privacy() {
  return (
    <LegalLayout title="Privacy Policy" updated="July 31, 2026">
      <LegalSection title="1. What we collect">
        <p>When you use AutoCliper, we store:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Your email, name and password (passwords are stored hashed — we never see them).</li>
          <li>Clip job details: the video links you paste, clip settings, and job status.</li>
          <li>Credit and payment records (plan, packs, credit balance and usage).</li>
          <li>
            If you choose to upload a cookies file to access age- or region-locked videos, we
            store it securely and use it only to download those videos for you.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="2. How we use it">
        <p>
          Only to run the service: generating your clips, managing your credits and billing,
          keeping you signed in, and helping you when you contact support. That&apos;s it.
        </p>
      </LegalSection>

      <LegalSection title="3. What we never do">
        <p>
          We do not sell your data. We do not show ads. We do not read your clips for anything
          other than making and delivering them to you.
        </p>
      </LegalSection>

      <LegalSection title="4. Storage & security">
        <p>
          Finished clips are stored temporarily and expire automatically. Passwords are hashed,
          sessions use secure cookies, and access to production data is restricted. No system is
          100% secure, but we follow standard best practices to protect your information.
        </p>
      </LegalSection>

      <LegalSection title="5. Third parties">
        <p>
          To provide the service we interact with: the video platforms you clip from (YouTube,
          Kick, Twitch, Google Drive, Dropbox), our hosting and storage providers, and payment
          providers when you buy credits. Each receives only what is needed to do its job.
        </p>
      </LegalSection>

      <LegalSection title="6. Cookies">
        <p>
          We use one essential session cookie to keep you signed in. No tracking or advertising
          cookies.
        </p>
      </LegalSection>

      <LegalSection title="7. Your choices">
        <p>
          You can ask us anytime to show you the data we hold about you, correct it, or delete
          your account and its data. Email us and we will handle it within a reasonable time.
        </p>
      </LegalSection>

      <LegalSection title="8. Changes to this policy">
        <p>
          If this policy changes in an important way, we will update this page and the date
          above.
        </p>
      </LegalSection>

      <LegalSection title="9. Contact">
        <p>
          Privacy questions? Email <a href="mailto:support@autocliper.com" className="text-[#D1FE17] hover:underline">support@autocliper.com</a>.
        </p>
      </LegalSection>
    </LegalLayout>
  );
}
