import { TOOLS, type ToolName } from '../modules'
import { search as vectorSearch } from '../store/vector'
import { htmlToText } from './html'

/**
 * The MCP-style tool layer. `listTools()` mirrors an MCP `tools/list` response
 * and `callTool()` mirrors `tools/call`, so the ReAct agents pick a tool by
 * name from the same catalogue an MCP client would see.
 */

export interface ToolSpec {
  name: ToolName
  description: string
  input_schema: Record<string, unknown>
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'web_search',
    description:
      'Find candidate URLs for a conference Call-for-Papers or author guidelines. Returns titles and URLs, not page content.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch one URL and return its readable text. Used to read a CFP page.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, max_chars: { type: 'number' } },
      required: ['url'],
    },
  },
  {
    name: 'vector_search',
    description:
      'Semantic search over the indexed CFP chunks and past accepted papers for one venue (Pinecone namespace = venue id).',
    input_schema: {
      type: 'object',
      properties: { venue_id: { type: 'string' }, query: { type: 'string' }, top_k: { type: 'number' } },
      required: ['venue_id', 'query'],
    },
  },
  {
    name: 'rules_lookup',
    description:
      'Look up one specific submission rule (page limit, anonymity, citation style, template) for a venue in the knowledge base. Use only when the ConferenceProfile does not state the rule.',
    input_schema: {
      type: 'object',
      properties: { venue_id: { type: 'string' }, rule: { type: 'string' } },
      required: ['venue_id', 'rule'],
    },
  },
]

export function listTools(): ToolSpec[] {
  return TOOL_SPECS
}

export interface ToolResult {
  tool: ToolName
  ok: boolean
  content: string
  meta?: Record<string, unknown>
}

const FETCH_TIMEOUT_MS = 15_000
const UA = 'ConfFit/1.0 (academic course project; conference CFP reader)'

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!(TOOLS as readonly string[]).includes(name)) {
    return { tool: name as ToolName, ok: false, content: `Unknown tool "${name}".` }
  }
  switch (name as ToolName) {
    case 'web_fetch':
      return webFetch(String(args.url ?? ''), Number(args.max_chars ?? 14_000))
    case 'web_search':
      return webSearch(String(args.query ?? ''))
    case 'vector_search':
      return doVectorSearch(String(args.venue_id ?? ''), String(args.query ?? ''), Number(args.top_k ?? 4))
    case 'rules_lookup':
      return rulesLookup(String(args.venue_id ?? ''), String(args.rule ?? ''))
  }
}

async function webFetch(url: string, maxChars: number): Promise<ToolResult> {
  if (!/^https?:\/\//i.test(url)) {
    return { tool: 'web_fetch', ok: false, content: `Refusing to fetch a non-HTTP(S) URL: ${url}` }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,*/*' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      return { tool: 'web_fetch', ok: false, content: `HTTP ${res.status} fetching ${url}` }
    }
    const type = res.headers.get('content-type') ?? ''
    if (/pdf|image|octet-stream/i.test(type)) {
      return {
        tool: 'web_fetch',
        ok: false,
        content: `${url} is ${type}; ConfFit reads HTML and plain text only. Provide an HTML version of the CFP.`,
      }
    }
    const body = await res.text()
    const text = /html/i.test(type) ? htmlToText(body) : body
    return {
      tool: 'web_fetch',
      ok: true,
      content: text.slice(0, maxChars),
      meta: { url: res.url, chars: text.length, truncated: text.length > maxChars },
    }
  } catch (e) {
    return { tool: 'web_fetch', ok: false, content: `Could not fetch ${url}: ${(e as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Search via DuckDuckGo's no-JS endpoint. No API key, no cost. If it is
 * unavailable the ReAct loop still has the venue URL heuristics to fall back on.
 */
async function webSearch(query: string): Promise<ToolResult> {
  if (!query.trim()) return { tool: 'web_search', ok: false, content: 'Empty query.' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    })
    if (!res.ok) return { tool: 'web_search', ok: false, content: `Search returned HTTP ${res.status}.` }
    const html = await res.text()

    const results: { title: string; url: string }[] = []
    const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) && results.length < 6) {
      const raw = m[1]
      // DuckDuckGo wraps hits in a redirector; unwrap the uddg parameter.
      const unwrapped = raw.includes('uddg=')
        ? decodeURIComponent(raw.split('uddg=')[1].split('&')[0])
        : raw
      if (/^https?:\/\//i.test(unwrapped)) {
        results.push({ title: htmlToText(m[2]).slice(0, 120), url: unwrapped })
      }
    }
    return {
      tool: 'web_search',
      ok: results.length > 0,
      content: results.length
        ? results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join('\n')
        : 'No results.',
      meta: { results },
    }
  } catch (e) {
    return { tool: 'web_search', ok: false, content: `Search failed: ${(e as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}

async function doVectorSearch(venueId: string, query: string, topK: number): Promise<ToolResult> {
  const matches = await vectorSearch(venueId, query, Math.min(8, Math.max(1, topK)))
  return {
    tool: 'vector_search',
    ok: matches.length > 0,
    content: matches.length
      ? matches.map((m, i) => `[${i + 1}] (${m.kind}, score ${m.score.toFixed(3)}) ${m.text}`).join('\n\n')
      : `Nothing indexed for "${venueId}".`,
    meta: { count: matches.length },
  }
}

/** Rule-scoped retrieval: a vector search biased toward submission mechanics. */
async function rulesLookup(venueId: string, rule: string): Promise<ToolResult> {
  const query = `${rule} submission requirement: ${RULE_HINTS[rule] ?? rule}`
  const matches = await vectorSearch(venueId, query, 3)
  return {
    tool: 'rules_lookup',
    ok: matches.length > 0,
    content: matches.length
      ? matches.map((m) => m.text).join('\n---\n')
      : `The knowledge base has nothing on "${rule}" for ${venueId}.`,
    meta: { rule, count: matches.length },
  }
}

const RULE_HINTS: Record<string, string> = {
  page_limit: 'maximum number of pages for the main body, excluding references and appendix',
  anonymity: 'double-blind review, anonymised submission, author names withheld',
  citation_style: 'citation and bibliography style, natbib, numeric or author-year',
  template: 'LaTeX style file, Word template, official author kit',
  abstract_word_limit: 'maximum abstract length in words',
  required_sections: 'mandatory statements such as ethics, reproducibility, limitations',
}
