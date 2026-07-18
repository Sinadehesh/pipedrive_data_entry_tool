import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { stripe } from '@/lib/stripe';
import { hourlyWageCents, penaltyRateCentsPerMin } from '@/lib/penalty';

const bodySchema = z.object({
  email: z.string().email(),
  monthlyIncomeCents: z.number().int().positive(),
  anchorItem: z.string().min(1),
  anchorPriceCents: z.number().int().positive(),
  sessionCapCents: z.number().int().positive().max(10000).optional(),
});

/**
 * POST /api/onboarding
 * Creates the user, derives the income-indexed penalty rate, and creates the
 * Stripe customer. The client then calls /api/stripe/setup-intent to save a
 * card — without a saved payment method the meter must refuse to arm.
 */
export async function POST(req: Request) {
  // TODO(auth): replace email-in-body with a real session once auth lands.
  const body = bodySchema.parse(await req.json());

  const customer = await stripe.customers.create({ email: body.email });

  const user = await prisma.user.create({
    data: {
      email: body.email,
      monthlyIncomeCents: body.monthlyIncomeCents,
      hourlyWageCents: hourlyWageCents(body.monthlyIncomeCents),
      penaltyRateCentsPerMin: penaltyRateCentsPerMin(body.monthlyIncomeCents),
      anchorItem: body.anchorItem,
      anchorPriceCents: body.anchorPriceCents,
      sessionCapCents: body.sessionCapCents ?? 3000,
      stripeCustomerId: customer.id,
    },
  });

  return NextResponse.json({
    userId: user.id,
    penaltyRateCentsPerMin: user.penaltyRateCentsPerMin,
  });
}
