/**
 * Stage 15 - the billing profile, wired (ADR-0010 said `BillingProfile`
 * existed unused). One per user; created from the account the first time
 * money is about to move, so a checkout always has a presentment currency
 * and a tax region to reason from. The currency is frozen once set: a
 * customer is not silently moved between CAD and USD.
 */
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

type Client = Prisma.TransactionClient | typeof db;

export function currencyForCountry(country: string): 'CAD' | 'USD' {
  return country === 'US' ? 'USD' : 'CAD';
}

export interface BillingProfileView {
  id: string;
  legalName: string;
  billingEmail: string;
  country: string;
  region: string;
  currency: string;
  provider: string;
  taxExempt: boolean;
  externalCustomerId: string | null;
}

/** Find or create the user's billing profile. Never overwrites an existing one. */
export async function ensureBillingProfile(client: Client, user: { id: string; email: string; fullName: string; country: string; city?: string | null }): Promise<BillingProfileView> {
  const existing = await client.billingProfile.findUnique({ where: { userId: user.id } });
  const row =
    existing ??
    (await client.billingProfile.create({
      data: {
        userId: user.id,
        legalName: user.fullName || user.email,
        billingEmail: user.email,
        city: user.city ?? '',
        country: user.country === 'US' ? 'US' : 'CA',
        currency: currencyForCountry(user.country),
      },
    }));
  return { id: row.id, legalName: row.legalName, billingEmail: row.billingEmail, country: row.country, region: row.region, currency: row.currency, provider: row.provider, taxExempt: row.taxExempt, externalCustomerId: row.externalCustomerId };
}
