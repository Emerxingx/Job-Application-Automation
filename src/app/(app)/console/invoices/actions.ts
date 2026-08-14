'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { UnauthorizedError } from '@/lib/auth';
import { StaffAccessError, requireStaff } from '@/lib/crm/auth';
import { logActivity } from '@/lib/crm/activities';
import { InvoiceStateError, markInvoicePaid } from '@/lib/billing/invoice';

/**
 * Staff-initiated billing actions.
 *
 * A Server Action is a POST endpoint wearing a function's clothes. It does NOT
 * inherit the layout's staff gate — layouts do not run for actions — so the
 * check is repeated here, and at the higher `billing_ops` rung, because this
 * writes to the ledger rather than reading from it.
 */

const markPaidSchema = z.object({
  invoiceId: z.string().trim().min(1).max(40),
  /**
   * Required, not optional. Recording money that never touched a gateway is
   * exactly the action an auditor asks about six months later, and "who did it"
   * without "why" is half an answer. Twelve characters is enough to force a
   * sentence and short enough not to be an obstacle.
   */
  reason: z
    .string()
    .trim()
    .min(12, 'Say why this is being settled by hand — a cheque number, a ticket, an agreement.')
    .max(500),
});

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Settle an open invoice outside the payment gateway.
 *
 * The heavy lifting is `markInvoicePaid`, which is where the invariants live:
 * it refuses a draft (nothing numbered to receipt against), refuses a void
 * (not a receivable), is idempotent on an invoice already paid, and — because
 * `Invoice.amountPaidCents` is a cache over `PaymentAllocation` — writes a real
 * `Payment` row and its allocation rather than nudging the cached total. This
 * function's job is authorization, provenance and the audit trail.
 */
export async function markInvoicePaidAction(input: {
  invoiceId: string;
  reason: string;
}): Promise<ActionResult> {
  let staff;
  try {
    staff = await requireStaff('billing_ops');
  } catch (error) {
    if (error instanceof StaffAccessError) return { ok: false, message: error.message };
    if (error instanceof UnauthorizedError) {
      return { ok: false, message: 'Your session has expired. Sign in again.' };
    }
    throw error;
  }

  const parsed = markPaidSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  }
  const { invoiceId, reason } = parsed.data;

  const before = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      number: true,
      userId: true,
      status: true,
      currency: true,
      totalCents: true,
      amountDueCents: true,
    },
  });
  if (!before) return { ok: false, message: 'That invoice no longer exists.' };
  if (before.status === 'paid') {
    return { ok: true, message: `${before.number ?? 'This invoice'} was already settled.` };
  }

  const settledCents = before.amountDueCents;

  try {
    await markInvoicePaid(invoiceId, {
      // Forced to "manual" rather than inherited from the invoice. An invoice
      // raised for Stripe collection that a person settles by hand did not
      // become a Stripe payment, and labelling it as one makes reconciliation
      // against the gateway's statement impossible.
      provider: 'manual',
      method: 'manual_adjustment',
      description: `Settled in the console by ${staff.email}: ${reason}`,
    });
  } catch (error) {
    // These carry the reason the transition is illegal, written for a person.
    if (error instanceof InvoiceStateError) return { ok: false, message: error.message };
    if (error instanceof Error) return { ok: false, message: error.message };
    return { ok: false, message: 'The invoice could not be settled.' };
  }

  const after = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { status: true, amountPaidCents: true, amountDueCents: true },
  });

  await db.auditLog.create({
    data: {
      actorType: 'staff',
      actorId: staff.id,
      actorEmail: staff.email,
      actorRole: staff.role,
      action: 'invoice.mark_paid',
      entityType: 'Invoice',
      entityId: invoiceId,
      summary: `${staff.email} settled ${before.number ?? invoiceId} by hand for ${(settledCents / 100).toFixed(2)} ${before.currency}`,
      before: JSON.stringify({ status: before.status, amountDueCents: before.amountDueCents }),
      after: JSON.stringify({
        status: after?.status ?? 'unknown',
        amountDueCents: after?.amountDueCents ?? 0,
      }),
      changedFields: JSON.stringify(['status', 'amountPaidCents', 'amountDueCents']),
      reason,
    },
  });

  // Also onto the customer's own timeline, so the next person to open the
  // account sees it where they are already looking rather than in a log.
  await logActivity({
    userId: before.userId,
    staff,
    type: 'billing',
    direction: 'internal',
    subject: `Invoice ${before.number ?? invoiceId} marked paid manually`,
    body: reason,
    relatedInvoiceId: invoiceId,
    meta: { amountCents: settledCents, currency: before.currency },
  });

  revalidatePath('/console/invoices');
  revalidatePath(`/console/customers/${before.userId}`);
  revalidatePath('/console');

  return {
    ok: true,
    message: `${before.number ?? 'Invoice'} settled for ${(settledCents / 100).toFixed(2)} ${before.currency}.`,
  };
}
