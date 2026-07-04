import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),

  CLAAP_API_KEY: z.string().min(1),
  CLAAP_WEBHOOK_SECRET: z.string().min(1),

  PIPEDRIVE_DOMAIN: z.string().min(1),
  PIPEDRIVE_API_TOKEN: z.string().min(1),
  PIPEDRIVE_FIELD_BANT_BUDGET: z.string().optional().default(""),
  PIPEDRIVE_FIELD_BANT_AUTHORITY: z.string().optional().default(""),
  PIPEDRIVE_FIELD_BANT_NEED: z.string().optional().default(""),
  PIPEDRIVE_FIELD_BANT_TIMELINE: z.string().optional().default(""),

  ANTHROPIC_API_KEY: z.string().min(1),

  INTERNAL_EMAIL_DOMAINS: z.string().optional().default(""),
});

// Validated lazily so `next build` and drizzle-kit can run without a full env.
let cached: z.infer<typeof envSchema> | undefined;

export function env(): z.infer<typeof envSchema> {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

export function internalDomains(): Set<string> {
  return new Set(
    env()
      .INTERNAL_EMAIL_DOMAINS.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}
