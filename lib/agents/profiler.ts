import { config } from '../config'
import { MODULES } from '../modules'
import {
  SEED_AS_OF,
  guessCfpUrl,
  guideUrlHint,
  profileFromSeed,
  resolveVenue,
  seedCorpus,
  seedFor,
  type ResolvedVenue,
} from '../seed/venues'
import type { Store } from '../store'
import { selectRulePassages } from '../guidelines'
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
  /** How to describe that source in the answer, e.g. "2 uploaded files: a.pdf, b.pdf". */
  providedGuidelinesLabel: string | null
  /** The author answered the gate with `baseline`: use the built-in rules as-is. */
  useBaseline: boolean
  originalPrompt: string
  task: Task
}

export type ProfilerOutput =
  | {
      kind: 'profile'
      profile: ConferenceProfile
      grounding: string[]
      /**
       * Set when the profile was just read out of a source the author supplied
       * and is being used for this run only. The Supervisor turns it into the
       * save gate at the end of the answer: the rules are visible in the report
       * above it, so the author decides to keep them knowing what they say.
       */
      offerToSave?: { venue: string; source: string }
    }
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

    // The author chose the built-in baseline for another edition, knowing what it
    // is. Deterministic and free — no fetch, no synthesis call.
    if (input.useBaseline) {
      const forced = profileFromSeed(pendingVenue, true)
      if (!forced) {
        return {
          kind: 'declined',
          message: `I have no built-in baseline for **${pending.venue}**, so there is nothing to fall back on. Send a link, attach the guidelines, or paste the rules.`,
        }
      }
      const seed = seedFor(pendingVenue.family)
      const profile: ConferenceProfile = {
        ...forced,
        source_note: `built-in ${seed?.display ?? pendingVenue.display} baseline from the ${seed?.rules_year} edition, used for ${pending.venue} at your request`,
      }
      tracer.addDeterministic(
        MODULES.PROFILER,
        {
          system:
            'The author accepted the built-in baseline for a different edition. It is used as-is; no source is fetched and no rule is invented.',
          user: `Use the ${seed?.display} ${seed?.rules_year} baseline for ${pending.venue}.`,
        },
        { gate: 'source', decision: 'baseline', venue: pending.venue, baseline_year: seed?.rules_year, profile },
      )
      return finishWithSaveGate(input, pending, profile, (seedCorpus(pendingVenue) ?? []).map((c) => c.text).join('\n\n'))
    }

    // The author pasted the rules themselves. This is the path that always
    // works: no venue site has to be reachable, readable or even public.
    if (input.providedGuidelines) {
      const attempt = await synthesiseProfile(input, pendingVenue, input.providedGuidelines, null)
      if (!attempt.profile) {
        return {
          kind: 'declined',
          message:
            attempt.reason === 'no_rules'
              ? `I read what you sent, but it states no submission rules — no page limit, anonymity policy, template or citation style — so there is nothing for me to check your paper against. Send the part of the author instructions that states them; **${pending.venue}** is still waiting.`
              : `I could not read usable text out of what you sent. If it was a scanned PDF there is no text layer to read; paste the rules in as text instead. **${pending.venue}** is still waiting.`,
        }
      }
      return finishWithSaveGate(input, pending, attempt.profile, attempt.sourceText)
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
    return finishWithSaveGate(input, pending, attempt.profile, attempt.sourceText)
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

  // ── Cache miss: ask the author for the source. Never go looking ────────────
  /*
   * ConfFit used to search the web here and offer what it found. Measured
   * against the deployed server, that is not a capability: the only search
   * engine reachable from Vercel answered "SIGGRAPH 2027 author guidelines" with
   * genealogy forums and a supermarket, and on a better day it offered the
   * parent conference's rules for a sub-conference — plausible, authoritative
   * looking, and wrong. A wrong page produces a confident profile, so the
   * cheapest correct move is to ask the one person who knows which document
   * governs their submission.
   */
  const proposed = input.providedUrl ?? guessCfpUrl(resolved, input.venueRaw)
  /*
   * A built-in baseline for this family exists but was read from a different
   * edition. It is offered, never assumed: page limits and anonymity policies
   * change between editions, and answering a 2027 request with 2026's rules
   * under the 2027 name is the confident-but-wrong failure this gate exists to
   * prevent.
   */
  const otherEdition = resolved.family ? seedFor(resolved.family) : null
  const hint = guideUrlHint(resolved.family, resolved.year)

  await store.putPending({
    session_id: sessionId,
    venue: resolved.display,
    venue_id: resolved.venue_id,
    proposed_url: proposed ?? '',
    original_prompt: input.originalPrompt,
    task: input.task,
    created_at: new Date().toISOString(),
    kind: 'source',
  })

  const question = [
    `I don't have guidelines for **${resolved.display}** in the knowledge base, and I do not go looking for them on the web — a page I picked myself could be the wrong venue, the wrong year or the wrong track, and you would get confident rules from it either way.`,
    '',
    otherEdition
      ? `I do have built-in **${otherEdition.display}** rules, but they were read from the ${otherEdition.rules_year} edition, and page limits and anonymity policies change between editions — so I will not answer for ${resolved.display} with them unless you tell me to.`
      : '',
    hint ? `${resolved.display} usually publishes its rules at ${hint} — paste that link if the page is up.` : '',
    '',
    `**Send me the source in the box below** — any one of:`,
    '',
    ...[
      proposed ? `- \`yes\` — read ${proposed}, the link you gave with the venue` : '',
      otherEdition
        ? `- \`baseline\` — use the built-in ${otherEdition.display} rules from ${otherEdition.rules_year} as they stand, and I will say so in the report`
        : '',
      proposed
        ? "- a different link to the venue's call-for-papers or author-instructions page"
        : "- a link to the venue's call-for-papers or author-instructions page (HTML or PDF)",
      '- **attach the guidelines** — PDF or text, several files if the rules are split across them',
      '- paste the rules straight in as text',
    ].filter(Boolean),
    '',
    'Nothing has been written to the knowledge base, and nothing will be until you have seen what I read out of the source.',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')

  tracer.addDeterministic(
    MODULES.PROFILER,
    {
      system:
        'Check the cache. On a miss, ask the author for the guidelines — a link, files, or pasted text. Never search for a source and never ingest one that was not given.',
      user: `Profile ${resolved.display} (venue_id=${resolved.venue_id}).`,
    },
    {
      cache_hit: false,
      wrote_to_knowledge_base: false,
      searched_the_web: false,
      venue: resolved.display,
      proposed_url: proposed,
      baseline_available: otherEdition ? `${otherEdition.display} ${otherEdition.rules_year}` : null,
      guide_url_hint: hint,
      gate: 'source',
      awaiting_reply: true,
      ask_user: question,
    },
  )

  return { kind: 'ask_user', question }
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

/**
 * Replaces the answered source gate with the save gate.
 *
 * The extracted profile and its text are parked in the pending row, so agreeing
 * to keep them later costs no fetch, no model call and no risk of a different
 * answer the second time.
 */
async function finishWithSaveGate(
  input: ProfilerInput,
  pending: PendingApproval,
  profile: ConferenceProfile,
  sourceText: string,
): Promise<ProfilerOutput> {
  const { store, sessionId } = input
  await store.putPending({
    ...pending,
    kind: 'save',
    profile,
    source_text: sourceText.slice(0, config.limits.maxCfpChars),
    created_at: new Date().toISOString(),
  })
  const grounding = await ground(profile, input.topic)
  return {
    kind: 'profile',
    profile,
    grounding,
    offerToSave: { venue: profile.venue, source: profile.source_url ?? profile.source_note ?? 'the source you sent' },
  }
}

/**
 * The only place a run writes venue knowledge — reached solely by the author
 * answering the save gate.
 *
 * Both halves happen together: the profile row that turns the next run into a
 * cache hit, and the passages that make rules_lookup and framing grounding work
 * for this venue. Indexing is best-effort; a profile without its passages is
 * still worth having, while passages without the profile would be invisible.
 */
export async function saveApprovedProfile(
  store: Store,
  profile: ConferenceProfile,
  sourceText: string,
): Promise<{ indexed: number }> {
  let indexed = 0
  try {
    const chunks = chunk(sourceText.slice(0, config.limits.maxCfpChars))
    indexed = await upsertChunks(
      profile.venue_id,
      chunks.map((text, i) => ({
        id: `${profile.venue_id}-cfp-${i}`,
        text,
        kind: 'cfp' as const,
        source: profile.source_url ?? profile.source_note ?? 'provided by the author',
      })),
    )
  } catch (e) {
    console.warn('[profiler] indexing the approved source failed:', (e as Error).message)
  }
  await store.putProfile(profile)
  return { indexed }
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
  | { profile: ConferenceProfile; sourceText: string; reason?: undefined }
  | { profile: null; sourceText?: undefined; reason: 'unreadable' | 'no_rules' }

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
  const { tracer } = input
  const usable = text.trim()
  if (usable.length < 200) return { profile: null, reason: 'unreadable' }
  const provenance = sourceUrl ?? input.providedGuidelinesLabel ?? 'provided by the author'

  /*
   * Nothing is indexed or stored here. The author is asked first, once they can
   * see what was actually read out of their source — so this function reads and
   * reasons, and only the save gate writes.
   */
  const forSynthesis = selectRulePassages(usable, config.limits.maxCfpChars)

  const synth = await tracer.callJson<{
    focus_areas?: string[]
    valued_criteria?: string[]
    accepted_paper_emphasis?: string[]
    format_rules?: Partial<FormatRules>
  }>(MODULES.PROFILER, {
    system: PROFILER_SYSTEM_SYNTH,
    user: `Venue: ${resolved.display}\nSource: ${provenance}\n\nObservations:\n${forSynthesis}`,
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
    source_note: sourceUrl ? null : (input.providedGuidelinesLabel ?? 'pasted by the author'),
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
    console.warn(`[profiler] ${provenance} stated no submission rules; no profile built for ${resolved.venue_id}`)
    return { profile: null, reason: 'no_rules' }
  }

  return { profile, sourceText: usable }
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
