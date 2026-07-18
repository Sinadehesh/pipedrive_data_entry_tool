import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { stripe } from '@/lib/stripe';

const bodySchema = z.object({
  // CUMULATIVE verified active-walking minutes since session end, as reported
  // by the health integration. Cumulative (not delta) so replays are harmless.
  completedWalkingMinutes: z.number().int().min(0),
  source: z.enum(['health_connect', 'healthkit']),
});

/**
 * POST /api/redemptions/:taskId/sync
 * Pushed by the Android companion app (Health Connect is on-device only,
 * so nothing server-side can poll it).
 * When the walking goal is met before the deadline, the purgatory hold is
 * CANCELLED — the user gets their 80% back. Sweat equity, settled.
 */
export async function POST(req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  // TODO(auth): verify DEVICE_API_SECRET header.
  const { taskId } = await ctx.params;
  const body = bodySchema.parse(await req.json());

  const task = await prisma.redemptionTask.findUniqueOrThrow({
    where: { id: taskId },
    include: { session: true },
  });
  if (task.status !== 'PENDING') {
    return NextResponse.json({ status: task.status, changed: false });
  }

  const completed = Math.max(task.completedWalkingMinutes, body.completedWalkingMinutes);
  const goalMet = completed >= task.requiredWalkingMinutes;
  const inTime = new Date() <= task.deadline;

  if (goalMet && inTime) {
    await stripe.paymentIntents.cancel(task.session.stripePurgatoryPaymentIntentId!);
    await prisma.$transaction([
      prisma.redemptionTask.update({
        where: { id: taskId },
        data: {
          completedWalkingMinutes: completed,
          lastHealthSyncAt: new Date(),
          healthSource: body.source,
          status: 'SUCCESS',
        },
      }),
      prisma.session.update({
        where: { id: task.sessionId },
        data: { status: 'RELEASED' },
      }),
    ]);
    return NextResponse.json({ status: 'SUCCESS', changed: true });
  }

  await prisma.redemptionTask.update({
    where: { id: taskId },
    data: {
      completedWalkingMinutes: completed,
      lastHealthSyncAt: new Date(),
      healthSource: body.source,
    },
  });

  return NextResponse.json({
    status: 'PENDING',
    completedWalkingMinutes: completed,
    requiredWalkingMinutes: task.requiredWalkingMinutes,
  });
}
