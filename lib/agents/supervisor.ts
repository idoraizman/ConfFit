import { summariseChecks } from '../checks'
import { config } from '../config'
import { parseManuscript, parsePrompt, routerDigest, withSections } from '../manuscript'
import { looksUnparsed, recoverStructure } from './structure'
import { MODULES } from '../modules'
import { resolveVenue } from '../seed/venues'
import { getStore } from '../store'
import { Tracer } from '../trace'
import type { ExecuteResult, FormatReport, FramingReport, Route, Task } from '../types'
import { runFormatComplianceAgent } from './format'
import { runFramingAgent } from './framing'
import { runUnifiedFixer } from './fixer'
import { runConferenceProfiler } from './profiler'

/**
 * Supervisor — the thin coordinator.
 *
 * One routing decision at the start (which venue, which workers), one merge at
 * the end. Everything between is delegated. Splitting the manuscript, measuring
 * it and applying mechanical fixes happen in code, so the Supervisor spends
 * tokens only on the two decisions that actually need judgement.
 */

const ROUTE_SYSTEM = `You are the Supervisor of ConfFit, an agent that adapts a research paper to a target academic conference. Decide how to route one request.
Return a JSON object only:
{"in_scope":true|false,
 "target_conference":"<venue name as the user gave it, or null>",
 "task":"framing"|"format"|"both",
 "is_approval_reply":true|false,
 "provided_url":"<only a URL the user gave as the venue or its call-for-papers; null if the only URLs are inside the manuscript text>",
 "reason":"<why the request is out of scope, else null>"}
Guidance:
- in_scope is false only if the request has nothing to do with preparing or adapting an academic paper for a venue.
- "framing" = re-position the paper for the venue. "format" = check the submission rules. "both" when the user asks for both or does not say.
- is_approval_reply is true when the message is only approving a previous request to add a venue to the knowledge base (for example "yes", "go ahead", or a bare CFP link).`

const MERGE_SYSTEM = `You are the Supervisor of ConfFit. Write the opening summary of the agent's answer for the author.
You are given a compact digest of what the workers produced. Return a JSON object only:
{"summary":"<3-5 sentences: the single most important framing move, the count and nature of the format findings, and what was changed in the revised manuscript>"}
Be concrete and quantitative. Do not repeat the reports verbatim — they are printed below your summary. Do not invent findings.`

const APPROVAL_RE = /^\s*(y|yes|yep|yeah|ok|okay|sure|go ahead|approved?|do it|please do|confirm(ed)?)\b[\s.!]*$/i
const URL_ONLY_RE = /^\s*(https?:\/\/\S+)\s*$/i
/** An explicit label the author can put in front of pasted submission rules. */
const GUIDELINES_FIELD = /^[ \t]*(guidelines?|author\s+instructions?|rules?|cfp|call[\s-]for[\s-]papers?)\s*:/im
/** Vocabulary that separates pasted submission rules from a pasted manuscript. */
const RULE_WORDS = [
  /page limit|\b\d+\s*pages?\b/i,
  /anonym|double.blind|single.blind/i,
  /template|style file|\.sty\b|latex|word template/i,
  /citation|bibliograph|references?\b/i,
  /submission|submit|deadline|camera.ready|desk.reject/i,
  /abstract.{0,20}\b(words?|limit)\b/i,
]

/** A line naming the target venue — the mark of a fresh request, not a reply. */
const VENUE_LINE = /^\s*(target\s+)?(conference|venue)\s*:/im
/** Headings that make a paste a manuscript rather than a set of rules. */
const MANUSCRIPT_SHAPE = [/^\s*abstract\b/im, /^\s*(references|bibliography)\b/im]

/**
 * Recognises a reply that *is* the venue's guidelines rather than a new request.
 *
 * Deterministic on purpose: this decision costs no tokens, and the caller only
 * acts on it when a pending approval actually exists, so a manuscript pasted out
 * of turn still routes normally. Real author instructions are often written as
 * `Page limit: 8` field lines, so the test is not "does this parse as the prompt
 * template" — it is "does it name a venue (a new request), does it read like a
 * paper, and does it talk about submission rules".
 */
function pastedGuidelines(prompt: string): string | null {
  const labelled = prompt.match(GUIDELINES_FIELD)
  if (labelled) {
    const body = prompt.slice((labelled.index ?? 0) + labelled[0].length).trim()
    return body.length >= 200 ? body : null
  }
  const text = prompt.trim()
  if (text.length < 200 || text.length > 60_000) return null
  if (VENUE_LINE.test(text)) return null
  if (MANUSCRIPT_SHAPE.every((re) => re.test(text))) return null
  const hits = RULE_WORDS.filter((re) => re.test(text)).length
  return hits >= 3 ? text : null
}

export async function execute(rawPrompt: string, sessionId: string): Promise<ExecuteResult> {
  const tracer = new Tracer()
  const store = getStore()

  const prompt = (rawPrompt ?? '').trim()
  if (!prompt) {
    return { status: 'error', error: 'The "prompt" field is required and must be a non-empty string.', response: null, steps: [] }
  }
  if (prompt.length > config.limits.maxPromptChars) {
    return {
      status: 'error',
      error: `The prompt is ${prompt.length} characters; the limit is ${config.limits.maxPromptChars}. Send the main body of the paper without the appendix.`,
      response: null,
      steps: [],
    }
  }

  try {
    return await run(tracer, store, prompt, sessionId)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[execute] failed:', e)
    return { status: 'error', error: message, response: null, steps: tracer.steps }
  }
}

async function run(
  tracer: Tracer,
  store: ReturnType<typeof getStore>,
  prompt: string,
  sessionId: string,
): Promise<ExecuteResult> {
  const parsed = parsePrompt(prompt)

  // ── Route ──────────────────────────────────────────────────────────────────
  // A bare approval needs no model call: the architecture's own trace for this
  // turn starts at ConferenceProfiler.
  const bareApproval = APPROVAL_RE.test(prompt) || URL_ONLY_RE.test(prompt)
  // A long paste is only guidelines if the gate is actually waiting for them.
  const guidelines = bareApproval ? null : pastedGuidelines(prompt)
  const answeringGate = bareApproval || (guidelines !== null && (await store.findPending(sessionId, null)) !== null)
  let route: Route
  let providedGuidelines: string | null = null

  if (answeringGate) {
    const url = prompt.match(URL_ONLY_RE)?.[1] ?? null
    providedGuidelines = bareApproval ? null : guidelines
    route = { target_conference: null, task: 'both', is_approval_reply: true, provided_url: url, notes: null }
    tracer.addDeterministic(
      MODULES.SUPERVISOR,
      {
        system:
          'Route the incoming request. A reply to the human-in-the-loop gate — an approval, a link, or the guidelines themselves — is recognised in code and resumes the pending ingestion.',
        user: prompt.slice(0, 200),
      },
      {
        is_approval_reply: true,
        provided_url: url,
        provided_guidelines_chars: providedGuidelines?.length ?? 0,
        dispatch: [MODULES.PROFILER],
      },
    )
  } else {
    const decision = await tracer.callJson<{
      in_scope?: boolean
      target_conference?: string | null
      task?: string
      is_approval_reply?: boolean
      provided_url?: string | null
      reason?: string | null
    }>(MODULES.SUPERVISOR, {
      system: ROUTE_SYSTEM,
      user: routerDigest(prompt, parsed),
      maxTokens: 250,
      mock: {
        in_scope: true,
        target_conference: parsed.target_conference ?? 'ICLR 2027',
        task: parsed.task ?? 'both',
        is_approval_reply: false,
        provided_url: null,
        reason: null,
      },
    })

    if (decision.in_scope === false) {
      return {
        status: 'ok',
        response: outOfScope(decision.reason ?? null),
        error: null,
        steps: tracer.steps,
      }
    }

    route = {
      // The template is authoritative when the user filled it in — the model
      // only fills the gaps.
      target_conference: parsed.target_conference ?? decision.target_conference ?? null,
      task: normaliseTask(parsed.task ?? decision.task),
      is_approval_reply: Boolean(decision.is_approval_reply),
      provided_url: decision.provided_url ?? null,
      notes: parsed.notes,
    }
  }

  // ── Resolve the manuscript and the venue ───────────────────────────────────
  let paperText = parsed.paper
  let task: Task = route.task
  let venueRaw = route.target_conference ?? ''

  if (route.is_approval_reply) {
    const pending = await store.findPending(sessionId, venueRaw ? resolveVenue(venueRaw).venue_id : null)
    if (!pending) {
      return { status: 'ok', response: noPendingApproval(), error: null, steps: tracer.steps }
    }
    const original = parsePrompt(pending.original_prompt)
    paperText = original.paper || pending.original_prompt
    task = pending.task
    venueRaw = pending.venue
  }

  if (!venueRaw.trim()) {
    return { status: 'ok', response: needVenue(), error: null, steps: tracer.steps }
  }
  if (!paperText.trim() && !route.is_approval_reply) {
    return { status: 'ok', response: needPaper(venueRaw), error: null, steps: tracer.steps }
  }

  // Deterministic pre-processing — no tokens spent on parsing.
  // Truncation is reported rather than applied silently: a cut manuscript loses
  // its reference list, which would make the format report quietly wrong.
  const truncatedChars = Math.max(0, paperText.length - config.limits.maxManuscriptChars)
  let manuscript = parseManuscript(paperText.slice(0, config.limits.maxManuscriptChars))

  // Only when code could not find the paper's shape at all — typically text
  // copied out of a rendered PDF — spend one call to recover it.
  let structureRecovered = false
  if (looksUnparsed(manuscript)) {
    const sections = await recoverStructure(tracer, manuscript)
    if (sections.length) {
      manuscript = withSections(manuscript, sections)
      structureRecovered = true
    }
  }
  const topic = [manuscript.title, manuscript.abstract].filter(Boolean).join('. ').slice(0, 400)

  // ── ConferenceProfiler ─────────────────────────────────────────────────────
  const profiled = await runConferenceProfiler({
    tracer,
    store,
    sessionId,
    venueRaw,
    topic,
    isApprovalReply: route.is_approval_reply,
    providedUrl: route.provided_url,
    providedGuidelines,
    originalPrompt: prompt,
    task,
  })

  if (profiled.kind === 'ask_user') {
    return { status: 'ok', response: profiled.question, error: null, steps: tracer.steps }
  }
  if (profiled.kind === 'declined') {
    return { status: 'ok', response: profiled.message, error: null, steps: tracer.steps }
  }

  const { profile, grounding } = profiled

  // ── Dispatch the workers the route selected ────────────────────────────────
  let framing: FramingReport | null = null
  let format: FormatReport | null = null
  let workingText = manuscript.raw

  if (task === 'framing' || task === 'both') {
    framing = await runFramingAgent({ tracer, manuscript, profile, grounding, notes: route.notes })
  }
  if (task === 'format' || task === 'both') {
    const out = await runFormatComplianceAgent({ tracer, manuscript, profile })
    format = out.report
    workingText = out.mechanicallyFixed
  }

  // ── UnifiedFixer ───────────────────────────────────────────────────────────
  const fixed = await runUnifiedFixer({ tracer, text: workingText, original: manuscript, framing, format })

  // ── Merge ──────────────────────────────────────────────────────────────────
  const counts = format ? summariseChecks(format.checklist) : null
  const merge = await tracer.callJson<{ summary?: string }>(MODULES.SUPERVISOR, {
    system: MERGE_SYSTEM,
    user: JSON.stringify({
      venue: profile.venue,
      task,
      framing: framing
        ? {
            angle: framing.proposal.angle,
            new_title: framing.proposal.suggested_title,
            reflection_iterations: framing.iterations,
            critic_verdict: framing.critique.verdict,
            unresolved_concerns: framing.critique.cons.slice(0, 3),
          }
        : null,
      format: format ? { counts, failures: format.checklist.filter((c) => c.status === 'fail').map((c) => c.rule) } : null,
      revision: { changes: fixed.applied.slice(0, 8), fixer_summary: fixed.summary },
    }),
    maxTokens: 400,
    mock: { summary: '(mock) Supervisor summary.' },
  })

  const response = renderResponse({
    venue: profile.venue,
    truncatedChars,
    structureRecovered,
    profileNote: profileNote(profile),
    summary: typeof merge.summary === 'string' && merge.summary.trim() ? merge.summary.trim() : fallbackSummary(counts, framing),
    framing,
    format,
    fixed: fixed.fixed,
    fixerSummary: fixed.summary,
    applied: fixed.applied,
    skipped: fixed.skipped,
    usage: tracer.usage.snapshot(),
  })

  await store.recordRun({
    session_id: sessionId,
    venue_id: profile.venue_id,
    task,
    usage: tracer.usage.snapshot(),
  })

  return { status: 'ok', response, error: null, steps: tracer.steps }
}

// ─── Response rendering (deterministic, no tokens) ───────────────────────────

function renderResponse(a: {
  venue: string
  truncatedChars: number
  structureRecovered: boolean
  profileNote: string
  summary: string
  framing: FramingReport | null
  format: FormatReport | null
  fixed: string
  fixerSummary: string
  applied: string[]
  skipped: string[]
  usage: { llm_calls: number; prompt_tokens: number; completion_tokens: number }
}): string {
  const out: string[] = [`# ConfFit — ${a.venue}`, '', a.summary, '', a.profileNote]

  if (a.structureRecovered) {
    out.push(
      '',
      'ℹ️ **Section structure was inferred.** The manuscript arrived without detectable headings — typical of text copied out of a PDF — so the section boundaries below were recovered by the model rather than read off the source. Section-level findings are best-effort; paste the LaTeX or markdown source for exact results.',
    )
  }

  if (a.truncatedChars > 0) {
    const kept = Math.round(config.limits.maxManuscriptChars / 1000)
    const dropped = Math.round(a.truncatedChars / 1000)
    out.push(
      '',
      `⚠️ **Manuscript was truncated.** ConfFit read the first ${kept}k characters and dropped the last ${dropped}k. Anything past that point was not checked — very likely including the reference list, so the citation-style and references findings below are unreliable. Resend without the appendix.`,
    )
  }

  if (a.framing) {
    const p = a.framing.proposal
    const c = a.framing.critique
    out.push(
      '',
      '## Framing report',
      '',
      `**Angle.** ${p.angle}`,
      '',
      p.foreground.length ? `**Lead with**\n${p.foreground.map((x) => `- ${x}`).join('\n')}` : '',
      p.background.length ? `\n**De-emphasise**\n${p.background.map((x) => `- ${x}`).join('\n')}` : '',
      '',
      `**Suggested title.** ${p.suggested_title}`,
      '',
      `**Suggested abstract.**\n\n${p.suggested_abstract}`,
      '',
      `**Suggested introduction opening.**\n\n${p.intro_opening}`,
      '',
      `**Why this fits ${a.venue}.** ${p.rationale}`,
      '',
      `### Reflection pass (${a.framing.iterations} generate ${a.framing.iterations === 1 ? 'round' : 'rounds'}, critic verdict: ${c.verdict})`,
      '',
      c.critique,
      c.pros.length ? `\n**Strengths**\n${c.pros.map((x) => `- ${x}`).join('\n')}` : '',
      c.cons.length ? `\n**Remaining concerns**\n${c.cons.map((x) => `- ${x}`).join('\n')}` : '',
      c.unsupported_claims.length
        ? `\n**Claims the paper does not support (removed or flagged)**\n${c.unsupported_claims.map((x) => `- ${x}`).join('\n')}`
        : '',
    )
  }

  if (a.format) {
    const counts = summariseChecks(a.format.checklist)
    out.push(
      '',
      '## Format report',
      '',
      `${counts.pass} passed · ${counts.fail} failed · ${counts.warn} warnings · ${counts.unknown} unverified`,
      '',
      '| Rule | Status | Finding | Suggestion |',
      '| --- | --- | --- | --- |',
      ...a.format.checklist.map(
        (c) => `| ${c.rule} | ${statusIcon(c.status)} ${c.status} | ${cell(c.detail)} | ${cell(c.suggestion)} |`,
      ),
    )
    if (a.format.looked_up.length) {
      out.push('', `_Rules resolved by looking them up in the knowledge base: ${a.format.looked_up.join(', ')}._`)
    }
  }

  out.push('', '## Revised manuscript', '')
  if (a.applied.length) {
    out.push('**Changes applied**', ...a.applied.map((x) => `- ${x}`), '')
  } else {
    out.push('_No changes were required._', '')
  }
  if (a.fixerSummary) out.push(a.fixerSummary, '')
  if (a.skipped.length) {
    out.push(`_Could not locate in the manuscript: ${a.skipped.join('; ')}._`, '')
  }
  out.push('```text', a.fixed, '```')

  out.push(
    '',
    '---',
    `_This run used ${a.usage.llm_calls} LLM call${a.usage.llm_calls === 1 ? '' : 's'} (${a.usage.prompt_tokens} prompt + ${a.usage.completion_tokens} completion tokens). Deterministic parsing, rule checks and mechanical fixes ran in code._`,
  )

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function statusIcon(s: string): string {
  return s === 'pass' ? '✅' : s === 'fail' ? '❌' : s === 'warn' ? '⚠️' : '❔'
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function profileNote(p: { source: string; source_url: string | null; venue: string; updated_at: string }): string {
  if (p.source === 'seed') {
    return `_Venue profile: built-in baseline for the ${p.venue} family (as of ${p.updated_at}). Confirm the current rules at ${p.source_url ?? 'the venue site'} before submitting._`
  }
  if (p.source === 'ingested') {
    return `_Venue profile: read from ${p.source_url ?? 'the call-for-papers'} and cached for future runs._`
  }
  if (p.source === 'provided') {
    return `_Venue profile: built from the guidelines you pasted — nothing was fetched from the web — and cached for future runs on ${p.venue}._`
  }
  return `_Venue profile: from the knowledge base${p.source_url ? ` (source: ${p.source_url})` : ''}._`
}

function fallbackSummary(counts: ReturnType<typeof summariseChecks> | null, framing: FramingReport | null): string {
  const bits: string[] = []
  if (framing) bits.push(`Proposed a re-framing for ${framing.venue}.`)
  if (counts) bits.push(`${counts.fail} rule(s) failed and ${counts.warn} raised a warning.`)
  return bits.join(' ') || 'Run complete.'
}

function normaliseTask(t: string | null | undefined): Task {
  return t === 'framing' || t === 'format' ? t : 'both'
}

function outOfScope(reason: string | null): string {
  return [
    "That request is outside what ConfFit does.",
    '',
    'ConfFit adapts an existing research paper to a target academic conference: it re-frames the contribution for that venue and checks the manuscript against the venue’s submission rules, then returns one revised manuscript.',
    reason ? `\nWhy this request does not fit: ${reason}` : '',
    '',
    'Send it in this shape instead:',
    '',
    '```',
    'Target conference: ICLR 2027',
    'Task: both',
    'Paper: <paste the manuscript, or the title + abstract + contributions>',
    'Notes: <optional context, e.g. "rejected from NeurIPS for being too applied">',
    '```',
  ]
    .filter(Boolean)
    .join('\n')
}

function noPendingApproval(): string {
  return [
    'There is no venue waiting for your approval, so there is nothing for me to resume.',
    '',
    'That reply is meant to answer a question like _“May I fetch this Call-for-Papers and add it to the knowledge base?”_. Send the full request and I will start from the top:',
    '',
    '```',
    'Target conference: ICLR 2027',
    'Task: both',
    'Paper: <your manuscript>',
    '```',
  ].join('\n')
}

function needVenue(): string {
  return [
    'I need to know which venue you are targeting — the framing and the format rules both depend on it.',
    '',
    'Add a target conference and resend:',
    '',
    '```',
    'Target conference: ICLR 2027',
    'Task: both',
    'Paper: <your manuscript>',
    '```',
  ].join('\n')
}

function needPaper(venue: string): string {
  return [
    `I have ${venue} as the target venue, but no manuscript to work on.`,
    '',
    'Paste the paper (or at minimum its title, abstract and contribution list) after a `Paper:` line:',
    '',
    '```',
    `Target conference: ${venue}`,
    'Task: both',
    'Paper: <your manuscript>',
    '```',
  ].join('\n')
}
