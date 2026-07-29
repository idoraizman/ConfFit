import { applyEdits } from '../mechanical'
import { parseManuscript } from '../manuscript'
import { MODULES } from '../modules'
import type { Tracer } from '../trace'
import type { Edit, FormatReport, FramingReport, ParsedManuscript } from '../types'

/**
 * UnifiedFixer — one pass, one LLM call, one revised manuscript.
 *
 * The framing report and the format report are applied together so the author
 * gets a single coherent revision rather than two conflicting ones.
 *
 * Cost discipline: the fixer is given the reports and only the spans they touch
 * (title, abstract, introduction opening, over-length text), never the whole
 * manuscript, and it returns targeted edits rather than a rewritten paper.
 * Code splices those edits in, so untouched sections come through unchanged.
 */

const FIXER_SYSTEM = `You are UnifiedFixer. You apply a framing report and a format report to one manuscript, in a single pass.
Return a JSON object only:
{"edits":[{"target":"title"|"abstract"|"section:<Name>","action":"replace"|"delete","new_text":"<the full replacement text for that target>","reason":"<short>"}],
 "summary":"<2-3 sentences describing what you changed and why>"}
Rules:
- Emit an edit only where a report asks for a change. Leave everything else alone.
- Reconcile the two reports: if the framing report rewrites the abstract and the format report says the abstract is over the word limit, emit one abstract edit that satisfies both.
- new_text must be the complete replacement for that target, in the manuscript's own voice, using only claims the paper already makes.
- Never re-emit unchanged text as an edit. Never invent results, citations, or numbers.
- Mechanical fixes (anonymisation, removed acknowledgements) have already been applied by code; do not redo them.`

export interface FixerInput {
  tracer: Tracer
  /** Manuscript text after the mechanical fixes. */
  text: string
  original: ParsedManuscript
  framing: FramingReport | null
  format: FormatReport | null
}

export interface FixerOutput {
  fixed: string
  summary: string
  applied: string[]
  skipped: string[]
  /** True when nothing needed judgement, so no LLM call was made. */
  skippedCall: boolean
}

export async function runUnifiedFixer(input: FixerInput): Promise<FixerOutput> {
  const { tracer, text, framing, format } = input

  // Which format findings actually need judgement? Everything mechanical has
  // already been handled in code.
  const judgementRules = new Set(['abstract_length', 'abstract', 'page_limit', 'required_sections'])
  const needsJudgement =
    format?.checklist.filter((c) => (c.status === 'fail' || c.status === 'warn') && judgementRules.has(c.rule)) ?? []

  const mechanicalOnly = format?.mechanical_fixes ?? []

  if (!framing && !needsJudgement.length) {
    tracer.addDeterministic(
      MODULES.FIXER,
      {
        system: 'Apply the framing and format reports to the manuscript in one pass.',
        user: 'No framing report and no findings that need judgement.',
      },
      {
        edits: [],
        summary: mechanicalOnly.length
          ? 'Only mechanical fixes were required; they were applied in code without a model call.'
          : 'The manuscript already complies; no revision was needed.',
        mechanical_fixes: mechanicalOnly,
      },
    )
    return {
      fixed: text,
      summary: mechanicalOnly.length
        ? 'Applied mechanical fixes only.'
        : 'No changes were needed.',
      applied: mechanicalOnly,
      skipped: [],
      skippedCall: true,
    }
  }

  const current = parseManuscript(text)
  const intro = current.sections.find((s) => s.name === 'Introduction')

  const user = [
    `--- CURRENT TEXT OF THE SPANS YOU MAY EDIT ---`,
    `title: ${current.title ?? '(none)'}`,
    `abstract: ${current.abstract ?? '(none)'}`,
    intro ? `section:Introduction (opening): ${intro.body.slice(0, 1200)}` : null,
    framing
      ? `--- FRAMING REPORT (${framing.venue}) ---\n${JSON.stringify({
          angle: framing.proposal.angle,
          foreground: framing.proposal.foreground,
          background: framing.proposal.background,
          suggested_title: framing.proposal.suggested_title,
          suggested_abstract: framing.proposal.suggested_abstract,
          intro_opening: framing.proposal.intro_opening,
          critic_cons: framing.critique.cons,
          unsupported_claims_to_avoid: framing.critique.unsupported_claims,
        })}`
      : null,
    needsJudgement.length
      ? `--- FORMAT FINDINGS NEEDING JUDGEMENT ---\n${needsJudgement
          .map((c) => `- ${c.rule} [${c.status}]: ${c.detail} → ${c.suggestion}`)
          .join('\n')}`
      : null,
    mechanicalOnly.length ? `--- ALREADY APPLIED IN CODE (do not repeat) ---\n${mechanicalOnly.join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  const result = await tracer.callJson<{ edits?: Edit[]; summary?: string }>(MODULES.FIXER, {
    system: FIXER_SYSTEM,
    user,
    maxTokens: 1400,
    mock: {
      edits: framing
        ? [
            {
              target: 'title',
              action: 'replace',
              new_text: framing.proposal.suggested_title,
              reason: '(mock) apply framing',
            },
          ]
        : [],
      summary: '(mock) unified fix',
    },
  })

  const edits = (result.edits ?? []).filter(
    (e): e is Edit =>
      Boolean(e) && typeof e.target === 'string' && (e.action === 'replace' || e.action === 'delete') && typeof e.new_text === 'string',
  )

  const spliced = applyEdits(text, edits)

  return {
    fixed: spliced.text,
    summary: typeof result.summary === 'string' ? result.summary : '',
    applied: [...mechanicalOnly, ...spliced.applied],
    skipped: spliced.skipped,
    skippedCall: false,
  }
}
