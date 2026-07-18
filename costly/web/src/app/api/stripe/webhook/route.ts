import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { stripe } from '@/lib/stripe';

/**
 * POST /api/stripe/webhook
 * Reconciliation backstop. The API routes drive state optimistically; this
 * handler makes the DB agree with what Stripe actually did, and it is the
 * only writer for saved payment methods (setup_intent.succeeded).
 *
 * Events to enable in the Stripe dashboard:
 *   setup_intent.succeeded, payment_intent.succeeded,
 *   payment_intent.canceled, payment_intent.payment_failed
 */
export async function POST(req: Request) {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'no_signature' }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      await req.text(),
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  // Idempotency: first delivery wins, retries no-op.
  try {
    await prisma.webhookEvent.create({ data: { id: event.id, type: event.type } });
  } catch {
    return NextResponse.json({ received: true, duplicate: true });
  }

  switch (event.type) {
    case 'setup_intent.succeeded': {
      const si = event.data.object;
      const userId = si.metadata?.userId;
      if (userId && typeof si.payment_method === 'string') {
        await prisma.user.update({
          where: { id: userId },
          data: { stripePaymentMethodId: si.payment_method },
        });
      }
      break;
    }
    case 'payment_intent.canceled': {
      // Purgatory hold released — make sure the session says so.
      const pi = event.data.object;
      await prisma.session.updateMany({
        where: { stripePurgatoryPaymentIntentId: pi.id, status: 'HOLD' },
        data: { status: 'RELEASED' },
      });
      break;
    }
    case 'payment_intent.succeeded': {
      // Purgatory capture confirmed (burn captures also land here; the
      // updateMany filter scopes to purgatory intents only).
      const pi = event.data.object;
      await prisma.session.updateMany({
        where: { stripePurgatoryPaymentIntentId: pi.id, status: 'HOLD' },
        data: { status: 'CAPTURED' },
      });
      break;
    }
    case 'payment_intent.payment_failed': {
      // TODO(hardening): flag the session for a manual "settle up" flow and
      // disarm the meter until the user has a working payment method again.
      const pi = event.data.object;
      console.error(`payment failed for intent ${pi.id}`, pi.last_payment_error?.code);
      break;
    }
  }

  return NextResponse.json({ received: true });
}
