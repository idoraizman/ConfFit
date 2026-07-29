import { config } from './config'
import type { RunUsage } from './types'

/**
 * Minimal OpenAI-compatible client for LLMod.ai.
 *
 * Two things it deliberately does beyond a plain fetch:
 *  1. Parameter compatibility. The gpt-5 family rejects `max_tokens` (wants
 *     `max_completion_tokens`) and rejects any `temperature` other than 1, and
 *     not every gateway supports `response_format`. Rather than guessing the
 *     gateway's dialect we start with the modern spelling and downgrade once
 *     per process on a 400, remembering what worked.
 *  2. Retries. 429/5xx are retried with backoff, bounded so a single
 *     /api/execute stays far inside Vercel's function timeout.
 */

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message)
    this.name = 'LLMError'
  }
}

/** The model answered, but not with a readable JSON object. */
export class JsonParseError extends LLMError {
  constructor(message: string) {
    super(message)
    this.name = 'JsonParseError'
  }
}

export interface ChatRequest {
  system: string
  user: string
  /** Upper bound on the completion. Keep it tight — it is a cost lever. */
  maxTokens?: number
  /** Request a JSON object back. */
  json?: boolean
  /** Deterministic payload returned instead of a call when MOCK_LLM=1. */
  mock?: unknown
}

export interface ChatResult {
  text: string
  usage: { prompt_tokens: number; completion_tokens: number }
  /**
   * Why the model stopped. `"length"` means the completion hit `maxTokens` and
   * was cut off mid-word — with a JSON reply that shows up downstream as an
   * unparseable object, so callers need to be able to tell truncation apart
   * from a model that simply answered badly.
   */
  finish_reason: string | null
}

/** Dialect facts we learn from the gateway and reuse for the rest of the process. */
const dialect = {
  maxTokensKey: 'max_completion_tokens' as 'max_completion_tokens' | 'max_tokens',
  supportsJsonMode: true,
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 60_000

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function post(path: string, body: unknown): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(`${config.llm.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Accumulates token usage for the current request; wired up by the tracer. */
export class UsageMeter {
  llm_calls = 0
  prompt_tokens = 0
  completion_tokens = 0
  embedding_calls = 0

  record(u: { prompt_tokens: number; completion_tokens: number }) {
    this.llm_calls += 1
    this.prompt_tokens += u.prompt_tokens
    this.completion_tokens += u.completion_tokens
  }

  snapshot(): RunUsage {
    return {
      llm_calls: this.llm_calls,
      prompt_tokens: this.prompt_tokens,
      completion_tokens: this.completion_tokens,
      embedding_calls: this.embedding_calls,
    }
  }
}

export async function chat(req: ChatRequest): Promise<ChatResult> {
  if (config.llm.mock) {
    const text =
      req.mock === undefined
        ? 'MOCK'
        : typeof req.mock === 'string'
          ? req.mock
          : JSON.stringify(req.mock)
    return { text, usage: { prompt_tokens: 0, completion_tokens: 0 }, finish_reason: 'stop' }
  }

  if (!config.llm.apiKey) {
    throw new LLMError('LLMOD_API_KEY is not configured on the server.')
  }

  let lastErr: LLMError | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const body: Record<string, unknown> = {
      model: config.llm.textModel,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }
    if (req.maxTokens) body[dialect.maxTokensKey] = req.maxTokens
    if (req.json && dialect.supportsJsonMode) {
      body.response_format = { type: 'json_object' }
    }

    let res: Response
    try {
      res = await post('/chat/completions', body)
    } catch (e) {
      lastErr = new LLMError(`Request to the LLM provider failed: ${(e as Error).message}`)
      if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * attempt)
        continue
      }
      throw lastErr
    }

    if (res.ok) {
      const json = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const text = json.choices?.[0]?.message?.content ?? ''
      const finishReason = json.choices?.[0]?.finish_reason ?? null
      if (!text.trim()) {
        // A reasoning model can spend the whole completion budget thinking and
        // return nothing. Say so, rather than reporting a blank answer.
        throw new LLMError(
          finishReason === 'length'
            ? `The LLM provider returned no content: the completion budget (${req.maxTokens ?? 'default'} tokens) was exhausted before an answer was written.`
            : 'The LLM provider returned an empty completion.',
        )
      }
      return {
        text,
        usage: {
          prompt_tokens: json.usage?.prompt_tokens ?? 0,
          completion_tokens: json.usage?.completion_tokens ?? 0,
        },
        finish_reason: finishReason,
      }
    }

    const detail = await res.text().catch(() => '')

    // Dialect downgrade: adjust one knob and retry immediately (not counted
    // against the retry budget, because nothing was actually attempted twice
    // with the same request shape).
    if (res.status === 400) {
      if (
        dialect.maxTokensKey === 'max_completion_tokens' &&
        /max_completion_tokens|max_tokens/i.test(detail)
      ) {
        dialect.maxTokensKey = 'max_tokens'
        attempt -= 1
        continue
      }
      if (dialect.supportsJsonMode && /response_format|json_object/i.test(detail)) {
        dialect.supportsJsonMode = false
        attempt -= 1
        continue
      }
    }

    lastErr = new LLMError(
      `LLM provider returned ${res.status}.`,
      res.status,
      detail.slice(0, 500),
    )
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      await sleep(600 * attempt)
      continue
    }
    throw lastErr
  }

  throw lastErr ?? new LLMError('LLM provider call failed.')
}

/**
 * Pulls a JSON object out of a completion.
 *
 * Models occasionally wrap JSON in prose or a ```json fence even when asked not
 * to, and a completion that hits its token ceiling stops mid-object. We recover
 * from both in code rather than paying for a repair call.
 */
export function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim()
  const candidates = [trimmed]

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))

  // A model asked for one object sometimes writes two, one per line. Take the
  // first: it is the answer, and the rest is the model second-guessing itself.
  const firstObject = balancedObject(trimmed)
  if (firstObject) candidates.push(firstObject)

  candidates.push(...repairTruncated(trimmed))

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object') return parsed as T
    } catch {
      /* try the next candidate */
    }
  }
  throw new JsonParseError(`Could not parse a JSON object from the model output: ${trimmed.slice(0, 200)}`)
}

/** The first `{...}` whose braces balance, ignoring braces inside strings. */
function balancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Salvage candidates for an object that was cut off mid-write.
 *
 * Only key/value pairs that arrived complete are kept: a half-received value is
 * dropped rather than closed off, because half a URL or half a page limit is
 * worse than a missing field — a missing field reads as "unknown" everywhere
 * downstream, while a truncated one reads as a confident wrong answer.
 */
function repairTruncated(text: string): string[] {
  const start = text.indexOf('{')
  if (start === -1) return []

  const closers: string[] = []
  let inString = false
  let escaped = false
  /** Index of the last comma that separated two complete top-level pairs. */
  let lastPairEnd = -1

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') closers.unshift('}')
    else if (ch === '[') closers.unshift(']')
    else if (ch === '}' || ch === ']') closers.shift()
    else if (ch === ',' && closers.length === 1) lastPairEnd = i
  }
  if (!closers.length) return []

  const out: string[] = []
  // The object may be complete apart from its closing braces. A tail that is a
  // bare number is excluded: `"page_limit":1` is valid JSON and a truncated 18,
  // which is the one kind of half-value that would parse and be believed.
  if (!inString && !/[,:]\s*$/.test(text) && !/:\s*-?\d+(\.\d+)?$/.test(text)) {
    out.push(text.slice(start) + closers.join(''))
  }
  // Otherwise fall back to everything up to the last complete pair.
  if (lastPairEnd > start) out.push(text.slice(start, lastPairEnd) + '}')
  return out
}

/** Embeds a batch of texts. One HTTP call per batch, not per text. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  if (config.llm.mock) {
    return texts.map((t) => hashEmbedding(t))
  }

  const res = await post('/embeddings', {
    model: config.llm.embedModel,
    input: texts,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new LLMError(`Embedding call returned ${res.status}.`, res.status, detail.slice(0, 500))
  }
  const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] }
  const data = json.data ?? []
  // The API may return items out of order; index them back into place.
  const out: number[][] = new Array(texts.length)
  data.forEach((d, i) => {
    out[d.index ?? i] = d.embedding
  })
  return out
}

/** Cheap deterministic pseudo-embedding so MOCK_LLM=1 exercises the RAG path. */
function hashEmbedding(text: string, dim = 256): number[] {
  const v = new Array(dim).fill(0)
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const tok of tokens) {
    let h = 2166136261
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    v[Math.abs(h) % dim] += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}
