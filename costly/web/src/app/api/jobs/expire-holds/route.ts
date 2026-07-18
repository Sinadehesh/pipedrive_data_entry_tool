import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { stripe } from '@/lib/stripe';

/**
 * POST /api/jobs/expire-holds
 * Hit by n8n on a schedule (every 5–10 min). Sweeps PENDING redemption tasks
 * whose 24h deadline has passed and CAPTURES the 80% purgatory hold.
 * The walk didn't happen; the money does.
 */
export async function POST(req: Request) {
  if (req.headers.get('x-jobs-secret') !== process.env.JOBS_API_SECRET) {
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
