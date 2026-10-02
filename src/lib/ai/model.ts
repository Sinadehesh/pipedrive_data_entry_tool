import { anthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Which LLM runs extraction, chosen by env — no code change to switch:
 *
 *   LLM_PROVIDER=anthropic  ANTHROPIC_API_KEY=...   (default)
 *   LLM_PROVIDER=kimi       MOONSHOT_API_KEY=...
 *   LLM_PROVIDER=deepseek   DEEPSEEK_API_KEY=...
 *   LLM_MODEL=<id>          optional; overrides the provider's default
 *
 * The providers are NOT equivalent at returning our schema, and that is
 * what this pipeline lives or dies on — a malformed extraction can't be
 * gated, reviewed or written:
 *
 *   anthropic  native structured output.
 *   kimi       API-ENFORCED JSON Schema (`json_schema` + `strict`), per
 *              platform.kimi.ai/docs/guide/response_format. kimi-k3 is
 *              documented as reliable with nested objects and anyOf
 *              (how our nullable fields serialize).
 *   deepseek   JSON mode only (`json_object`): the schema travels as a
 *              prompt instruction, not a constraint, and DeepSeek documents
 *              that the API "may occasionally return empty content". Inngest
 *              step retries absorb that in the pipeline; expect the odd
 *              failure in one-shot `npm run try:extract` runs.
 *
 * Reads process.env directly (not env()) so `npm run try:extract` works
 * with nothing but an API key — env() would also demand a DATABASE_URL.
 */
export type LlmProvider = "anthropic" | "kimi" | "deepseek";

const PROVIDERS: Record<
  LlmProvider,
  { defaultModel: string; keyVar: string; keyUrl: string }
> = {
  anthropic: {
    defaultModel: "claude-opus-4-8",
    keyVar: "ANTHROPIC_API_KEY",
    keyUrl: "console.anthropic.com → API Keys",
  },
  kimi: {
    defaultModel: "kimi-k3",
    keyVar: "MOONSHOT_API_KEY",
    keyUrl: "platform.kimi.ai → API Keys",
  },
  deepseek: {
    defaultModel: "deepseek-v4-pro",
    keyVar: "DEEPSEEK_API_KEY",
    keyUrl: "platform.deepseek.com → API keys",
  },
};

export function llmProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER ?? "anthropic").trim().toLowerCase();
  if (raw === "moonshot") return "kimi";
  if (raw in PROVIDERS) return raw as LlmProvider;
  throw new Error(
    `LLM_PROVIDER="${raw}" is not supported. Use one of: ${Object.keys(PROVIDERS).join(", ")}.`,
  );
}

/** Recorded on every extraction row, so results stay attributable. */
export function llmModelId(): string {
  return process.env.LLM_MODEL?.trim() || PROVIDERS[llmProvider()].defaultModel;
}

/** The env var holding the active provider's key, for error messages. */
export function llmKeyVar(): { name: string; where: string } {
  const p = PROVIDERS[llmProvider()];
  return { name: p.keyVar, where: p.keyUrl };
}

/**
 * Build the model. Called lazily (per extraction), so a missing key fails
 * that one job with a clear message instead of crashing every Inngest
 * function at import.
 */
export function extractionModel(): LanguageModel {
  const provider = llmProvider();
  const { keyVar, keyUrl } = PROVIDERS[provider];
  const apiKey = process.env[keyVar];
  if (!apiKey) {
    throw new Error(
      `LLM_PROVIDER=${provider} needs ${keyVar} (get one at ${keyUrl}).`,
    );
  }
  const modelId = llmModelId();

  switch (provider) {
    case "anthropic":
      return anthropic(modelId);

    case "deepseek":
      return createDeepSeek({ apiKey })(modelId);

    case "kimi":
      return createOpenAICompatible({
        name: "kimi",
        apiKey,
        baseURL: process.env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1",
        // Send our Zod schema as response_format.json_schema …
        supportsStructuredOutputs: true,
        // … and make Kimi ENFORCE it. The generic provider omits `strict`,
        // which leaves the schema a suggestion.
        transformRequestBody: (body) => {
          const rf = body.response_format as
            | { type?: string; json_schema?: Record<string, unknown> }
            | undefined;
          if (rf?.type === "json_schema" && rf.json_schema) {
            return {
              ...body,
              response_format: {
                ...rf,
                json_schema: { ...rf.json_schema, strict: true },
              },
            };
          }
          return body;
        },
      })(modelId);
  }
}
