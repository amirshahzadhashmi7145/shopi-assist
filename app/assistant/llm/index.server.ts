import { createMockProvider } from "./mock";
import { createOpenAiProvider } from "./openai.server";
import type { LlmProvider } from "./provider";

export interface LlmStatus {
  /** True when a chat request can be served. */
  ready: boolean;
  provider: "openai" | "mock";
  model: string;
  /** Human-readable reason when not ready. Never contains secrets. */
  problem?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Reads LLM configuration from the environment:
 *   LLM_PROVIDER             "openai" (default) or "mock"
 *   OPENAI_API_KEY           required for "openai"
 *   OPENAI_MODEL             default "gpt-4o"
 *   OPENAI_BASE_URL          optional, for OpenAI-compatible endpoints
 *   OPENAI_MAX_OUTPUT_TOKENS optional, default 1200
 */
export function getLlmStatus(env: Env = process.env): LlmStatus {
  const provider = (env.LLM_PROVIDER || "openai").toLowerCase();

  if (provider === "mock") {
    return { ready: true, provider: "mock", model: "mock" };
  }

  const model = env.OPENAI_MODEL || "gpt-4o";
  if (provider !== "openai") {
    return {
      ready: false,
      provider: "openai",
      model,
      problem: `Unknown LLM_PROVIDER "${provider}". Use "openai" or "mock".`,
    };
  }
  if (!env.OPENAI_API_KEY) {
    return {
      ready: false,
      provider: "openai",
      model,
      problem: "OPENAI_API_KEY is not set on the app server.",
    };
  }
  return { ready: true, provider: "openai", model };
}

interface CachedProvider {
  apiKey: string;
  model: string;
  baseURL: string | undefined;
  maxOutputTokens: number | undefined;
  provider: LlmProvider;
}

let cached: CachedProvider | undefined;

/** Returns the configured provider, or null when configuration is incomplete. */
export function getLlmProvider(env: Env = process.env): LlmProvider | null {
  const status = getLlmStatus(env);
  if (!status.ready) return null;

  if (status.provider === "mock") return createMockProvider();

  const apiKey = env.OPENAI_API_KEY!;
  const baseURL = env.OPENAI_BASE_URL || undefined;
  const maxOutputTokens = Number(env.OPENAI_MAX_OUTPUT_TOKENS) || undefined;

  // Reuse one client (and its connection pool) until the configuration changes.
  const reusable =
    cached &&
    cached.apiKey === apiKey &&
    cached.model === status.model &&
    cached.baseURL === baseURL &&
    cached.maxOutputTokens === maxOutputTokens;

  if (!reusable) {
    cached = {
      apiKey,
      model: status.model,
      baseURL,
      maxOutputTokens,
      provider: createOpenAiProvider({
        apiKey,
        model: status.model,
        baseURL,
        maxOutputTokens,
      }),
    };
  }
  return cached!.provider;
}
