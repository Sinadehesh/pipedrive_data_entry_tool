import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';

const bodySchema = z.object({
  userId: z.string(),
  appPackage: z.string().min(1), // e.g. "com.zhiliaoapp.musically"
});

/**
 * POST /api/sessions/start
 * Called by the Android companion service the moment a blocked app hits the
 * foreground. Refuses to arm if the user has no saved payment method —
 * a meter that can't charge is theater, and theater doesn't change behavior.
 */
export async function POST(req: Request) {
  // TODO(auth): verify DEVICE_API_SECRET header from the companion service.
  const body = bodySchema.parse(await req.json());

  const user = await prisma.user.findUniqueOrThrow({ where: { id: body.userId } });
  if (!user.stripePaymentMethodId) {
    return NextResponse.json({ error: 'no_payment_method' }, { status: 409 });
  }

  const existing = await prisma.session.findFirst({
    where: { userId: body.userId, status: 'ACTIVE' },
  });
  if (existing) return NextResponse.json({ sessionId: existing.id, resumed: true });

  const session = await prisma.session.create({
    data: {
      userId: body.userId,
      appPackage: body.appPackage,
      lastScrollEventAt: new Date(),
    },
  });

  return NextResponse.json({ sessionId: session.id, resumed: false });
}
