import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { sessionPenaltyCents } from '@/lib/penalty';

const bodySchema = z.object({
  // Seconds of ACTIVE scrolling since the last heartbeat. The device is the
  // source of truth for idle detection: the AccessibilityService only counts
  // seconds backed by TYPE_VIEW_SCROLLED events within the idle window, so a
  // phone left face-up on TikTok while its owner sleeps reports 0.
  activeSecondsDelta: z.number().int().min(0).max(120),
  scrolledSinceLast: z.boolean(),
});

/**
 * POST /api/sessions/:sessionId/heartbeat
 * Sent by the companion service every ~30s while a session is ACTIVE.
 * Accumulates billable time and answers with the running total so the live
 * meter (web overlay/widget) and the device stay in sync. When the running
 * penalty hits the user's session cap, replies capReached: true — the device
 * must then force-close the vice app and call /end.
 */
export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const body = bodySchema.parse(await req.json());

  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: { user: true },
  });
  if (session.status !== 'ACTIVE') {
    return NextResponse.json({ error: 'session_not_active' }, { status: 409 });
  }

  const totalActiveSeconds = session.totalActiveSeconds + body.activeSecondsDelta;
  const { penaltyCents, capReached } = sessionPenaltyCents(
    totalActiveSeconds,
    session.user.penaltyRateCentsPerMin,
    session.user.sessionCapCents,
  );

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      totalActiveSeconds,
      totalPenaltyCents: penaltyCents,
      capReached,
      ...(body.scrolledSinceLast ? { lastScrollEventAt: new Date() } : {}),
    },
  });

  return NextResponse.json({ totalActiveSeconds, penaltyCents, capReached });
}
