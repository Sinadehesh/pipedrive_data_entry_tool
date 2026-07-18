import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { stripe } from '@/lib/stripe';
import {
  REDEMPTION_WINDOW_HOURS,
  requiredWalkingMinutes,
  splitPenalty,
} from '@/lib/penalty';

/**
 * POST /api/sessions/:sessionId/end
 * The financial moment. Called when the vice app leaves the foreground for
 * good (or the cap forces closure).
 *
 * Stripe reality check: ONE PaymentIntent cannot capture 20% and keep 80%
 * on hold — partial capture auto-releases the remainder. So we create TWO
 * off-session PaymentIntents against the saved card:
 *
 *   1. burn PI       — 20%, capture_method: automatic → charged immediately.
 *   2. purgatory PI  — 80%, capture_method: manual    → pre-auth hold.
 *      Cancelled if the walk is completed in 24h; captured by the expiry
 *      job if not. (Auth holds live 7 days on most cards, so 24h is safe.)
 */
export async function POST(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;

  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: { user: true },
  });
  if (session.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'session_not_active' }, { status: 409 });
  }

  const endTime = new Date();

  // Below Stripe's €0.50 minimum there is nothing chargeable — close free.
  if (session.totalPenaltyCents < 50) {
    await prisma.session.update({
      where: { id: sessionId },
      data: { endTime, status: 'RELEASED' },
    });
    return NextResponse.json({ status: 'RELEASED', totalPenaltyCents: 0 });
  }

  const { burnCents, purgatoryCents } = splitPenalty(session.totalPenaltyCents);
  const { user } = session;

  const common = {
    customer: user.stripeCustomerId!,
    payment_method: user.stripePaymentMethodId!,
    currency: user.currency,
    off_session: true as const,
    confirm: true,
    metadata: { sessionId, userId: user.id },
  };

  // TODO(hardening): off-session confirms can fail with authentication_required
  // (SCA) or card_declined. Persist the failure on the session and surface a
  // "settle up" flow in the dashboard instead of throwing.
  const burnIntent = await stripe.paymentIntents.create(
    { ...common, amount: burnCents, capture_method: 'automatic' },
    { idempotencyKey: `burn_${sessionId}` },
  );
  const purgatoryIntent = await stripe.paymentIntents.create(
    { ...common, amount: purgatoryCents, capture_method: 'manual' },
    { idempotencyKey: `purgatory_${sessionId}` },
  );

  const deadline = new Date(endTime.getTime() + REDEMPTION_WINDOW_HOURS * 3600_000);

  const updated = await prisma.session.update({
    where: { id: sessionId },
    data: {
      endTime,
      status: 'HOLD',
      burnCents,
      purgatoryCents,
      stripeBurnPaymentIntentId: burnIntent.id,
      stripePurgatoryPaymentIntentId: purgatoryIntent.id,
      redemption: {
        create: {
          requiredWalkingMinutes: requiredWalkingMinutes(session.totalActiveSeconds),
          deadline,
        },
      },
    },
    include: { redemption: true },
  });

  return NextResponse.json({
    status: updated.status,
    totalPenaltyCents: updated.totalPenaltyCents,
    burnCents,
    purgatoryCents,
    redemption: updated.redemption,
  });
}
