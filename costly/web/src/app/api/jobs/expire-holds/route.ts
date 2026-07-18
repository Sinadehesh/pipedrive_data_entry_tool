import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { stripe } from '@/lib/stripe';

/**
 * GET /api/jobs/expire-holds
 * Scheduled sweep — no automation platform involved. Wire it to Vercel Cron
 * (see vercel.json) or any plain scheduler (system cron / GitHub Actions
 * schedule) that can send `Authorization: Bearer $CRON_SECRET`.
 *
 * Sweeps PENDING redemption tasks whose 24h deadline has passed and CAPTURES
 * the 80% purgatory hold. The walk didn't happen; the money does.
 * Safe to call at any frequency — each task is captured at most once.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const expired = await prisma.redemptionTask.findMany({
    where: { status: 'PENDING', deadline: { lt: new Date() } },
    include: { session: true },
    take: 50,
  });

  const results: { taskId: string; ok: boolean }[] = [];
  for (const task of expired) {
    try {
      await stripe.paymentIntents.capture(task.session.stripePurgatoryPaymentIntentId!);
      await prisma.$transaction([
        prisma.redemptionTask.update({ where: { id: task.id }, data: { status: 'FAILED' } }),
        prisma.session.update({ where: { id: task.sessionId }, data: { status: 'CAPTURED' } }),
      ]);
      results.push({ taskId: task.id, ok: true });
    } catch (err) {
      // Leave PENDING for the next sweep; webhook reconciliation is the
      // backstop if Stripe captured but our DB write failed.
      console.error(`expire-holds: capture failed for task ${task.id}`, err);
      results.push({ taskId: task.id, ok: false });
    }
  }

  return NextResponse.json({ swept: results.length, results });
}
