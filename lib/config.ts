/** Environment configuration, read once per process. */

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim()
}

function num(name: string, fallback: number): number {
  const raw = env(name)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : fallback
}

/** Strips a trailing slash so we can always concatenate `/chat/completions`. */
function baseUrl(raw: string): string {
  return raw.replace(/\/+$/, '')
}

export const config = {
  llm: {
    baseUrl: baseUrl(env('LLMOD_BASE_URL', 'https://api.llmod.ai/v1')),
    apiKey: env('LLMOD_API_KEY'),
    textModel: env('LLM_TEXT_MODEL', 'MB5R2CF-azure/gpt-5.4-mini'),
    embedModel: env('LLM_EMBED_MODEL', 'MB5R2CF-azure/text-embedding-3-small'),
    /**
     * Deterministic stub for local development — costs nothing.
     *
     * Falling back to the stub when no key is configured is a development
     * convenience only. In production a missing key must surface as an error:
     * silently serving mock text would look like a working agent.
     */
    mock:
      env('MOCK_LLM') === '1' ||
      (env('LLMOD_API_KEY') === '' && process.env.NODE_ENV !== 'production'),
  },
  supabase: {
    url: env('SUPABASE_URL'),
    key: env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY'),
    get enabled() {
      return Boolean(this.url && this.key)
    },
  },
  pinecone: {
    apiKey: env('PINECONE_API_KEY'),
    index: env('PINECONE_INDEX', 'conffit'),
    get enabled() {
      return Boolean(this.apiKey)
    },
  },
  agents: {
    /** Reflection iterations. Hard-capped at 2 to protect the budget. */
    framingReflectMax: Math.min(2, Math.max(0, num('FRAMING_REFLECT_MAX', 1))),
    /** Max ReAct tool iterations in FormatComplianceAgent / ConferenceProfiler. */
    reactMaxIters: 2,
  },
  limits: {
    /** Reject absurd payloads before we spend a token on them. */
    maxPromptChars: 200_000,
    /**
     * Ceiling on the manuscript we will parse.
     *
     * This is NOT a token lever: the full text never reaches the model. It is
     * read only by code — the deterministic rule checks and the mechanical
     * fixes — while every model-bound input is a bounded slice (abstract,
     * intro opening, the spans a report flagged). So this only needs to be
     * larger than a real paper. A 9-page conference submission with references
     * runs 45k–55k characters; 150k leaves room for appendices.
     */
    maxManuscriptChars: 150_000,
    /** CFP text kept for profile synthesis. */
    maxCfpChars: 14_000,
  },
} as const
