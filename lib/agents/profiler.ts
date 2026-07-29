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
import type { ConferenceProfile, FormatRules, PendingApproval, Task } from '../types'

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
A bare call-for-papers is usually topics, dates and policies; the concrete formatting rules live on the venue's author guide / author instructions / formatting page. If the observations so far give you scope but no page limit, template or citation style, fetch that page next — search for "<venue> author guide formatting instructions" or try the CFP URL with CallForPapers replaced by AuthorGuide.
Choose "finish" as soon as the observations contain the venue's scope AND its submission rules (page limit, anonymity, citation style, template). Never take more than the allowed number of steps.`

const PROFILER_SYSTEM_SYNTH = `You are ConferenceProfiler. Turn the observations from a venue's Call-for-Papers into a structured profile.
Return a JSON object only, with exactly these keys:
{"focus_areas":[string],"valued_criteria":[string],"accepted_paper_emphasis":[string],
 "format_rules":{"page_limit":number|null,"references_in_limit":boolean|null,"abstract_word_limit":number|null,
                 "anonymous":boolean|null,"citation_style":"numeric"|"author-year"|"unknown",
                 "template":string|null,"required_sections":[string],"recommended_sections":[string],"unresolved":[string]}}
Rules: use null and "unknown" for anything the observations do not state — never guess a page limit or a review model. List every rule you could not determine in "unresolved". Keep each list to at most 5 short entries.
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
    const url = input.providedUrl ?? pending.proposed_url
    const profile = await ingest(input, { venue_id: pending.venue_id, display: pending.venue, family: resolveVenue(pending.venue).family, year: null }, url)
    await store.clearPending(sessionId, pending.venue_id)
    if (!profile) {
      return {
        kind: 'declined',
        message: `I could not read a Call-for-Papers at ${url}. Paste a direct link to the venue's HTML call-for-papers or author guidelines page and I will try again.`,
      }
    }
    const grounding = await ground(profile, input.topic)
    return { kind: 'profile', profile, grounding }
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
  let alternatives: { title: string; url: string }[] = []
  if (!proposed) {
    const hit = await callTool('web_search', {
      query: `${resolved.display} author guide formatting instructions page limit anonymous submission`,
    })
    const results = (hit.meta?.results as { title: string; url: string }[] | undefined) ?? []
    proposed = results[0]?.url ?? null
    alternatives = results.slice(1, 4)
    searchNote = hit.ok ? hit.content : 'web_search returned no candidates.'
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
    ? `\n\nOther candidates I found, if that one is wrong:\n${alternatives.map((a) => `- ${a.url}`).join('\n')}`
    : ''

  const question = proposed
    ? `I don't have guidelines for **${resolved.display}** in the knowledge base yet.\n\nMay I fetch ${proposed} and add it? Reply **yes** to approve, or paste the correct Call-for-Papers link.${altBlock}\n\nNothing has been written to the knowledge base.`
    : `I don't have guidelines for **${resolved.display}** in the knowledge base, and I could not find a Call-for-Papers page for it.\n\nPaste the direct link to the venue's call-for-papers or author-guidelines page and I will read it.\n\nNothing has been written to the knowledge base.`

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
      proposed_url: proposed,
      web_search: searchNote,
      ask_user: question,
    },
  )

  return { kind: 'ask_user', question }
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
 * ReAct ingestion, only ever reached after the user approved it.
 * Fetch → embed into Pinecone → synthesise the profile → persist to Supabase.
 */
async function ingest(
  input: ProfilerInput,
  resolved: ResolvedVenue,
  startUrl: string,
): Promise<ConferenceProfile | null> {
  const { tracer, store } = input
  const observations: string[] = []
  let sourceUrl = startUrl

  // Seed the loop with the approved URL so the first ReAct step already has
  // something to reason about — one fewer model call.
  if (startUrl) {
    const fetched = await callTool('web_fetch', { url: startUrl, max_chars: config.limits.maxCfpChars })
    observations.push(`web_fetch(${startUrl}) → ${fetched.ok ? fetched.content : `FAILED: ${fetched.content}`}`)
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

    const decision = await tracer.callJson<{ thought?: string; action?: string; action_input?: string }>(
      MODULES.PROFILER,
      {
        system: PROFILER_SYSTEM_REACT,
        user: `Venue: ${resolved.display}\nSteps remaining: ${config.agents.reactMaxIters - i}\nObservations so far:\n${
          observations.join('\n\n').slice(0, 4000) || '(none yet)'
        }`,
        maxTokens: 300,
        mock: { thought: 'mock', action: 'finish', action_input: '' },
      },
    )

    if (decision.action === 'finish' || !decision.action) break

    const args =
      decision.action === 'web_fetch'
        ? { url: decision.action_input ?? '', max_chars: config.limits.maxCfpChars }
        : { query: decision.action_input ?? resolved.display }
    const result = await callTool(decision.action, args)
    if (decision.action === 'web_fetch' && result.ok) sourceUrl = String(result.meta?.url ?? sourceUrl)
    observations.push(
      `${decision.action}(${decision.action_input}) → ${result.ok ? result.content : `FAILED: ${result.content}`}`,
    )
  }

  const usable = observations.filter((o) => !o.includes('FAILED')).join('\n\n')
  if (usable.trim().length < 200) return null

  // Index the fetched CFP so rules_lookup and framing grounding work next time.
  try {
    const chunks = chunk(usable.slice(0, config.limits.maxCfpChars))
    await upsertChunks(
      resolved.venue_id,
      chunks.map((text, i) => ({ id: `${resolved.venue_id}-cfp-${i}`, text, kind: 'cfp' as const, source: sourceUrl })),
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
    user: `Venue: ${resolved.display}\nSource: ${sourceUrl}\n\nObservations:\n${usable.slice(0, config.limits.maxCfpChars)}`,
    maxTokens: 900,
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
      required_sections: arr(rules.required_sections),
      recommended_sections: arr(rules.recommended_sections),
      unresolved: arr(rules.unresolved),
    },
    source: 'ingested',
    source_url: sourceUrl,
    updated_at: new Date().toISOString(),
  }

  await store.putProfile(profile)
  return profile
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 6) : []
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}
