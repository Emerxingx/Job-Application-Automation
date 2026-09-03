import { LegalDocument } from '../legal-document';
import { CONSENT_VERSIONS } from '@/lib/consent';

export const metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      version={CONSENT_VERSIONS.privacy_policy}
      summary="This policy will describe what personal information JobPilot AI collects, where it is stored (Canada, by default), which service providers process it and for what purpose, how long it is kept, and how you can access, correct or delete it."
    />
  );
}
