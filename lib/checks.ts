import { countWords } from './manuscript'
import type { CheckResult, FormatRules, ParsedManuscript } from './types'

/**
 * Deterministic compliance checks. Every rule that can be decided by measuring
 * the manuscript is decided here, in code, for zero tokens. Only rules the
 * ConferenceProfile could not resolve are escalated to the ReAct loop.
 */

export interface AnonymityLeak {
  kind: 'author_block' | 'email' | 'affiliation' | 'self_reference' | 'repo_url' | 'acknowledgements'
  excerpt: string
}

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g
const REPO_URL =
  /\bhttps?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|huggingface\.co)\/[\w.-]+(?:\/[\w.-]+)?/gi
const AFFILIATION =
  /\b(?:University|Universit[àéy]|Institute of Technology|Technion|MIT|Stanford|Carnegie Mellon|College|Laborator(?:y|ies)|Research (?:Lab|Center|Centre)|Google|Meta|Microsoft|NVIDIA|Amazon|IBM|DeepMind|OpenAI|Anthropic)\b/g
const SELF_REFERENCE =
  /\b(?:our|my)\s+(?:previous|prior|earlier|recent)\s+(?:work|paper|study|method|approach)\b[^.]{0,80}/gi
const FIRST_PERSON_CITE = /\b(?:we|I)\s+(?:previously\s+)?(?:showed|proposed|introduced)\s+in\s+\[[^\]]+\]/gi

export function findAnonymityLeaks(m: ParsedManuscript): AnonymityLeak[] {
  const leaks: AnonymityLeak[] = []
  const push = (kind: AnonymityLeak['kind'], excerpt: string) => {
    const clean = excerpt.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (clean && !leaks.some((l) => l.kind === kind && l.excerpt === clean)) {
      leaks.push({ kind, excerpt: clean })
    }
  }

  if (m.author_block && !/anonymous/i.test(m.author_block)) {
    push('author_block', m.author_block)
  }
  for (const e of m.raw.match(EMAIL) ?? []) push('email', e)
  for (const u of m.raw.match(REPO_URL) ?? []) push('repo_url', u)

  // Affiliations only count as a leak inside the front matter — a Related Work
  // sentence naming Google is not de-anonymising.
  const front = (m.title ?? '') + '\n' + (m.author_block ?? '')
  for (const a of front.match(AFFILIATION) ?? []) push('affiliation', a)

  const body = m.sections
    .filter((s) => s.name !== 'References')
    .map((s) => s.body)
    .join('\n')
  for (const s of body.match(SELF_REFERENCE) ?? []) push('self_reference', s)
  for (const s of body.match(FIRST_PERSON_CITE) ?? []) push('self_reference', s)

  for (const name of ['Acknowledgements', 'Funding']) {
    const sec = m.sections.find((s) => s.name === name)
    if (sec && sec.body.trim()) push('acknowledgements', `${name}: ${sec.body}`)
  }
  return leaks
}

const LEAK_LABEL: Record<AnonymityLeak['kind'], string> = {
  author_block: 'author / affiliation block',
  email: 'contact email',
  affiliation: 'institution name in the front matter',
  self_reference: 'de-anonymising self-reference',
  repo_url: 'code or model repository link',
  acknowledgements: 'acknowledgements or funding statement',
}

export interface CheckOutcome {
  checks: CheckResult[]
  leaks: AnonymityLeak[]
  /** Rules we could not decide because the profile did not state them. */
  ambiguous: string[]
}

export function runFormatChecks(m: ParsedManuscript, rules: FormatRules): CheckOutcome {
  const checks: CheckResult[] = []
  const ambiguous: string[] = []

  // ── Page limit ─────────────────────────────────────────────────────────────
  if (rules.page_limit == null) {
    ambiguous.push('page_limit')
    checks.push({
      rule: 'page_limit',
      status: 'unknown',
      detail: `Manuscript is ~${m.estimated_pages} page(s) of body text (${m.body_word_count} words); the venue's page limit is not recorded.`,
      suggestion: 'Confirm the page limit in the Call-for-Papers before submitting.',
    })
  } else {
    const over = m.estimated_pages > rules.page_limit
    checks.push({
      rule: 'page_limit',
      status: over ? 'fail' : m.estimated_pages === rules.page_limit ? 'warn' : 'pass',
      detail: `~${m.estimated_pages} estimated page(s) of body text vs a limit of ${rules.page_limit}${
        rules.references_in_limit === false ? ' (references excluded)' : ''
      }. Estimated from ${m.body_word_count} words at ~750 words/page — verify after compiling the template.`,
      suggestion: over
        ? `Cut roughly ${Math.max(1, m.estimated_pages - rules.page_limit) * 750} words, or move material to the appendix.`
        : 'Within the limit.',
    })
  }

  // ── Abstract length ────────────────────────────────────────────────────────
  const abstractWords = m.abstract ? countWords(m.abstract) : 0
  if (!m.abstract) {
    checks.push({
      rule: 'abstract',
      status: 'fail',
      detail: 'No abstract was found in the manuscript.',
      suggestion: 'Add an abstract; every venue in scope requires one.',
    })
  } else if (rules.abstract_word_limit == null) {
    checks.push({
      rule: 'abstract_length',
      status: abstractWords > 350 ? 'warn' : 'pass',
      detail: `Abstract is ${abstractWords} words; the venue does not publish a hard limit.`,
      suggestion:
        abstractWords > 350
          ? 'Most venues expect 150–250 words; consider tightening it.'
          : 'Length is in the usual range.',
    })
  } else {
    const over = abstractWords > rules.abstract_word_limit
    checks.push({
      rule: 'abstract_length',
      status: over ? 'fail' : 'pass',
      detail: `Abstract is ${abstractWords} words vs a limit of ${rules.abstract_word_limit}.`,
      suggestion: over
        ? `Trim ${abstractWords - rules.abstract_word_limit} words from the abstract.`
        : 'Within the limit.',
      evidence: over ? m.abstract.slice(0, 1500) : undefined,
    })
  }

  // ── Anonymity ──────────────────────────────────────────────────────────────
  const leaks = findAnonymityLeaks(m)
  if (rules.anonymous == null) {
    ambiguous.push('anonymity')
    checks.push({
      rule: 'anonymity',
      status: 'unknown',
      detail: `Found ${leaks.length} potentially identifying item(s); whether this venue is double-blind is not recorded.`,
      suggestion: 'Confirm the venue’s review model before submitting.',
    })
  } else if (rules.anonymous) {
    checks.push({
      rule: 'anonymity',
      status: leaks.length ? 'fail' : 'pass',
      detail: leaks.length
        ? `Double-blind venue. Found ${leaks.length} identifying item(s): ${[
            ...new Set(leaks.map((l) => LEAK_LABEL[l.kind])),
          ].join(', ')}.`
        : 'Double-blind venue; no identifying information found.',
      suggestion: leaks.length
        ? 'Redact the author block, remove contact emails and repository links, rephrase self-references in the third person, and drop acknowledgements until camera-ready.'
        : 'No action needed.',
      evidence: leaks.length ? leaks.map((l) => `${l.kind}: ${l.excerpt}`).join('\n') : undefined,
    })
  } else {
    checks.push({
      rule: 'anonymity',
      status: 'pass',
      detail: 'Single-blind or open review; author information may remain.',
      suggestion: 'No action needed.',
    })
  }

  // ── Citation style ─────────────────────────────────────────────────────────
  if (rules.citation_style === 'unknown') {
    ambiguous.push('citation_style')
    checks.push({
      rule: 'citation_style',
      status: 'unknown',
      detail: `Manuscript uses ${describeStyle(m.in_text_style)} citations; the venue's required style is not recorded.`,
      suggestion: 'Check the venue style file before submitting.',
    })
  } else if (m.in_text_style === 'unknown') {
    checks.push({
      rule: 'citation_style',
      status: 'warn',
      detail: `The venue requires ${describeStyle(rules.citation_style)} citations; no in-text citations were detected in the manuscript.`,
      suggestion: 'Add in-text citations in the required style.',
    })
  } else {
    const ok = m.in_text_style === rules.citation_style
    checks.push({
      rule: 'citation_style',
      status: ok ? 'pass' : 'fail',
      detail: `Manuscript uses ${describeStyle(m.in_text_style)}; the venue requires ${describeStyle(rules.citation_style)}.`,
      suggestion: ok
        ? 'Matches the venue style.'
        : rules.citation_style === 'author-year'
          ? 'Convert numeric citations to author–year (e.g. \\citep{} with natbib).'
          : 'Convert author–year citations to numeric brackets.',
    })
  }

  // ── Required and recommended sections ──────────────────────────────────────
  const present = new Set(m.sections.map((s) => s.name.toLowerCase()))

  if (rules.required_sections.length) {
    const missing = rules.required_sections.filter((r) => !present.has(r.toLowerCase()))
    checks.push({
      rule: 'required_sections',
      status: missing.length ? 'fail' : 'pass',
      detail: missing.length
        ? `Missing required section(s): ${missing.join(', ')}.`
        : `All required sections present: ${rules.required_sections.join(', ')}.`,
      suggestion: missing.length
        ? `Add ${missing.join(' and ')} — the venue requires ${missing.length > 1 ? 'them' : 'it'}.`
        : 'No action needed.',
    })
  }

  if (rules.recommended_sections.length) {
    const missing = rules.recommended_sections.filter((r) => !present.has(r.toLowerCase()))
    checks.push({
      rule: 'recommended_sections',
      status: missing.length ? 'warn' : 'pass',
      detail: missing.length
        ? `The venue encourages but does not require: ${missing.join(', ')}. ${missing.length > 1 ? 'They are' : 'It is'} absent.`
        : `All encouraged sections present: ${rules.recommended_sections.join(', ')}.`,
      suggestion: missing.length
        ? `Adding ${missing.join(' and ')} is optional and typically excluded from the page limit; reviewers tend to look for ${missing.length > 1 ? 'them' : 'it'}.`
        : 'No action needed.',
    })
  }

  // ── References ─────────────────────────────────────────────────────────────
  checks.push({
    rule: 'references',
    status: m.references.length ? 'pass' : 'warn',
    detail: m.references.length
      ? `${m.references.length} reference entr${m.references.length === 1 ? 'y' : 'ies'} detected.`
      : 'No reference list was found.',
    suggestion: m.references.length ? 'No action needed.' : 'Add a reference list.',
  })

  // ── Template ───────────────────────────────────────────────────────────────
  checks.push({
    rule: 'template',
    status: rules.template ? 'warn' : 'unknown',
    detail: rules.template
      ? `The venue requires ${rules.template}. ConfFit reads plain text and cannot verify the compiled template.`
      : 'The required template is not recorded for this venue.',
    suggestion: rules.template
      ? `Compile with ${rules.template} and re-check page count on the compiled PDF.`
      : 'Download the official style files from the venue site.',
  })

  return { checks, leaks, ambiguous: [...new Set([...ambiguous, ...rules.unresolved])] }
}

function describeStyle(s: string): string {
  return s === 'numeric' ? 'numeric [1]' : s === 'author-year' ? 'author–year (Smith, 2020)' : 'no detectable'
}

export function summariseChecks(checks: CheckResult[]) {
  return {
    pass: checks.filter((c) => c.status === 'pass').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    unknown: checks.filter((c) => c.status === 'unknown').length,
  }
}
