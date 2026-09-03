import { LegalDocument } from '../legal-document';
import { CONSENT_VERSIONS } from '@/lib/consent';

export const metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <LegalDocument
      title="Terms of Service"
      version={CONSENT_VERSIONS.terms_of_service}
      summary="These terms will govern your use of JobPilot AI: what the service does, what it does not do on your behalf without your explicit instruction, and your responsibilities for the accuracy of the information you provide."
    />
  );
}
