import { z } from "zod";

/**
 * Platform-level configuration only. Anything tenant-specific — Pipedrive
 * tokens and field keys, Claap keys and webhook secrets, Google refresh
 * tokens, internal email domains — lives in the database (`connections`,
 * `field_mappings`, `tenants`), encrypted where secret. If you're about to
 * add a per-customer value here, it belongs in a table instead.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().url(),

  ANTHROPIC_API_KEY: z.string().min(1),

  // OUR Google OAuth app (one app serves every tenant's mailboxes).
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  // One Pub/Sub topic serves all tenants; notifications are routed to a
  // tenant by mailbox address via the connections table.
  GMAIL_PUBSUB_TOPIC: z.string().optional().default(""),
  PUBSUB_PUSH_SERVICE_ACCOUNT: z.string().optional().default(""),
  PUBSUB_PUSH_AUDIENCE: z.string().optional().default(""),

  // Encrypts every tenant credential at rest (AES-256-GCM).
  TOKEN_ENCRYPTION_KEY: z.string().optional().default(""),

  // Auth.js session signing (openssl rand -base64 32). Read automatically
  // by next-auth; listed here so a missing value fails loudly at parse.
  AUTH_SECRET: z.string().optional().default(""),

  // OUR Pipedrive Marketplace OAuth app (one app serves every tenant).
  PIPEDRIVE_CLIENT_ID: z.string().optional().default(""),
  PIPEDRIVE_CLIENT_SECRET: z.string().optional().default(""),

  // Public origin, e.g. https://app.example.com — builds OAuth redirect URIs.
  APP_URL: z.string().optional().default(""),
});

// Validated lazily so `next build` and drizzle-kit can run without a full env.
let cached: z.infer<typeof envSchema> | undefined;

export function env(): z.infer<typeof envSchema> {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}
