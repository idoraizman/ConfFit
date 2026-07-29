import { runFormatChecks, summariseChecks, type AnonymityLeak } from '../checks'
import { config } from '../config'
import { applyMechanicalFixes } from '../mechanical'
import { MODULES } from '../modules'
import { callTool } from '../tools'
import type { Tracer } from '../trace'
import type { CheckResult, CheckStatus, ConferenceProfile, FormatReport, ParsedManuscript } from '../types'

/**
 * FormatComplianceAgent — ReAct over a deterministic core.
 *
 * Every rule that can be measured is measured in code (checks.ts) for zero
 * tokens. The model is only involved when (a) the profile does not state a rule,
 * in which case a ReAct loop calls rules_lookup, or (b) something failed and the
 * suggestion is worth phrasing for this specific manuscript.
 *
 * Cost shape: 0 calls on a clean manuscript with a complete profile,
 * 1 call when there are findings, 2 when a rule also has to be looked up.
 */

const REACT_SYSTEM = `You are FormatComplianceAgent, a ReAct agent checking a manuscript against a venue's submission rules.
Deterministic checks have already run. Some rules could not be decided because the venue profile does not state them.
You have one tool: rules_lookup(rule) — retrieves passages about that rule from the venue's indexed Call-for-Papers.
Return a JSON object only:
{"thought":"<one sentence>","lookups":["<rule name>"]}
List at most 2 rules, chosen from the unresolved rules you were given, and only those a lookup could plausibly settle. Return an empty list if a lookup would not help.`

const REPORT_SYSTEM = `You are FormatComplianceAgent. You are given deterministic check results for one manuscript, plus any passages retrieved from the venue's Call-for-Papers.
Return a JSON object only:
{"resolutions":[{"rule":"<existing rule name>","status":"pass"|"fail"|"warn"|"unknown","detail":"<what the evidence shows>","suggestion":"<concrete, manuscript-specific action>"}],
 "note":"<one sentence summarising the state of the submission>"}
Rules:
- Only emit a resolution for a rule that was given to you; do not invent rules.
- Change a status away from "unknown" only when a retrieved passage states the rule. Otherwise leave it "unknown" and say what the author should confirm.
- Suggestions must be specific to this manuscript (name the section, the count, the offending text). Never restate the rule.
- The status describes the manuscript the author submitted, so a rule stays "fail" even once code has fixed it. When a finding appears under "Already fixed automatically", say so in the suggestion and give only the residual action the author still has to take — never tell them to redo work that is already done.`

export interface FormatInput {
  tracer: Tracer
  manuscript: ParsedManuscript
  profile: ConferenceProfile
}

export interface FormatOutput {
  report: FormatReport
  /** Manuscript with the mechanical fixes already applied. */
  mechanicallyFixed: string
  leaks: AnonymityLeak[]
}

export async function runFormatComplianceAgent(input: FormatInput): Promise<FormatOutput> {
  const { tracer, manuscript, profile } = input
  const rules = profile.format_rules

  // ── Deterministic pass (no tokens) ─────────────────────────────────────────
  const { checks, leaks, ambiguous } = runFormatChecks(manuscript, rules)
  const mechanical = applyMechanicalFixes(manuscript, rules)

  const findings = checks.filter((c) => c.status === 'fail' || c.status === 'warn')
  const unknowns = checks.filter((c) => c.status === 'unknown')

  // Nothing to reason about: report the deterministic result and spend nothing.
  if (!findings.length && !unknowns.length) {
    tracer.addDeterministic(
      MODULES.FORMAT,
      {
        system: 'Deterministic compliance checks against the venue rules. No model call is needed when every rule passes.',
        user: `Check ${manuscript.body_word_count} words against ${profile.venue} rules: ${JSON.stringify(rules)}`,
      },
      { summary: summariseChecks(checks), checklist: checks, mechanical_fixes: mechanical.applied },
    )
    return {
      report: { venue: profile.venue, checklist: checks, mechanical_fixes: mechanical.applied, looked_up: [] },
      mechanicallyFixed: mechanical.text,
      leaks,
    }
  }

  // ── ReAct: decide what needs looking up, then look it up ───────────────────
  const observations: string[] = []
  const lookedUp: string[] = []

  if (ambiguous.length) {
    const decision = await tracer.callJson<{ thought?: string; lookups?: string[] }>(MODULES.FORMAT, {
      system: REACT_SYSTEM,
      user: `Venue: ${profile.venue}\nUnresolved rules: ${ambiguous.join(', ')}\nWhat the deterministic pass measured:\n${checks
        .filter((c) => ambiguous.includes(c.rule) || c.status === 'unknown')
        .map((c) => `- ${c.rule}: ${c.detail}`)
        .join('\n')}`,
      maxTokens: 200,
      mock: { thought: 'mock', lookups: ambiguous.slice(0, 1) },
    })

    const wanted = (decision.lookups ?? [])
      .filter((r) => ambiguous.includes(r))
      .slice(0, config.agents.reactMaxIters)

    for (const rule of wanted) {
      const result = await callTool('rules_lookup', { venue_id: profile.venue_id, rule })
      lookedUp.push(rule)
      observations.push(`rules_lookup(${rule}) → ${result.ok ? result.content : 'nothing indexed'}`)
    }
  }

  // ── Final report call ──────────────────────────────────────────────────────
  const resolvable = [...findings, ...unknowns]
  const result = await tracer.callJson<{
    resolutions?: { rule: string; status: string; detail: string; suggestion: string }[]
    note?: string
  }>(MODULES.FORMAT, {
    system: REPORT_SYSTEM,
    user: [
      `Venue: ${profile.venue}`,
      `Venue rules on record: ${JSON.stringify(rules)}`,
      `Manuscript: ${manuscript.body_word_count} words, ~${manuscript.estimated_pages} page(s), sections: ${manuscript.sections
        .map((s) => s.name)
        .join(', ') || 'unstructured'}`,
      `Checks needing a suggestion:\n${resolvable.map((c) => `- ${c.rule} [${c.status}]: ${c.detail}${c.evidence ? `\n  evidence: ${c.evidence.slice(0, 400)}` : ''}`).join('\n')}`,
      observations.length ? `Retrieved from the CFP:\n${observations.join('\n\n').slice(0, 3000)}` : null,
      mechanical.applied.length ? `Already fixed automatically: ${mechanical.applied.join('; ')}` : null,
    ]
      .filter(Boolean)
      .join('\n\n'),
    maxTokens: 900,
    mock: {
      resolutions: resolvable.map((c) => ({
        rule: c.rule,
        status: c.status,
        detail: c.detail,
        suggestion: `(mock) ${c.suggestion}`,
      })),
      note: '(mock) format report',
    },
  })

  // Merge the model's phrasing back onto the deterministic checks. The model can
  // sharpen a suggestion and resolve an "unknown", but it cannot overturn a
  // measurement — pass/fail on a measured rule stays as measured.
  const byRule = new Map(checks.map((c) => [c.rule, c]))
  for (const r of result.resolutions ?? []) {
    const existing = byRule.get(r.rule)
    if (!existing) continue
    const status: CheckStatus =
      existing.status === 'unknown' && isStatus(r.status) ? r.status : existing.status
    byRule.set(r.rule, {
      ...existing,
      status,
      detail: existing.status === 'unknown' && r.detail ? r.detail : existing.detail,
      suggestion: r.suggestion?.trim() || existing.suggestion,
    })
  }

  const finalChecks: CheckResult[] = checks.map((c) => byRule.get(c.rule) ?? c)

  return {
    report: {
      venue: profile.venue,
      checklist: finalChecks,
      mechanical_fixes: mechanical.applied,
      looked_up: lookedUp,
    },
    mechanicallyFixed: mechanical.text,
    leaks,
  }
}

function isStatus(s: string): s is CheckStatus {
  return s === 'pass' || s === 'fail' || s === 'warn' || s === 'unknown'
}
