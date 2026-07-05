import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  connections,
  fieldMappings,
  interactions,
  syncOutbox,
  tenants,
  watchChannels,
  type DealRiskPayload,
} from "@/lib/db/schema";
import {
  CalendarSyncExpiredError,
  listEventsDelta,
  type CalendarEvent,
} from "@/lib/google/calendar";
import { lookupCachedIdentity } from "@/lib/identity/resolve";
import { inngest } from "@/inngest/client";

/**
 * Calendar pull-on-notify worker — the gcal sibling of gmail-history.
 *
 * The ping carries only a channel id; this job pulls the real delta with
 * the tenant's stored syncToken, ledgers meetings that involve external
 * attendees, and turns CANCELLATIONS into deal-risk signals:
 *
 *   cancelled event -> attendees from OUR ledger (Google's cancelled stubs
 *   are thin) -> cache-only lookup in the TENANT's identity_map (never
 *   creating CRM records from a cancellation) -> flag_deal_risk outbox row
 *   -> the per-tenant single-writer reconciler flags it in Pipedrive via
 *   the tenant's field_mappings.
 *
 * Multi-tenant isolation: the unguessable channel id routes to exactly one
 * watch_channels row, whose connection carries the tenantId used in every
 * query below. A 410 GONE from Google drops the cursor and rebuilds from a
 * bounded window, with ledger dedupe absorbing the overlap.
 */
export const calendarDelta = inngest.createFunction(
  {
    id: "calendar-delta-sync",
    retries: 3,
    debounce: { key: "event.data.channelId", period: "15s" },
    concurrency: { key: "event.data.channelId", limit: 1 },
  },
  { event: "google/calendar.notified" },
  async ({ event, step, logger }) => {
    const ctx = await step.run("load-channel", async () => {
      const [row] = await db
        .select({
          tenantId: connections.tenantId,
          internalDomains: tenants.internalDomains,
          connection: {
            id: connections.id,
            accountRef: connections.accountRef,
            credentialCiphertext: connections.credentialCiphertext,
          },
          channelId: watchChannels.id,
          cursor: watchChannels.cursor,
        })
        .from(watchChannels)
        .innerJoin(connections, eq(connections.id, watchChannels.connectionId))
        .innerJoin(tenants, eq(tenants.id, connections.tenantId))
        .where(
          and(
            eq(watchChannels.externalChannelId, event.data.channelId),
            eq(watchChannels.kind, "gcal"),
            eq(connections.status, "active"),
            eq(tenants.status, "active"),
          ),
        )
        .limit(1);

      if (row) {
        await db
          .update(watchChannels)
          .set({ lastNotifiedAt: new Date(), updatedAt: new Date() })
          .where(eq(watchChannels.id, row.channelId));
      }
      return row ?? null;
    });

    if (!ctx) {
      logger.warn("calendar ping for unknown/inactive channel", {
        channelId: event.data.channelId,
      });
      return { skipped: "no active channel" };
    }

    const { tenantId } = ctx;
    const internalDomainSet = new Set(
      ctx.internalDomains.map((d) => d.toLowerCase()),
    );

    // The tenant's field mappings — determines whether risk flags land in
    // a mapped custom field or fall back to a note (decided again by the
    // reconciler at write time; carried in the payload for observability).
    const hasRiskFieldMapping = await step.run("load-field-mappings", async () => {
      const rows = await db
        .select({ signal: fieldMappings.signal })
        .from(fieldMappings)
        .where(
          and(
            eq(fieldMappings.tenantId, tenantId),
            eq(fieldMappings.signal, "deal_risk"),
          ),
        );
      return rows.length > 0;
    });

    // Delta pull; 410 GONE -> drop the token, bounded rebuild.
    const delta = await step.run("list-delta", async () => {
      try {
        return await listEventsDelta(ctx.connection, ctx.cursor);
      } catch (err) {
        if (err instanceof CalendarSyncExpiredError) {
          return await listEventsDelta(ctx.connection, null);
        }
        throw err;
      }
    });

    // Partition once; each side is processed in its own checkpointed step.
    const cancelled = delta.events.filter((e) => e.status === "cancelled");
    const upserted = delta.events.filter((e) => e.status !== "cancelled");

    // Ledger externally-attended meetings (created/updated).
    const ledgeredIds = await step.run("ledger-meetings", async () => {
      const ids: string[] = [];
      for (const ev of upserted) {
        const external = ev.attendees.some((a) => {
          const domain = a.email.split("@")[1]?.toLowerCase();
          return domain && !internalDomainSet.has(domain);
        });
        if (!external || !ev.startAt) continue;

        const inserted = await db
          .insert(interactions)
          .values({
            tenantId,
            source: "gcal",
            externalId: ev.id,
            kind: "meeting",
            title: ev.summary,
            occurredAt: new Date(ev.startAt),
            participants: ev.attendees,
            content: ev.description ?? ev.summary ?? "(no description)",
          })
          .onConflictDoNothing()
          .returning({ id: interactions.id });
        if (inserted.length > 0) ids.push(inserted[0].id);
      }
      return ids;
    });
    const ledgered = ledgeredIds.length;

    // Cancellations -> negative deal risk. Google's cancelled stubs rarely
    // carry attendees, so we recover them from the meeting's own ledger row.
    const risksEnqueued = await step.run("flag-cancellations", async () => {
      let count = 0;
      for (const ev of cancelled) {
        const attendees = await attendeesFor(tenantId, ev);
        if (attendees.length === 0) continue;

        // STRICTLY the tenant's identity_map slice, cache-only: a
        // cancellation must never create persons/orgs in the CRM.
        const identity = await lookupCachedIdentity(
          tenantId,
          attendees,
          internalDomainSet,
        );
        if (!identity?.dealId) continue;

        const payload: DealRiskPayload = {
          dealId: identity.dealId,
          reason: `Meeting cancelled: "${ev.summary ?? "meeting"}"`,
          source: "meeting_cancelled",
        };
        const inserted = await db
          .insert(syncOutbox)
          .values({
            tenantId,
            op: "flag_deal_risk",
            payload,
            // One risk flag per cancelled event, ever — re-notifications
            // and retries land on the conflict.
            idempotencyKey: `risk:cancelled:${tenantId}:${ev.id}`,
          })
          .onConflictDoNothing()
          .returning({ id: syncOutbox.id });
        if (inserted.length > 0) count++;
      }
      return count;
    });

    // Advance the cursor LAST, after all ledger/outbox writes committed.
    await step.run("advance-cursor", () =>
      db
        .update(watchChannels)
        .set({
          cursor: delta.newSyncToken,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(watchChannels.id, ctx.channelId)),
    );

    // Nudge the tenant's single-writer reconciler for the new risk rows.
    if (risksEnqueued > 0) {
      await step.sendEvent("enqueue-sync", {
        name: "sync/outbox.ready",
        data: { tenantId },
      });
    }

    // Hand newly-ledgered meetings to the meeting extractor.
    if (ledgeredIds.length > 0) {
      await step.sendEvent(
        "notify-meetings",
        ledgeredIds.map((interactionId) => ({
          name: "gcal/meeting.ingested" as const,
          data: { tenantId, interactionId },
        })),
      );
    }

    return {
      ledgered,
      risksEnqueued,
      scanned: delta.events.length,
      riskTarget: hasRiskFieldMapping ? "custom_field" : "note_fallback",
    };
  },
);

/** Attendees from the cancellation stub, else from our ledgered meeting. */
async function attendeesFor(tenantId: string, ev: CalendarEvent) {
  if (ev.attendees.length > 0) return ev.attendees;
  const [original] = await db
    .select({ participants: interactions.participants })
    .from(interactions)
    .where(
      and(
        eq(interactions.tenantId, tenantId),
        eq(interactions.source, "gcal"),
        eq(interactions.externalId, ev.id),
      ),
    )
    .limit(1);
  return original?.participants ?? [];
}
