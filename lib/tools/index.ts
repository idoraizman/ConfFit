import { TOOLS, type ToolName } from '../modules'
import { search as vectorSearch } from '../store/vector'
import { guideLinks, htmlToText } from './html'

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
    const isHtml = /html/i.test(type)
    const text = isHtml ? htmlToText(body) : body
    const links = isHtml ? guideLinks(body, res.url) : []
    return {
      tool: 'web_fetch',
      ok: true,
      content: text.slice(0, maxChars),
      meta: { url: res.url, chars: text.length, truncated: text.length > maxChars, links },
    }
  } catch (e) {
    return { tool: 'web_fetch', ok: false, content: `Could not fetch ${url}: ${(e as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Keyless web search.
 *
 * Every engine here is a no-JS HTML endpoint, so there is no API key and no cost
 * — and every one of them fails differently. DuckDuckGo answers a laptop with
 * good hits but rate-limits repeated use and serves datacenter IPs an empty
 * anomaly page, which is exactly where this runs in production. Bing's RSS view
 * does answer from a datacenter, but it entity-matches rather than searches: ask
 * it for "Eurographics 2029 call for papers submission guidelines" and it will
 * offer pizza delivery.
 *
 * So we query all of them, merge, and let the caller rank and discard — a first
 * past the post ordering would let whichever engine happened to answer decide
 * the result, junk included. The engines that answered are reported so a silent
 * degradation is visible in the trace.
 */
interface SearchProvider {
  name: string
  url: (q: string) => string
  /**
   * `rss` reads <item><title>/<link> pairs; `ddg` reads DuckDuckGo's redirector
   * links, whose `uddg=` parameter holds the real URL. Matching the redirector
   * rather than a CSS class covers both DuckDuckGo endpoints, which differ in
   * markup and even in attribute quoting.
   */
  kind: 'rss' | 'ddg'
}

const SEARCH_PROVIDERS: SearchProvider[] = [
  // DuckDuckGo first in the merge order: when it answers, its hits are the most
  // on-target. Bing is the one that answers from a datacenter at all.
  { name: 'duckduckgo', kind: 'ddg', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  {
    name: 'bing-rss',
    kind: 'rss',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&mkt=en-US`,
  },
  { name: 'duckduckgo-lite', kind: 'ddg', url: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}` },
]

/** Hosts that are the engine talking about itself rather than a venue page. */
const SEARCH_NOISE = /(^|\.)(duckduckgo|bing|google|microsoft|yahoo)\.[a-z.]+$/i

function extractResults(body: string, kind: SearchProvider['kind']): { title: string; url: string }[] {
  const pairs: { title: string; url: string }[] =
    kind === 'rss'
      ? [...body.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>/gi)].map(
          (m) => ({ title: m[1], url: m[2] }),
        )
      : [...body.matchAll(/uddg=([^"'&]+)/gi)].map((m) => ({ title: '', url: decodeURIComponent(m[1]) }))

  const results: { title: string; url: string }[] = []
  const seen = new Set<string>()
  for (const { title, url } of pairs) {
    if (results.length >= 6) break
    if (!/^https?:\/\//i.test(url)) continue
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      continue
    }
    if (SEARCH_NOISE.test(host) || seen.has(url)) continue
    seen.add(url)
    results.push({ title: htmlToText(title).slice(0, 120) || host, url })
  }
  return results
}

async function webSearch(query: string): Promise<ToolResult> {
  if (!query.trim()) return { tool: 'web_search', ok: false, content: 'Empty query.' }

  const attempts: string[] = []
  const answered: string[] = []
  const perProvider = await Promise.all(
    SEARCH_PROVIDERS.map(async (provider) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(provider.url(query), {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,*/*' },
          signal: controller.signal,
        })
        if (!res.ok) {
          attempts.push(`${provider.name}: HTTP ${res.status}`)
          return []
        }
        const results = extractResults(await res.text(), provider.kind)
        attempts.push(`${provider.name}: ${results.length} result(s)`)
        if (results.length) answered.push(provider.name)
        return results
      } catch (e) {
        attempts.push(`${provider.name}: ${(e as Error).message}`)
        return []
      } finally {
        clearTimeout(timer)
      }
    }),
  )

  // Round-robin so one engine's whole result page cannot bury another's first
  // hit; the caller ranks properly afterwards.
  const merged: { title: string; url: string }[] = []
  const seen = new Set<string>()
  for (let rank = 0; merged.length < 8; rank++) {
    if (perProvider.every((list) => rank >= list.length)) break
    for (const list of perProvider) {
      const hit = list[rank]
      if (!hit || seen.has(hit.url)) continue
      seen.add(hit.url)
      merged.push(hit)
    }
  }

  return {
    tool: 'web_search',
    ok: merged.length > 0,
    content: merged.length
      ? merged.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join('\n')
      : `No search engine returned results (${attempts.join('; ')}).`,
    meta: { results: merged, engine: answered.join('+') || null, attempts },
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
