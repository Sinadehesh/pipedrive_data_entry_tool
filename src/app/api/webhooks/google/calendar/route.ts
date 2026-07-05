import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { watchChannels } from "@/lib/db/schema";
import { inngest } from "@/inngest/client";

/**
 * Google Calendar push endpoint. Calendar pings are HEADERS ONLY — no body,
 * no OIDC. Authenticity comes from X-Goog-Channel-ID: we generated it as an
 * unguessable uuid at watch time and only Google ever saw it, so a match
 * against watch_channels is proof the ping is ours. Unknown channel ids
 * (including stale ones from stopped channels) are acked and dropped.
 */
export async function POST(req: Request) {
  const channelId = req.headers.get("x-goog-channel-id");
  const resourceState = req.headers.get("x-goog-resource-state");

  if (!channelId) {
    return new Response(null, { status: 200 });
  }
  // "sync" is the channel-created handshake; nothing changed yet.
  if (resourceState === "sync") {
    return new Response(null, { status: 200 });
  }

  const [channel] = await db
    .select({ id: watchChannels.id })
    .from(watchChannels)
    .where(eq(watchChannels.externalChannelId, channelId))
    .limit(1);
  if (!channel) {
    return new Response(null, { status: 200 });
  }

  await inngest.send({
    name: "google/calendar.notified",
    data: { channelId },
  });

  return new Response(null, { status: 200 });
}
