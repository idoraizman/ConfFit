import { config } from '../config'
import { MODULES } from '../modules'
import {
  SEED_AS_OF,
  guessCfpUrl,
  profileFromSeed,
  resolveVenue,
  seedCorpus,
  type ResolvedVenue,
} from '../seed/venues'
import type { Store } from '../store'
import { chunk, search, upsertChunks, vectorBackend } from '../store/vector'
import { callTool } from '../tools'
import type { Tracer } from '../trace'
import type { ConferenceProfile, FormatRules, PendingApproval, Task, TemplateSpec } from '../types'

/**
 * ConferenceProfiler — ReAct + RAG, guarded by a human-in-the-loop gate.
 *
 * Cost shape:
 *   cache hit            → 0 LLM calls (1 embedding for the RAG grounding query)
 *   cache miss, unknown  → 0 LLM calls; returns a confirmation question
 *   after approval       → 1–2 ReAct calls + 1 synthesis call, then cached
 */

export interface ProfilerInput {
  tracer: Tracer
  store: Store
  sessionId: string
  /** Raw venue string as the Supervisor understood it. */
  venueRaw: string
  /** A short description of the paper, used as the RAG query. */
  topic: string
  isApprovalReply: boolean
  providedUrl: string | null
  /**
   * Submission rules the author pasted in answer to the gate's question. Used
   * verbatim instead of fetching anything — the escape hatch for a venue whose
   * rules are in a PDF, behind a login, or simply not findable.
   */
  providedGuidelines: string | null
  originalPrompt: string
  task: Task
}

export type ProfilerOutput =
  | { kind: 'profile'; profile: ConferenceProfile; grounding: string[] }
  | { kind: 'ask_user'; question: string }
  | { kind: 'declined'; message: string }

const PROFILER_SYSTEM_REACT = `You are ConferenceProfiler, a ReAct agent that builds a structured profile of an academic venue from its Call-for-Papers.
You have these tools: web_fetch(url), web_search(query).
Reply with a JSON object only:
{"thought":"<one sentence>","action":"web_fetch"|"web_search"|"finish","action_input":"<url or query, or empty when finishing>"}
A bare call-for-papers is usually topics, dates and policies; the concrete formatting rules live on the venue's author guide / author instructions / formatting page. If the observations so far give you scope but no page limit, template or citation style, fetch that page next.
An observation may end with a list of links found on that page. Prefer web_fetch on one of those links over web_search: search from this server frequently returns nothing but venue homepages, while a link the venue itself published is usually the guide you need.
Choose "finish" as soon as the observations contain the venue's scope AND its submission rules (page limit, anonymity, citation style, template). Never take more than the allowed number of steps.`

const PROFILER_SYSTEM_SYNTH = `You are ConferenceProfiler. Turn the observations from a venue's Call-for-Papers into a structured profile.
Return a JSON object only, with exactly these keys:
{"focus_areas":[string],"valued_criteria":[string],"accepted_paper_emphasis":[string],
 "format_rules":{"page_limit":number|null,"references_in_limit":boolean|null,"abstract_word_limit":number|null,
                 "anonymous":boolean|null,"citation_style":"numeric"|"author-year"|"unknown",
                 "template":string|null,"required_sections":[string],"recommended_sections":[string],"unresolved":[string],
                 "template_spec":{"style_package":string|null,"bibliography_style":string|null,
                                  "deanonymising_options":[string],"forbidden_macros":[string],
                                  "forbids_layout_override":boolean,"template_url":string|null}|null}}
Rules: use null and "unknown" for anything the observations do not state — never guess a page limit or a review model. List every rule you could not determine in "unresolved". Keep each list to at most 5 short entries.
template_spec describes the venue's LaTeX template only where the guide states it verbatim: style_package is the .sty an author writes in \\usepackage{...} (without the extension), bibliography_style is the argument of \\bibliographystyle, deanonymising_options are style options that reveal author names (often "final" or "preprint"), forbidden_macros are commands a submission must not contain, and forbids_layout_override is true when the venue says not to change margins or the text area. Set template_spec to null rather than guessing a package name — a wrong one produces a confident but false complaint about the author's preamble.
required_sections is only for sections whose absence breaks a rule ("must include", "will be desk rejected without"). Anything the venue calls encouraged, recommended or optional goes in recommended_sections instead — reporting encouragement as a violation sends authors chasing a problem they do not have.`

export async function runConferenceProfiler(input: ProfilerInput): Promise<ProfilerOutput> {
  const { tracer, store, sessionId } = input
  const resolved = resolveVenue(input.venueRaw)

  // ── Approval reply: resume the ingestion the user just authorised ──────────
  if (input.isApprovalReply) {
    const pending = await store.findPending(sessionId, resolved.family ? resolved.venue_id : null)
    if (!pending) {
      return {
        kind: 'declined',
        message:
          'I do not have a pending request to add a venue to the knowledge base. Send the full request again (target conference, task and paper) and I will start from the top.',
      }
    }
    const pendingVenue: ResolvedVenue = {
      venue_id: pending.venue_id,
      display: pending.venue,
      family: resolveVenue(pending.venue).family,
      year: null,
    }

    // The author pasted the rules themselves. This is the path that always
    // works: no venue site has to be reachable, readable or even public.
    if (input.providedGuidelines) {
      const attempt = await synthesiseProfile(input, pendingVenue, input.providedGuidelines, null)
      if (!attempt.profile) {
        return {
          kind: 'declined',
          message: `I could not read submission rules out of that text. Paste the part of the venue's author instructions that states the page limit, anonymity policy, template and citation style — **${pending.venue}** is still waiting.`,
        }
      }
      await store.clearPending(sessionId, pending.venue_id)
      const grounding = await ground(attempt.profile, input.topic)
      return { kind: 'profile', profile: attempt.profile, grounding }
    }

    const url = input.providedUrl ?? pending.proposed_url
    if (!url) {
      return {
        kind: 'declined',
        message: [
          `I still have **${pending.venue}** waiting, but no page to read — I could not find a Call-for-Papers for it, so there is nothing for a "yes" to approve.`,
          '',
          "Reply with the direct link to the venue's call-for-papers or author-guidelines page (an HTML page, not a PDF), or paste the guidelines text itself, and I will use that.",
        ].join('\n'),
      }
    }
    const attempt = await ingest(input, pendingVenue, url)
    if (!attempt.profile) {
      // The pending row deliberately survives a failed read: the next link the
      // user pastes has to land in the same approval, not be told there is
      // nothing pending.
      const opening =
        attempt.reason === 'no_rules'
          ? `I read ${url}, but it does not state any submission rules — no page limit, anonymity policy, template or citation style. It reads like a landing page rather than the author instructions, so I have not added a profile for it: a profile with every field unknown would be served from the cache from now on and no gate would be left to correct it.`
          : `I could not read a Call-for-Papers at ${url}.`
      return {
        kind: 'declined',
        message: [
          opening,
          '',
          `**${pending.venue}** is still waiting. Reply with another link — a direct URL to the venue's HTML call-for-papers or author-instructions page — or paste the guidelines text straight into the reply box, which always works. PDFs and JavaScript-only pages cannot be fetched.`,
        ].join('\n'),
      }
    }
    await store.clearPending(sessionId, pending.venue_id)
    const grounding = await ground(attempt.profile, input.topic)
    return { kind: 'profile', profile: attempt.profile, grounding }
  }

  // ── Cache check — no LLM ───────────────────────────────────────────────────
  const cached = await store.getProfile(resolved.venue_id)
  // A profile built from an older version of the built-in baselines is treated
  // as a miss, so corrections to a seed are not masked by the cache.
  const staleSeed = cached?.source === 'seed' && cached.updated_at !== SEED_AS_OF
  if (cached && !staleSeed) {
    const grounding = await ground(cached, input.topic)
    tracer.addDeterministic(
      MODULES.PROFILER,
      {
        system: 'Cache and RAG lookup for the target venue. No model call is made when the profile is already known.',
        user: `Profile ${resolved.display} (venue_id=${resolved.venue_id}).`,
      },
      {
        cache_hit: true,
        venue: cached.venue,
        source: cached.source,
        store: store.backend,
        vector_store: vectorBackend(),
        retrieved_passages: grounding.length,
        profile: cached,
      },
    )
    return { kind: 'profile', profile: cached, grounding }
  }

  // ── Seed corpus counts as a warm cache; index it and persist ───────────────
  const seeded = profileFromSeed(resolved)
  if (seeded) {
    await indexSeed(resolved)
    await store.putProfile(seeded)
    const grounding = await ground(seeded, input.topic)
    tracer.addDeterministic(
      MODULES.PROFILER,
      {
        system: 'Cache and RAG lookup for the target venue. No model call is made when the profile is already known.',
        user: `Profile ${resolved.display} (venue_id=${resolved.venue_id}).`,
      },
      {
        cache_hit: true,
        source: 'seed',
        note: `Baseline profile for the ${resolved.display} family, indexed into the knowledge base on first use (as of ${seeded.updated_at}). Verify against the current call-for-papers.`,
        store: store.backend,
        vector_store: vectorBackend(),
        retrieved_passages: grounding.length,
        profile: seeded,
      },
    )
    return { kind: 'profile', profile: seeded, grounding }
  }

  // ── Cache miss on an unknown venue: ask before ingesting anything ──────────
  // Only a URL the user gave as the target conference counts as a proposal.
  let proposed = input.providedUrl ?? guessCfpUrl(resolved, input.venueRaw)
  let searchNote: string | null = null
  let searchEngine: string | null = null
  let alternatives: { title: string; url: string }[] = []
  let unrelated: { title: string; url: string }[] = []
  if (!proposed) {
    const hits = await Promise.all(QUERY_FORMS.map((form) => callTool('web_search', { query: form(resolved.display) })))
    const tokens = venueTokens(resolved.display)
    const candidates = rankCandidates(mergeHits(hits), tokens)
    const plausible = candidates.filter((c) => looksLikeVenuePage(c, tokens))
    proposed = plausible[0]?.url ?? null
    alternatives = plausible.slice(1, 4)
    // Kept only to show the author what the search actually turned up when none
    // of it was worth proposing.
    unrelated = plausible.length ? [] : candidates.slice(0, 3)
    searchNote = candidates.length
      ? candidates.map((c, i) => `${i + 1}. ${c.title} — ${c.url}`).join('\n')
      : hits.map((h) => h.content).join(' | ')
    searchEngine = [...new Set(hits.flatMap((h) => String(h.meta?.engine ?? '').split('+')))].filter(Boolean).join('+') || null
  }

  const pending: PendingApproval = {
    session_id: sessionId,
    venue: resolved.display,
    venue_id: resolved.venue_id,
    proposed_url: proposed ?? '',
    original_prompt: input.originalPrompt,
    task: input.task,
    created_at: new Date().toISOString(),
  }
  await store.putPending(pending)

  const altBlock = alternatives.length
    ? `Other candidates I found, if that one is wrong:\n${alternatives.map((a) => `- ${a.url}`).join('\n')}`
    : ''

  const question = proposed
    ? [
        `I don't have guidelines for **${resolved.display}** in the knowledge base yet.`,
        '',
        `May I fetch ${proposed} and add it?`,
        '',
        altBlock,
        '',
        '**Reply in the box below this answer**, one of:',
        '- `yes` — fetch that page and add it',
        "- a different link to the venue's call-for-papers or author instructions",
        '- the guidelines text itself, pasted in — I will use that verbatim and fetch nothing',
        '',
        'Nothing has been written to the knowledge base.',
      ]
        .filter((l, i, all) => l !== '' || all[i - 1] !== '')
        .join('\n')
    : [
        `I don't have guidelines for **${resolved.display}** in the knowledge base, and I could not find a Call-for-Papers page for it.`,
        '',
        // Naming the reason matters: "I found nothing" and "I could not search"
        // point the author at completely different next steps.
        searchEngine
          ? `My web search ran (via ${searchEngine}) and returned nothing that looks like a venue page, so either the venue is not indexed under that name or the ${
              resolved.year ?? 'next'
            } edition has not been announced yet.`
          : 'My web search could not reach any search engine from the server, so this is not evidence that the venue does not exist.',
        unrelated.length
          ? `\nNone of the hits I got looks like a submission-rules page, so I will not read any of them uninvited. For the record, they were:\n${unrelated
              .map((u) => `- ${u.title || u.url} — ${u.url}`)
              .join('\n')}\n\nIf one of them is in fact the venue, paste its link and I will read it.`
          : '',
        '',
        '**Reply in the box below this answer** with either:',
        "- a direct link to the venue's call-for-papers or author-instructions page (an HTML page — PDFs cannot be fetched), or",
        '- the guidelines themselves, pasted in — page limit, anonymity, template, citation style. This is the reliable route: I use the text verbatim and fetch nothing.',
        '',
        `If ${resolved.display} is not a real venue, send a new request with a different target conference instead.`,
        '',
        'Nothing has been written to the knowledge base.',
      ].join('\n')

  tracer.addDeterministic(
    MODULES.PROFILER,
    {
      system:
        'Check the cache. On a miss, do not ingest — propose a source and return a confirmation request for the user.',
      user: `Profile ${resolved.display} (venue_id=${resolved.venue_id}).`,
    },
    {
      cache_hit: false,
      wrote_to_knowledge_base: false,
      venue: resolved.display,
      proposed_url: proposed,
      search_engine: searchEngine,
      web_search: searchNote,
      awaiting_reply: true,
      ask_user: question,
    },
  )

  return { kind: 'ask_user', question }
}

/**
 * Orders search hits by how likely they are to be readable submission rules.
 *
 * Two things decide it: `web_fetch` refuses PDFs, so a PDF can never be the
 * proposal however good a match it is, and the concrete rules live on the author
 * guide rather than on the topic-and-dates call-for-papers.
 */
const GUIDE_WORDS = /author|instruction|guide|format|submission|camera.?ready|call.?for.?paper|cfp/i
const VENUE_WORDS = /conference|symposium|workshop|proceedings|openreview|acm\b|ieee|springer|usenix/i
const AGGREGATORS = /wikicfp|github|reddit|zhihu|baidu|quora|x\.com|twitter|facebook|linkedin|medium\.com|wikipedia/i
/**
 * Catalogues that list thousands of venues. They rank well for a venue's name
 * and never state its submission rules, so they are listed for the author but
 * never proposed — from a datacenter these are much of what Bing returns.
 */
const VENUE_INDEXES =
  /dl\.acm\.org|ieeexplore|link\.springer|dblp|semanticscholar|researchgate|academia\.edu|conference-schedule|paperpilot|deadlines?\b|guide2research|core\.edu\.au/i
/** Side tracks whose rules are not the ones a full paper is submitted under. */
const SIDE_TRACKS = /art.?paper|art.?gallery|poster|course|doctoral|consortium|demo|panel|keynote|showcase|festival/i

/**
 * Both phrasings are issued, because neither wins on both engines. The terse
 * form is what surfaces a sub-conference on DuckDuckGo — `asia.siggraph.org`
 * rather than the parent's guidelines — while the keyword-heavy form is what gets
 * Bing past the venue's homepage to its author-instructions page, and Bing is
 * the engine that answers from a datacenter. Queries cost no tokens, so we take
 * the union and let the ranker decide.
 */
const QUERY_FORMS: ((venue: string) => string)[] = [
  (v) => `${v} author guidelines paper submission`,
  (v) => `${v} author guide formatting instructions page limit anonymous submission`,
]

/** Round-robin union of several searches, keeping each result's best rank. */
function mergeHits(hits: { meta?: Record<string, unknown> }[]): { title: string; url: string }[] {
  const lists = hits.map((h) => (h.meta?.results as { title: string; url: string }[] | undefined) ?? [])
  const merged: { title: string; url: string }[] = []
  const seen = new Set<string>()
  for (let rank = 0; ; rank++) {
    if (lists.every((l) => rank >= l.length)) break
    for (const list of lists) {
      const hit = list[rank]
      if (!hit || seen.has(hit.url)) continue
      seen.add(hit.url)
      merged.push(hit)
    }
  }
  return merged
}

function rankCandidates(
  results: { title: string; url: string }[],
  tokens: string[],
): { title: string; url: string }[] {
  return results
    .filter((r) => !/\.pdf($|[?#])/i.test(r.url))
    .map((r, i) => {
      const target = `${r.url} ${r.title}`
      const score =
        (AGGREGATORS.test(r.url) ? 4 : 0) + (GUIDE_WORDS.test(target) ? 0 : 2) + (SIDE_TRACKS.test(target) ? 1 : 0)
      return { r, coverage: nameCoverage(r, tokens), score, i }
    })
    // Name coverage outranks everything: for SIGGRAPH Asia, the parent
    // conference's own author-instructions page is a better-looking document and
    // the wrong venue.
    .sort((a, b) => b.coverage - a.coverage || a.score - b.score || a.i - b.i)
    .map((x) => x.r)
}

/** Words that carry no identity — every venue is an international conference. */
const NAME_NOISE = new Set([
  'the', 'and', 'for', 'of', 'on', 'in', 'at',
  'conference', 'conf', 'symposium', 'workshop', 'congress', 'meeting', 'proceedings',
  'international', 'annual', 'joint', 'acm', 'ieee', 'association', 'society',
])

/** The distinctive words of a venue name: "siggraph", "asia" — not "conference". */
function venueTokens(display: string): string[] {
  const words = display.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []
  return [...new Set(words)].filter((w) => !NAME_NOISE.has(w))
}

/** True for `https://www.siggraph.org/`, false for `…/author-instructions/`. */
function isLandingPage(url: string): boolean {
  try {
    const { pathname, search } = new URL(url)
    return !search && pathname.replace(/\/+$/, '') === ''
  } catch {
    return false
  }
}

/** Fraction of the venue's distinctive words this hit actually mentions. */
function nameCoverage(r: { title: string; url: string }, tokens: string[]): number {
  if (!tokens.length) return 1
  const target = `${r.url} ${r.title}`.toLowerCase()
  return tokens.filter((t) => target.includes(t)).length / tokens.length
}

/**
 * Could this hit plausibly be an academic venue's own page?
 *
 * A search for a venue that does not exist still returns six confident results —
 * for "Zephyr Symposium 2031", a kitchen-appliance shop; Bing has offered pizza
 * delivery for a Eurographics query. Asking the author to approve reading that
 * wastes their turn and makes the gate look credulous.
 *
 * Two independent tests, both cheap. The hit must name most of what makes the
 * venue that venue — so `siggraph.org` cannot stand in for SIGGRAPH *Asia* — and
 * it must carry submission-guide or venue vocabulary, or an edition year in the
 * URL (`s2026.siggraph.org`, `sigbovik.org/2025/`), which a shopfront rarely has.
 */
function looksLikeVenuePage(r: { title: string; url: string }, tokens: string[]): boolean {
  const target = `${r.url} ${r.title}`
  if (nameCoverage(r, tokens) < 2 / 3) return false
  if (VENUE_INDEXES.test(r.url) || AGGREGATORS.test(r.url)) return false
  // A bare landing page cannot hold submission rules, and proposing one costs
  // the author a round trip to find that out. Bing from a datacenter returns
  // little else, so this is the common production case, not an edge case.
  if (isLandingPage(r.url) && !GUIDE_WORDS.test(target)) return false
  // No \b before the year: the commonest conference host glues it to letters
  // (`s2026.siggraph.org`, `cvpr2027.thecvf.com`), where \b never matches.
  return GUIDE_WORDS.test(target) || VENUE_WORDS.test(target) || /(?<!\d)20\d{2}(?!\d)/.test(r.url)
}

/**
 * A fetch observation, with the page's own guide links appended.
 *
 * A landing page states no rules but almost always links to them, and the ReAct
 * agent cannot follow a link it never sees.
 */
function withLinks(result: { content: string; meta?: Record<string, unknown> }): string {
  const links = (result.meta?.links as string[] | undefined) ?? []
  return links.length
    ? `${result.content}\n\n[Links on this page that may hold the submission rules: ${links.join(', ')}]`
    : result.content
}

/** RAG grounding: retrieve venue passages relevant to this specific paper. */
async function ground(profile: ConferenceProfile, topic: string): Promise<string[]> {
  if (!topic.trim()) return []
  try {
    const matches = await search(profile.venue_id, topic, 3)
    return matches.map((m) => m.text)
  } catch (e) {
    console.warn('[profiler] grounding retrieval failed:', (e as Error).message)
    return []
  }
}

async function indexSeed(resolved: ResolvedVenue): Promise<void> {
  try {
    // No early return on an existing namespace: this only runs when the profile
    // is being derived from a seed, which means the seed is new or its version
    // stamp changed. Record ids are stable, so the upsert refreshes the passages
    // in place rather than duplicating them — otherwise a corrected corpus would
    // never reach a venue that had already been indexed once.
    const records = seedCorpus(resolved)
    if (records.length) {
      await upsertChunks(
        resolved.venue_id,
        records.map((r) => ({ id: r.id, text: r.text, kind: 'cfp' as const, source: r.source })),
      )
    }
  } catch (e) {
    console.warn('[profiler] seed indexing failed:', (e as Error).message)
  }
}

/**
 * Why an ingestion did not produce a profile. The two cases need different
 * advice: `unreadable` means the page could not be fetched or held no text,
 * `no_rules` means it was read fine and simply is not the author instructions.
 */
type ProfileAttempt =
  | { profile: ConferenceProfile; reason?: undefined }
  | { profile: null; reason: 'unreadable' | 'no_rules' }

/**
 * ReAct ingestion, only ever reached after the user approved it.
 * Fetch → embed into Pinecone → synthesise the profile → persist to Supabase.
 */
async function ingest(
  input: ProfilerInput,
  resolved: ResolvedVenue,
  startUrl: string,
): Promise<ProfileAttempt> {
  const { tracer, store } = input
  const observations: string[] = []
  let sourceUrl = startUrl

  // Seed the loop with the approved URL so the first ReAct step already has
  // something to reason about — one fewer model call.
  if (startUrl) {
    const fetched = await callTool('web_fetch', { url: startUrl, max_chars: config.limits.maxCfpChars })
    observations.push(`web_fetch(${startUrl}) → ${fetched.ok ? withLinks(fetched) : `FAILED: ${fetched.content}`}`)
  }

  for (let i = 0; i < config.agents.reactMaxIters; i++) {
    // Length alone is a poor signal: a call-for-papers can run for pages
    // without stating a single formatting rule. Require the rules to be there.
    const gathered = observations.filter((o) => !o.includes('FAILED')).join(' ')
    const enough =
      gathered.length > 800 &&
      /\bpage limit\b|\bpages?\b.{0,40}\blimit\b|\b\d+\s*pages?\b/i.test(gathered) &&
      /anonym|double.blind|single.blind/i.test(gathered)
    if (enough) break

    const decision = await tracer.callJsonSoft<{ thought?: string; action?: string; action_input?: string }>(
      MODULES.PROFILER,
      {
        system: PROFILER_SYSTEM_REACT,
        user: `Venue: ${resolved.display}\nSteps remaining: ${config.agents.reactMaxIters - i}\nObservations so far:\n${
          observations.join('\n\n').slice(0, 4000) || '(none yet)'
        }`,
        // Room for a reasoning model's hidden tokens as well as the decision
        // itself: a budget too tight truncates the JSON, and a half-written
        // action is indistinguishable from no answer at all.
        maxTokens: 700,
        mock: { thought: 'mock', action: 'finish', action_input: '' },
      },
    )

    // No readable decision — stop reasoning and synthesise from what was
    // already fetched, rather than failing a run that has usable observations.
    if (!decision || decision.action === 'finish' || !decision.action) break
    if (decision.action === 'web_fetch' && !/^https?:\/\//i.test(decision.action_input ?? '')) break

    const args =
      decision.action === 'web_fetch'
        ? { url: decision.action_input ?? '', max_chars: config.limits.maxCfpChars }
        : { query: decision.action_input ?? resolved.display }
    const result = await callTool(decision.action, args)
    if (decision.action === 'web_fetch' && result.ok) sourceUrl = String(result.meta?.url ?? sourceUrl)
    observations.push(
      `${decision.action}(${decision.action_input}) → ${result.ok ? withLinks(result) : `FAILED: ${result.content}`}`,
    )
  }

  const usable = observations.filter((o) => !o.includes('FAILED')).join('\n\n')
  return synthesiseProfile(input, resolved, usable, sourceUrl)
}

/**
 * Index the venue text, turn it into a ConferenceProfile, persist it.
 *
 * Shared by both ingestion routes — a CFP the agent fetched and guidelines the
 * author pasted — so a pasted profile is cached, retrievable and checkable in
 * exactly the same way as a fetched one.
 */
async function synthesiseProfile(
  input: ProfilerInput,
  resolved: ResolvedVenue,
  text: string,
  sourceUrl: string | null,
): Promise<ProfileAttempt> {
  const { tracer, store } = input
  const usable = text.trim()
  if (usable.length < 200) return { profile: null, reason: 'unreadable' }
  const provenance = sourceUrl ?? 'pasted by the author'

  // Index the CFP so rules_lookup and framing grounding work next time.
  try {
    const chunks = chunk(usable.slice(0, config.limits.maxCfpChars))
    await upsertChunks(
      resolved.venue_id,
      chunks.map((t, i) => ({ id: `${resolved.venue_id}-cfp-${i}`, text: t, kind: 'cfp' as const, source: provenance })),
    )
  } catch (e) {
    console.warn('[profiler] CFP indexing failed:', (e as Error).message)
  }

  const synth = await tracer.callJson<{
    focus_areas?: string[]
    valued_criteria?: string[]
    accepted_paper_emphasis?: string[]
    format_rules?: Partial<FormatRules>
  }>(MODULES.PROFILER, {
    system: PROFILER_SYSTEM_SYNTH,
    user: `Venue: ${resolved.display}\nSource: ${provenance}\n\nObservations:\n${usable.slice(0, config.limits.maxCfpChars)}`,
    // Enough for the full object plus a reasoning model's hidden tokens: a
    // truncated profile would silently lose the rules written last.
    maxTokens: 1600,
    mock: {
      focus_areas: ['(mock) venue focus'],
      valued_criteria: ['(mock) rigour'],
      accepted_paper_emphasis: ['(mock) emphasis'],
      format_rules: {
        page_limit: 8,
        references_in_limit: false,
        abstract_word_limit: null,
        abstract_single_paragraph: null,
        anonymous: true,
        citation_style: 'author-year',
        template: '(mock) official template',
        template_spec: null,
        required_sections: [],
        recommended_sections: [],
        unresolved: [],
      },
    },
  })

  const rules = synth.format_rules ?? {}
  const profile: ConferenceProfile = {
    venue_id: resolved.venue_id,
    venue: resolved.display,
    focus_areas: arr(synth.focus_areas),
    valued_criteria: arr(synth.valued_criteria),
    accepted_paper_emphasis: arr(synth.accepted_paper_emphasis),
    format_rules: {
      page_limit: numOrNull(rules.page_limit),
      references_in_limit: typeof rules.references_in_limit === 'boolean' ? rules.references_in_limit : null,
      abstract_word_limit: numOrNull(rules.abstract_word_limit),
      abstract_single_paragraph:
        typeof rules.abstract_single_paragraph === 'boolean' ? rules.abstract_single_paragraph : null,
      anonymous: typeof rules.anonymous === 'boolean' ? rules.anonymous : null,
      citation_style:
        rules.citation_style === 'numeric' || rules.citation_style === 'author-year' ? rules.citation_style : 'unknown',
      template: typeof rules.template === 'string' && rules.template ? rules.template : null,
      template_spec: templateSpec(rules.template_spec),
      required_sections: arr(rules.required_sections),
      recommended_sections: arr(rules.recommended_sections),
      unresolved: arr(rules.unresolved),
    },
    source: sourceUrl ? 'ingested' : 'provided',
    source_url: sourceUrl,
    updated_at: new Date().toISOString(),
  }

  /*
   * A page that states no rule at all must not become a cached profile.
   * Measured in production: the only search engine reachable from the server
   * proposes venue homepages, and ingesting one yielded a profile whose every
   * field was unknown — which would then be served from cache forever, with no
   * gate left to correct it. Refusing it keeps the approval open instead.
   */
  if (!statesAnyRule(profile)) {
    console.warn(`[profiler] ${provenance} stated no submission rules; not caching a profile for ${resolved.venue_id}`)
    return { profile: null, reason: 'no_rules' }
  }

  await store.putProfile(profile)
  return { profile }
}

/** Did the source actually yield something a format check could test? */
function statesAnyRule(p: ConferenceProfile): boolean {
  const r = p.format_rules
  return (
    r.page_limit !== null ||
    r.anonymous !== null ||
    r.abstract_word_limit !== null ||
    r.template !== null ||
    r.citation_style !== 'unknown' ||
    r.required_sections.length > 0
  )
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 6) : []
}

/** Accepts a template spec only when it names a style package worth checking. */
function templateSpec(v: unknown): TemplateSpec | null {
  if (!v || typeof v !== 'object') return null
  const t = v as Partial<TemplateSpec>
  const style = typeof t.style_package === 'string' && t.style_package.trim() ? t.style_package.trim() : null
  const bib = typeof t.bibliography_style === 'string' && t.bibliography_style.trim() ? t.bibliography_style.trim() : null
  // With neither a style package nor a bibliography style there is nothing the
  // preamble checks could test, so keep it null rather than half-populated.
  if (!style && !bib) return null
  return {
    style_package: style?.replace(/\.sty$/i, '') ?? null,
    bibliography_style: bib?.replace(/\.bst$/i, '') ?? null,
    deanonymising_options: arr(t.deanonymising_options),
    forbidden_macros: arr(t.forbidden_macros),
    forbids_layout_override: t.forbids_layout_override === true,
    template_url: typeof t.template_url === 'string' && t.template_url.trim() ? t.template_url.trim() : null,
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}
