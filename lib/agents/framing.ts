import { config } from '../config'
import { framingDigest } from '../manuscript'
import { MODULES } from '../modules'
import type { Tracer } from '../trace'
import type { ConferenceProfile, FramingCritique, FramingProposal, FramingReport, ParsedManuscript } from '../types'

/**
 * FramingAgent — a Reflection agent: Generate → Reflect → (optionally) Generate
 * again. Two modules appear in the trace, FramingAgent for the generate half
 * and FramingReflect for the critique half, matching the architecture diagram.
 *
 * Cost shape: 2 calls when the critique accepts, 3 when it asks for a revision.
 * The loop is hard-capped at 2 reflections by config.
 *
 * Context discipline: this agent never sees the full manuscript — only the
 * title, abstract, stated contributions and the opening of the introduction.
 */

const GENERATE_SYSTEM = `You are FramingAgent. You re-position an existing paper for one specific venue. You never invent results.
Given the paper's own claims and a profile of the venue, return a JSON object only:
{"angle":"<one sentence: the framing that makes this paper land at this venue>",
 "foreground":[ "<contribution to lead with, and why it fits this venue>" ],
 "background":[ "<contribution to de-emphasise, and why>" ],
 "suggested_title":"<a title in the venue's idiom>",
 "suggested_abstract":"<a rewritten abstract, 150-220 words, using only claims the paper already makes>",
 "intro_opening":"<2-4 sentences that could open the introduction>",
 "rationale":"<2-3 sentences tying the angle to what this venue rewards>"}
Hard constraint: every claim must be supported by the material you were given. If the paper does not report a result, do not write it.`

const REFLECT_SYSTEM = `You are FramingReflect, the critic half of a reflection loop. Judge a proposed re-framing against the venue profile and the paper's own content.
Return a JSON object only:
{"critique":"<2-4 sentences>",
 "pros":[string],
 "cons":[string],
 "unsupported_claims":["<any statement in the proposal that the paper does not support>"],
 "verdict":"accept"|"revise",
 "revision_notes":"<what specifically to change; empty string when accepting>"}
Answer "revise" only for a concrete, fixable problem: a mismatch with what the venue rewards, or a claim the paper does not support. Do not ask for stylistic polish.`

const REVISE_SYSTEM = `${GENERATE_SYSTEM}

You are revising an earlier proposal after a critique. Address every point in the critique, in particular removing any unsupported claim. Return the same JSON shape.`

export interface FramingInput {
  tracer: Tracer
  manuscript: ParsedManuscript
  profile: ConferenceProfile
  /** CFP passages retrieved for this paper by ConferenceProfiler. */
  grounding: string[]
  notes: string | null
}

export async function runFramingAgent(input: FramingInput): Promise<FramingReport> {
  const { tracer, profile } = input

  const venueBrief = [
    `Venue: ${profile.venue}`,
    `Focus areas: ${profile.focus_areas.join('; ') || 'not recorded'}`,
    `What it rewards: ${profile.valued_criteria.join('; ') || 'not recorded'}`,
    `Emphasis of accepted papers: ${profile.accepted_paper_emphasis.join('; ') || 'not recorded'}`,
    input.grounding.length ? `Retrieved from the venue's CFP:\n${input.grounding.join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  const paperBrief = framingDigest(input.manuscript)
  const userBase = [venueBrief, `--- PAPER ---\n${paperBrief}`, input.notes ? `Author notes: ${input.notes}` : null]
    .filter(Boolean)
    .join('\n\n')

  let proposal = await tracer.callJson<FramingProposal>(MODULES.FRAMING, {
    system: GENERATE_SYSTEM,
    user: userBase,
    maxTokens: 900,
    mock: mockProposal(profile.venue),
  })

  let critique = await tracer.callJson<FramingCritique>(MODULES.FRAMING_REFLECT, {
    system: REFLECT_SYSTEM,
    user: `${venueBrief}\n\n--- PAPER ---\n${paperBrief}\n\n--- PROPOSAL ---\n${JSON.stringify(proposal)}`,
    maxTokens: 600,
    mock: mockCritique(),
  })

  let iterations = 1
  while (critique.verdict === 'revise' && iterations <= config.agents.framingReflectMax) {
    proposal = await tracer.callJson<FramingProposal>(MODULES.FRAMING, {
      system: REVISE_SYSTEM,
      user: `${userBase}\n\n--- PREVIOUS PROPOSAL ---\n${JSON.stringify(proposal)}\n\n--- CRITIQUE TO ADDRESS ---\n${JSON.stringify(
        { critique: critique.critique, cons: critique.cons, unsupported_claims: critique.unsupported_claims, revision_notes: critique.revision_notes },
      )}`,
      maxTokens: 900,
      mock: mockProposal(profile.venue),
    })
    iterations += 1

    // Only re-critique if the budget allows another revision to act on it;
    // a critique nobody can respond to is a wasted call.
    if (iterations <= config.agents.framingReflectMax) {
      critique = await tracer.callJson<FramingCritique>(MODULES.FRAMING_REFLECT, {
        system: REFLECT_SYSTEM,
        user: `${venueBrief}\n\n--- PAPER ---\n${paperBrief}\n\n--- PROPOSAL ---\n${JSON.stringify(proposal)}`,
        maxTokens: 600,
        mock: mockCritique(),
      })
    } else {
      critique = { ...critique, verdict: 'accept', revision_notes: '' }
    }
  }

  return { venue: profile.venue, proposal: normalise(proposal), critique: normaliseCritique(critique), iterations }
}

function normalise(p: Partial<FramingProposal>): FramingProposal {
  return {
    angle: str(p.angle),
    foreground: list(p.foreground),
    background: list(p.background),
    suggested_title: str(p.suggested_title),
    suggested_abstract: str(p.suggested_abstract),
    intro_opening: str(p.intro_opening),
    rationale: str(p.rationale),
  }
}

function normaliseCritique(c: Partial<FramingCritique>): FramingCritique {
  return {
    critique: str(c.critique),
    pros: list(c.pros),
    cons: list(c.cons),
    unsupported_claims: list(c.unsupported_claims),
    verdict: c.verdict === 'revise' ? 'revise' : 'accept',
    revision_notes: str(c.revision_notes),
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []

function mockProposal(venue: string): FramingProposal {
  return {
    angle: `(mock) Position the work as a general principle for ${venue}.`,
    foreground: ['(mock) the mechanism'],
    background: ['(mock) the deployment details'],
    suggested_title: '(mock) A Rewritten Title',
    suggested_abstract: '(mock) A rewritten abstract.',
    intro_opening: '(mock) A rewritten opening.',
    rationale: '(mock) Matches what the venue rewards.',
  }
}

function mockCritique(): FramingCritique {
  return {
    critique: '(mock) The proposal is consistent with the paper.',
    pros: ['(mock) aligned with the venue'],
    cons: [],
    unsupported_claims: [],
    verdict: 'accept',
    revision_notes: '',
  }
}
