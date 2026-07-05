import { randomUUID } from "node:crypto";

import { google, type calendar_v3 } from "googleapis";

import type { Participant } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { oauthClientFor, type GoogleConnection } from "./auth";

/**
 * Minimal wrapper over the Calendar API for the pull-on-notify loop.
 * Same shape as gmail.ts: the push ping carries no content; we pull deltas
 * with the stored syncToken, and channels expire silently without renewal.
 */

/** Raised when Google invalidates our syncToken (HTTP 410 GONE). */
export class CalendarSyncExpiredError extends Error {
  constructor() {
    super("Calendar syncToken expired (410 GONE)");
    this.name = "CalendarSyncExpiredError";
  }
}

function isGone(err: unknown): boolean {
  const e = err as { status?: number; code?: number; response?: { status?: number } };
  return e?.status === 410 || e?.code === 410 || e?.response?.status === 410;
}

function calendarFor(connection: GoogleConnection): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: oauthClientFor(connection) });
}

export type CalendarEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string | null;
  description: string | null;
  startAt: string | null; // ISO; null on cancelled stubs
  attendees: Participant[];
};

/**
 * Pull changed events since the stored syncToken (or, with no token, a
 * bounded initial window). Google returns cancelled events as thin stubs —
 * often just {id, status} — which is why risk handling looks the original
 * meeting up in OUR ledger for attendees.
 */
export async function listEventsDelta(
  connection: GoogleConnection,
  syncToken: string | null,
  initialWindowDays = 30,
): Promise<{ events: CalendarEvent[]; newSyncToken: string }> {
  const calendar = calendarFor(connection);
  const events: CalendarEvent[] = [];
  let newSyncToken: string | undefined;
  let pageToken: string | undefined;

  try {
    do {
      const res = await calendar.events.list({
        calendarId: "primary",
        maxResults: 250,
        pageToken,
        showDeleted: true, // cancelled events are the risk signal
        singleEvents: true,
        ...(syncToken
          ? { syncToken }
          : {
              updatedMin: new Date(
                Date.now() - initialWindowDays * 24 * 60 * 60 * 1000,
              ).toISOString(),
            }),
      });
      for (const item of res.data.items ?? []) {
        const mapped = mapEvent(item);
        if (mapped) events.push(mapped);
      }
      pageToken = res.data.nextPageToken ?? undefined;
      newSyncToken = res.data.nextSyncToken ?? newSyncToken;
    } while (pageToken);
  } catch (err) {
    if (isGone(err)) throw new CalendarSyncExpiredError();
    throw err;
  }

  if (!newSyncToken) {
    throw new Error("calendar events.list ended without a nextSyncToken");
  }
  return { events, newSyncToken };
}

/**
 * (Re-)arm the push channel for the primary calendar. We generate the
 * channel id (unguessable uuid) — it doubles as the webhook's authenticity
 * token, since Google echoes it in X-Goog-Channel-ID on every ping.
 * Calendar channels expire (Google chooses the TTL, typically days–weeks);
 * the renewal cron re-arms them and stops the old channel.
 */
export async function startCalendarWatch(
  connection: GoogleConnection,
): Promise<{ channelId: string; resourceId: string; expiresAt: Date }> {
  const calendar = calendarFor(connection);
  const channelId = randomUUID();
  const res = await calendar.events.watch({
    calendarId: "primary",
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: `${env().APP_URL.replace(/\/$/, "")}/api/webhooks/google/calendar`,
    },
  });
  return {
    channelId,
    resourceId: res.data.resourceId ?? "",
    expiresAt: res.data.expiration
      ? new Date(Number(res.data.expiration))
      : // Some calendars omit expiration; assume a week so renewal re-arms.
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

/** Best-effort stop of a superseded channel; failures are non-fatal. */
export async function stopCalendarWatch(
  connection: GoogleConnection,
  channelId: string,
  resourceId: string,
): Promise<void> {
  try {
    await calendarFor(connection).channels.stop({
      requestBody: { id: channelId, resourceId },
    });
  } catch {
    // Old channel dies at its natural expiry; nothing to do.
  }
}

function mapEvent(item: calendar_v3.Schema$Event): CalendarEvent | null {
  if (!item.id) return null;
  return {
    id: item.id,
    status: (item.status ?? "confirmed") as CalendarEvent["status"],
    summary: item.summary ?? null,
    description: item.description ?? null,
    startAt: item.start?.dateTime ?? item.start?.date ?? null,
    attendees: (item.attendees ?? [])
      .filter(
        (a): a is calendar_v3.Schema$EventAttendee & { email: string } =>
          Boolean(a.email) && !a.resource, // drop meeting rooms
      )
      .map((a) => ({
        email: a.email.toLowerCase(),
        ...(a.displayName ? { name: a.displayName } : {}),
        ...(a.organizer ? { isHost: true } : {}),
      })),
  };
}
