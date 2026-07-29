import { bibliographyStyleOf, usedPackages } from './latex'
import { countWords } from './manuscript'
import type { CheckResult, FormatRules, ParsedManuscript, TemplateSpec } from './types'

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

  // ── Abstract shape ─────────────────────────────────────────────────────────
  if (m.abstract && rules.abstract_single_paragraph) {
    const paragraphs = m.abstract.split(/\n\s*\n/).filter((p) => p.trim().length > 0)
    checks.push({
      rule: 'abstract_single_paragraph',
      status: paragraphs.length > 1 ? 'fail' : 'pass',
      detail:
        paragraphs.length > 1
          ? `The venue requires a one-paragraph abstract; this one has ${paragraphs.length} paragraphs.`
          : 'Abstract is a single paragraph, as the venue requires.',
      suggestion:
        paragraphs.length > 1
          ? 'Merge the abstract into one paragraph.'
          : 'No action needed.',
      evidence: paragraphs.length > 1 ? m.abstract.slice(0, 1500) : undefined,
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
    // For LaTeX + natbib venues the actionable detail is which command is used:
    // a bare \cite{} renders numerically no matter what the .bst says, so it is
    // the concrete thing the author has to change.
    const bareCite = m.format === 'latex' ? (m.raw.match(/\\cite\s*[[{]/g) ?? []).length : 0
    const natbibCite = m.format === 'latex' ? (m.raw.match(/\\cite[pt]\*?\s*[[{]/g) ?? []).length : 0
    const style = m.format === 'latex' ? m.raw.match(/\\bibliographystyle\s*\{([^}]*)\}/)?.[1] : undefined

    checks.push({
      rule: 'citation_style',
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `Manuscript uses ${describeStyle(m.in_text_style)}, matching the venue.`
        : m.format === 'latex'
          ? `The venue requires ${describeStyle(rules.citation_style)}. The source has ${bareCite} bare \\cite{...} and ${natbibCite} \\citep/\\citet call(s)${style ? `, with \\bibliographystyle{${style}}` : ''}.`
          : `Manuscript uses ${describeStyle(m.in_text_style)}; the venue requires ${describeStyle(rules.citation_style)}.`,
      suggestion: ok
        ? 'Matches the venue style.'
        : rules.citation_style === 'author-year'
          ? m.format === 'latex'
            ? `Switch \\bibliographystyle to the venue's natbib-compatible .bst, then replace each \\cite{...}: use \\citet{...} where the authors are part of the sentence ("Smith et al. (2020) show…") and \\citep{...} everywhere else ("…as shown previously (Smith et al., 2020)").`
            : 'Convert numeric citations to author–year (e.g. \\citep{} with natbib).'
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
  // For LaTeX source the preamble is checkable, so the old blanket "cannot
  // verify the template" warning would be an over-claim in the other direction.
  const spec = rules.template_spec
  if (m.format === 'latex' && spec) {
    checks.push(...templateChecks(m, rules, spec))
  }

  checks.push({
    rule: 'template',
    status: rules.template ? 'warn' : 'unknown',
    detail: rules.template
      ? `The venue requires ${rules.template}.${
          m.format === 'latex' && spec
            ? ' The preamble checks above cover what the source determines; page geometry, fonts and figure legibility can only be confirmed on the compiled PDF.'
            : ' ConfFit reads source text and cannot verify the compiled output.'
        }`
      : 'The required template is not recorded for this venue.',
    suggestion: rules.template
      ? `Compile with the official template and re-check the page count and layout on the resulting PDF.`
      : 'Download the official style files from the venue site.',
  })

  return { checks, leaks, ambiguous: [...new Set([...ambiguous, ...rules.unresolved])] }
}

/** Layout commands a venue that fixes its own text block does not permit. */
const LAYOUT_LENGTHS = /\\setlength\s*\{\s*\\(textwidth|textheight|topmargin|oddsidemargin|evensidemargin|hoffset|voffset|marginparwidth)\s*\}/g

/**
 * Preamble checks — the part of a venue's template the author's source actually
 * decides. Each one is verifiable and each one has a mechanical fix.
 */
function templateChecks(m: ParsedManuscript, rules: FormatRules, spec: TemplateSpec): CheckResult[] {
  const out: CheckResult[] = []
  const packages = usedPackages(m.raw)
  const where = spec.template_url ? ` The template is at ${spec.template_url}.` : ''

  // 1. Is the venue's style package loaded at all?
  if (spec.style_package) {
    const loaded = packages.find((p) => p.name === spec.style_package)
    out.push({
      rule: 'template_style_file',
      status: loaded ? 'pass' : 'fail',
      detail: loaded
        ? `The manuscript loads \\usepackage{${spec.style_package}}.`
        : `The manuscript never loads \\usepackage{${spec.style_package}}; its preamble is \\documentclass{${
            m.raw.match(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/)?.[1] ?? 'article'
          }} with ${packages.length} generic package(s). Nothing about the submission is in the venue's format.`,
      suggestion: loaded
        ? 'No action needed.'
        : `Load the venue style file and put the .sty next to your .tex before compiling.${where}`,
      evidence: loaded ? undefined : m.raw.slice(0, 400),
    })
  }

  // 2. Is the bibliography style the venue's?
  if (spec.bibliography_style) {
    const actual = bibliographyStyleOf(m.raw)
    const ok = actual === spec.bibliography_style
    out.push({
      rule: 'template_bibliography_style',
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `\\bibliographystyle{${actual}} matches the venue.`
        : actual
          ? `\\bibliographystyle{${actual}} is set; the venue requires {${spec.bibliography_style}}.`
          : `No \\bibliographystyle is set; the venue requires {${spec.bibliography_style}}.`,
      suggestion: ok
        ? 'No action needed.'
        : `Set \\bibliographystyle{${spec.bibliography_style}} so the bibliography renders in the venue's format.`,
    })
  }

  // 3. Does the source override the layout the style file fixes?
  if (spec.forbids_layout_override) {
    const offenders: string[] = []
    if (packages.some((p) => p.name === 'geometry')) offenders.push('\\usepackage{geometry}')
    const geo = m.raw.match(/\\geometry\s*\{[^}]*\}/g) ?? []
    offenders.push(...geo)
    offenders.push(...(m.raw.match(LAYOUT_LENGTHS) ?? []))

    out.push({
      rule: 'template_layout_override',
      status: offenders.length ? 'fail' : 'pass',
      detail: offenders.length
        ? `The venue fixes the text block and forbids changing it, but the preamble sets ${offenders.join(', ')}.`
        : 'The preamble does not override the venue’s page geometry.',
      suggestion: offenders.length
        ? 'Remove the geometry package and every margin/length override; the style file already sets the required text block.'
        : 'No action needed.',
      evidence: offenders.length ? offenders.join('\n') : undefined,
    })
  }

  // 4. Would this submission be de-anonymised by a style option or macro?
  if (rules.anonymous) {
    const styleOpts = packages.find((p) => p.name === spec.style_package)?.options ?? []
    const badOpts = styleOpts.filter((o) => spec.deanonymising_options.includes(o))
    const badMacros = spec.forbidden_macros.filter((cmd) =>
      new RegExp(`${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(m.raw),
    )
    const hits = [...badOpts.map((o) => `[${o}]`), ...badMacros]

    out.push({
      rule: 'template_anonymity_option',
      status: hits.length ? 'fail' : 'pass',
      detail: hits.length
        ? `${hits.join(' and ')} switches the template into camera-ready mode, which prints the author names. On a double-blind submission that is a desk-reject risk.`
        : 'No camera-ready or de-anonymising option is set.',
      suggestion: hits.length
        ? `Remove ${hits.join(' and ')} until the paper is accepted.`
        : 'No action needed.',
    })
  }

  return out
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
