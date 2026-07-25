import type { GmailMessage } from "@/lib/google/gmail";

/**
 * CRM-relevance filter for inbound email.
 *
 * Deliberately kept in its own module with NO database or Inngest imports:
 * it is a pure predicate that decides what enters the ledger (and so what
 * counts as deal activity, and what the LLM is billed for), which makes it
 * the piece most worth testing in isolation.
 *
 * Two hard rules from the architecture:
 *   1. Internal-only threads are noise — at least one correspondent must be
 *      outside the TENANT's internalDomains.
 *   2. Automated/bulk mail is noise — List-Unsubscribe or Precedence:
 *      bulk/list headers, or a no-reply sender, mean a machine wrote it.
 *
 * Also skips drafts/chats/spam/trash by label. Deliberately permissive
 * beyond that: a false positive costs one harmless ledger row, a false
 * negative silently loses relationship history — and, because the staleness
 * sweep reads the ledger, would eventually flag a live deal as stale.
 */
export function shouldIngest(
  message: GmailMessage,
  internalDomainSet: Set<string>,
): boolean {
  const skipLabels = ["DRAFT", "CHAT", "SPAM", "TRASH"];
  if (message.labelIds.some((l) => skipLabels.includes(l))) return false;

  // Newsletters, receipts, CI noise, calendar robots.
  if (message.hasListUnsubscribe) return false;
  const precedence = message.precedence?.toLowerCase();
  if (precedence === "bulk" || precedence === "list") return false;
  if (
    message.fromEmail &&
    /^(no[-._]?reply|do[-._]?not[-._]?reply)@/.test(message.fromEmail)
  ) {
    return false;
  }

  // Internal-only thread: every correspondent is on a tenant domain.
  const hasExternal = message.participants.some((p) => {
    const domain = p.email.split("@")[1]?.toLowerCase();
    return domain && !internalDomainSet.has(domain);
  });
  if (!hasExternal) return false;

  // Nothing extractable.
  if (message.bodyText.trim().length === 0) return false;

  return true;
}
