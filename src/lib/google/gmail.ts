import type { gmail_v1 } from "googleapis";

import type { Participant } from "@/lib/db/schema";
import { gmailFor, googleEnv, type Connection } from "./auth";

/**
 * Minimal wrapper over the Gmail API for the pull-on-notify loop.
 *
 * The Pub/Sub notification carries NO message content — only
 * {emailAddress, historyId}. Everything here exists to turn that ping into
 * ledger rows: list the history delta from our stored cursor, fetch each new
 * message, and manage the watch whose expiry would otherwise silently kill
 * the whole plane.
 */

/** Raised when our stored historyId is older than Gmail's ~1-week retention. */
export class GmailHistoryExpiredError extends Error {
  constructor(public startHistoryId: string) {
    super(`Gmail historyId ${startHistoryId} has expired (404)`);
    this.name = "GmailHistoryExpiredError";
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: number; response?: { status?: number } };
  return e?.status === 404 || e?.code === 404 || e?.response?.status === 404;
}

/**
 * List new message IDs since `startHistoryId`, following pagination.
 * Returns the mailbox's latest historyId as the next cursor.
 */
export async function listHistory(
  connection: Connection,
  startHistoryId: string,
): Promise<{ messageIds: string[]; newHistoryId: string }> {
  const gmail = gmailFor(connection);
  const ids = new Set<string>();
  let newHistoryId = startHistoryId;
  let pageToken: string | undefined;

  try {
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: 500,
        pageToken,
      });
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      if (res.data.historyId) newHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    // Gmail retains history for ~a week; a stale cursor 404s. The caller
    // drops the cursor and runs a bounded resync instead of failing forever.
    if (isNotFound(err)) throw new GmailHistoryExpiredError(startHistoryId);
    throw err;
  }

  return { messageIds: [...ids], newHistoryId };
}

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  subject: string | null;
  internalDate: string; // ISO
  participants: Participant[]; // from + to + cc, deduped
  fromEmail: string | null;
  hasListUnsubscribe: boolean;
  precedence: string | null;
  bodyText: string;
};

/** Fetch and flatten one message: headers, participants, plain-text body. */
export async function getMessage(
  connection: Connection,
  messageId: string,
): Promise<GmailMessage | null> {
  const gmail = gmailFor(connection);
  let data: gmail_v1.Schema$Message;
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    data = res.data;
  } catch (err) {
    // Message deleted between notification and fetch — not an error.
    if (isNotFound(err)) return null;
    throw err;
  }

  const headers = new Map(
    (data.payload?.headers ?? []).map((h) => [
      (h.name ?? "").toLowerCase(),
      h.value ?? "",
    ]),
  );

  const participants = dedupeParticipants([
    ...parseAddressList(headers.get("from")),
    ...parseAddressList(headers.get("to")),
    ...parseAddressList(headers.get("cc")),
  ]);

  return {
    id: data.id!,
    threadId: data.threadId ?? data.id!,
    labelIds: data.labelIds ?? [],
    subject: headers.get("subject") ?? null,
    internalDate: new Date(Number(data.internalDate ?? Date.now())).toISOString(),
    participants,
    fromEmail: parseAddressList(headers.get("from"))[0]?.email ?? null,
    hasListUnsubscribe: headers.has("list-unsubscribe"),
    precedence: headers.get("precedence") ?? null,
    bodyText: extractBodyText(data.payload).slice(0, 100_000),
  };
}

/**
 * Bounded resync after a stale cursor: take the mailbox's CURRENT historyId
 * first (so anything arriving during the resync is covered by the next
 * delta pull — the overlap is harmless thanks to ledger dedupe), then list
 * recent inbox/sent message IDs.
 */
export async function boundedResync(
  connection: Connection,
  days: number,
  maxMessages = 500,
): Promise<{ messageIds: string[]; newHistoryId: string }> {
  const gmail = gmailFor(connection);

  const profile = await gmail.users.getProfile({ userId: "me" });
  const newHistoryId = profile.data.historyId!;

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `newer_than:${days}d -in:chats -in:spam -in:trash`,
      maxResults: Math.min(500, maxMessages - ids.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) {
      if (m.id) ids.push(m.id);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < maxMessages);

  return { messageIds: ids, newHistoryId };
}

/**
 * (Re-)arm the push watch for a mailbox. Gmail watches hard-expire after
 * 7 days; calling this again before expiry extends the channel. Returns the
 * new expiry and the mailbox historyId at watch time (used as the INITIAL
 * cursor only — never overwrite an existing cursor with it, or every
 * message between the old cursor and now is skipped).
 */
export async function startWatch(
  connection: Connection,
): Promise<{ historyId: string; expiresAt: Date }> {
  const gmail = gmailFor(connection);
  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: googleEnv().pubsubTopic,
      labelFilterBehavior: "EXCLUDE",
      labelIds: ["DRAFT", "SPAM", "TRASH"],
    },
  });
  return {
    historyId: res.data.historyId!,
    expiresAt: new Date(Number(res.data.expiration)),
  };
}

// ---------------------------------------------------------------------------

/** "Jane Doe <jane@acme.com>, bob@x.io" -> [{name, email}, {email}] */
function parseAddressList(value: string | undefined): Participant[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => {
      const match = part.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
      if (match) {
        const name = match[1]?.trim();
        return {
          email: match[2].trim().toLowerCase(),
          ...(name ? { name } : {}),
        };
      }
      const bare = part.trim().toLowerCase();
      return bare.includes("@") ? { email: bare } : null;
    })
    .filter((p): p is Participant => p !== null);
}

function dedupeParticipants(list: Participant[]): Participant[] {
  const byEmail = new Map<string, Participant>();
  for (const p of list) {
    if (!byEmail.has(p.email)) byEmail.set(p.email, p);
  }
  return [...byEmail.values()];
}

/** Prefer text/plain; fall back to tag-stripped text/html. */
function extractBodyText(
  payload: gmail_v1.Schema$MessagePart | undefined,
): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBody(plain);
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decodeBody(html));
  return "";
}

function findPart(
  part: gmail_v1.Schema$MessagePart,
  mimeType: string,
): gmail_v1.Schema$MessagePart | null {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decodeBody(part: gmail_v1.Schema$MessagePart): string {
  return Buffer.from(part.body?.data ?? "", "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
