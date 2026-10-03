/**
 * Resolve Inngest's keys from the environment, tolerating a prefix.
 *
 * The SDK only looks for the exact names INNGEST_EVENT_KEY and
 * INNGEST_SIGNING_KEY. Vercel's Inngest integration, however, can require a
 * "Custom Environment Variable Prefix" when connecting a project, which
 * produces names like CRM_INNGEST_SIGNING_KEY that the SDK never finds —
 * the serve endpoint then answers 401 to everything and no job ever runs.
 *
 * So: the exact name wins; otherwise exactly ONE variable ending in the
 * name is accepted. Two different prefixed candidates are ambiguous and
 * resolve to nothing rather than guessing (`npm run doctor` reports it).
 */
type Env = Record<string, string | undefined>;

export function resolveEnvKey(name: string, env: Env = process.env): string | undefined {
  if (env[name]) return env[name];
  const values = new Set(
    Object.keys(env)
      .filter((k) => k !== name && k.endsWith(name) && env[k])
      .map((k) => env[k] as string),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

export const inngestEventKey = (env: Env = process.env) =>
  resolveEnvKey("INNGEST_EVENT_KEY", env);
export const inngestSigningKey = (env: Env = process.env) =>
  resolveEnvKey("INNGEST_SIGNING_KEY", env);
export const inngestSigningKeyFallback = (env: Env = process.env) =>
  resolveEnvKey("INNGEST_SIGNING_KEY_FALLBACK", env);
