import { describe, expect, it } from "vitest";

import type { GmailMessage } from "@/lib/google/gmail";
import { shouldIngest } from "@/lib/ingest/relevance";

/**
 * The relevance filter decides what enters the ledger — and therefore what
 * the staleness sweep counts as "activity" and what the LLM is billed for.
 * Too strict and real prospect email is invisible (false stale flags); too
 * loose and newsletters become CRM notes.
 */
const INTERNAL = new Set(["ourcompany.com"]);

function message(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    subject: "Following up on pricing",
    internalDate: new Date().toISOString(),
    participants: [
      { email: "rep@ourcompany.com" },
      { email: "jane@prospect.com" },
    ],
    fromEmail: "jane@prospect.com",
    hasListUnsubscribe: false,
    precedence: null,
    bodyText: "Thanks for the call — can you send the revised quote?",
    ...overrides,
  };
}

describe("shouldIngest", () => {
  it("keeps a genuine prospect thread", () => {
    expect(shouldIngest(message(), INTERNAL)).toBe(true);
  });

  it("drops internal-only threads", () => {
    const internal = message({
      participants: [
        { email: "rep@ourcompany.com" },
        { email: "boss@ourcompany.com" },
      ],
      fromEmail: "boss@ourcompany.com",
    });
    expect(shouldIngest(internal, INTERNAL)).toBe(false);
  });

  it("drops newsletters via List-Unsubscribe", () => {
    expect(shouldIngest(message({ hasListUnsubscribe: true }), INTERNAL)).toBe(
      false,
    );
  });

  it("drops bulk/list precedence mail", () => {
    expect(shouldIngest(message({ precedence: "bulk" }), INTERNAL)).toBe(false);
    expect(shouldIngest(message({ precedence: "list" }), INTERNAL)).toBe(false);
    expect(shouldIngest(message({ precedence: "List" }), INTERNAL)).toBe(false);
  });

  it("drops no-reply senders in their common spellings", () => {
    for (const from of [
      "noreply@vendor.com",
      "no-reply@vendor.com",
      "no_reply@vendor.com",
      "donotreply@vendor.com",
      "do-not-reply@vendor.com",
    ]) {
      expect(shouldIngest(message({ fromEmail: from }), INTERNAL)).toBe(false);
    }
  });

  it("drops drafts, chats, spam and trash by label", () => {
    for (const label of ["DRAFT", "CHAT", "SPAM", "TRASH"]) {
      expect(shouldIngest(message({ labelIds: [label] }), INTERNAL)).toBe(false);
    }
  });

  it("drops empty bodies (nothing to extract)", () => {
    expect(shouldIngest(message({ bodyText: "   \n  " }), INTERNAL)).toBe(false);
  });

  it("keeps outbound mail from the rep to a prospect", () => {
    // Sent mail is real relationship activity and must count for freshness.
    const outbound = message({
      fromEmail: "rep@ourcompany.com",
      participants: [
        { email: "rep@ourcompany.com" },
        { email: "jane@prospect.com" },
      ],
    });
    expect(shouldIngest(outbound, INTERNAL)).toBe(true);
  });

  it("treats internal-domain matching case-insensitively", () => {
    const shouty = message({
      participants: [
        { email: "rep@ourcompany.com" },
        { email: "boss@OURCOMPANY.COM".toLowerCase() },
      ],
    });
    expect(shouldIngest(shouty, INTERNAL)).toBe(false);
  });
});
