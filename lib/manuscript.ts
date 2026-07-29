import type { CitationStyle, ParsedManuscript, Section, Task } from './types'

/**
 * Deterministic manuscript handling. Nothing here calls the model — splitting a
 * paper into sections is parsing, and parsing should not cost tokens.
 */

/** Section names we recognise, normalised to a canonical spelling. */
const CANONICAL: [RegExp, string][] = [
  [/^abstract$/i, 'Abstract'],
  [/^(1\.?\s*)?introduction$/i, 'Introduction'],
  [/^related\s+works?$/i, 'Related Work'],
  [/^background$/i, 'Background'],
  [/^(method(s|ology)?|approach|model|our\s+method)$/i, 'Method'],
  [/^(experiments?|experimental\s+setup|evaluation)$/i, 'Experiments'],
  [/^results?$/i, 'Results'],
  [/^(discussion|analysis)$/i, 'Discussion'],
  [/^limitations?$/i, 'Limitations'],
  [/^(ethics|ethics\s+statement|broader\s+impacts?)$/i, 'Ethics Statement'],
  [/^reproducibility(\s+statement)?$/i, 'Reproducibility Statement'],
  [/^(conclusions?|conclusion\s+and\s+future\s+work)$/i, 'Conclusion'],
  [/^acknowledge?ments?$/i, 'Acknowledgements'],
  [/^(funding|funding\s+statement)$/i, 'Funding'],
  [/^(references|bibliography)$/i, 'References'],
  [/^appendix.*$/i, 'Appendix'],
]

/** Strips markdown hashes, leading numbering and trailing punctuation. */
function headingLabel(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\**|\**$/g, '')
    .replace(/^(?:\d+(?:\.\d+)*|[IVXLC]+)[.)]?\s+/, '')
    .replace(/[:.]\s*$/, '')
    .trim()
}

function canonicalise(label: string): string | null {
  for (const [re, name] of CANONICAL) if (re.test(label)) return name
  return null
}

/** True when a line reads like a section heading rather than body text. */
function isHeading(line: string): { name: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 80) return null

  const label = headingLabel(trimmed)
  if (!label) return null

  const canonical = canonicalise(label)
  if (canonical) return { name: canonical }

  // Unrecognised but clearly heading-shaped: markdown hash, or numbered and
  // short, or ALL CAPS. Body sentences are excluded by the punctuation test.
  const markdown = /^#{1,6}\s/.test(trimmed)
  const numbered = /^(?:\d+(?:\.\d+)*|[IVXLC]+)[.)]?\s+\S/.test(trimmed)
  const allCaps = trimmed === trimmed.toUpperCase() && /[A-Z]{3}/.test(trimmed)
  const sentenceLike = /[.,;]\s/.test(trimmed) || /[.!?]$/.test(trimmed)

  if ((markdown || numbered || allCaps) && !sentenceLike && label.split(/\s+/).length <= 8) {
    return { name: label }
  }
  return null
}

const WORD = /[^\s]+/g

export function countWords(text: string): number {
  return (text.match(WORD) ?? []).length
}

/** Detects whether in-text citations are `[3]` or `(Smith et al., 2020)`. */
export function detectInTextStyle(body: string): CitationStyle {
  const numeric = (body.match(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g) ?? []).length
  const authorYear = (body.match(/\((?:[A-Z][A-Za-z'’-]+(?:\s+et\s+al\.?)?[,;]?\s*)+\d{4}[a-z]?\)/g) ?? [])
    .length
  if (numeric === 0 && authorYear === 0) return 'unknown'
  return numeric >= authorYear ? 'numeric' : 'author-year'
}

/** Splits a reference block into individual entries. */
function splitReferences(block: string): string[] {
  const text = block.trim()
  if (!text) return []

  // Numbered lists: [1] ... [2] ...
  if (/^\s*\[\d+\]/m.test(text)) {
    return text
      .split(/\n(?=\s*\[\d+\])/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  // Blank-line separated entries.
  if (/\n\s*\n/.test(text)) {
    return text
      .split(/\n\s*\n/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  }
  // One entry per line.
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 20)
}

export function parseManuscript(raw: string): ParsedManuscript {
  const text = raw.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')

  // Locate headings with their character offsets.
  const marks: { name: string; lineIndex: number; start: number; bodyStart: number }[] = []
  let offset = 0
  lines.forEach((line, i) => {
    const h = isHeading(line)
    if (h) marks.push({ name: h.name, lineIndex: i, start: offset, bodyStart: offset + line.length + 1 })
    offset += line.length + 1
  })

  const sections: Section[] = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length
    return { name: m.name, body: text.slice(m.bodyStart, end).trim(), start: m.start, end }
  })

  // Everything before the first heading is the front matter: title + authors.
  const frontMatterEnd = marks.length ? marks[0].start : Math.min(text.length, 600)
  const frontLines = text
    .slice(0, frontMatterEnd)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const title = frontLines.length ? frontLines[0].replace(/^#{1,6}\s*/, '').trim() : null
  const authorBlock = frontLines.length > 1 ? frontLines.slice(1).join('\n') : null

  const find = (name: string) => sections.find((s) => s.name === name)
  const abstractSection = find('Abstract')
  const referencesSection = find('References')

  // If there is no explicit Abstract heading, fall back to the first
  // substantial paragraph of the front matter.
  let abstract = abstractSection?.body ?? null
  if (!abstract && frontLines.length > 1) {
    const para = frontLines.slice(1).find((l) => countWords(l) > 40)
    abstract = para ?? null
  }

  const references = referencesSection ? splitReferences(referencesSection.body) : []

  // The body is everything except the reference list and appendix.
  const bodyText = sections
    .filter((s) => s.name !== 'References' && s.name !== 'Appendix')
    .map((s) => s.body)
    .join('\n')
  const body = bodyText || text

  return {
    raw: text,
    title,
    author_block: authorBlock,
    abstract: abstract ? abstract.trim() : null,
    sections,
    references,
    in_text_style: detectInTextStyle(body),
    word_count: countWords(text),
    body_word_count: countWords(body) + countWords(text.slice(0, frontMatterEnd)),
    // Two-column conference templates fit roughly 750 words of body text per
    // page once figures and whitespace are accounted for. This is an estimate
    // and the format report says so.
    estimated_pages: Math.max(1, Math.ceil((countWords(body) || countWords(text)) / 750)),
  }
}

// ─── Prompt template parsing ─────────────────────────────────────────────────

export interface ParsedPrompt {
  target_conference: string | null
  task: Task | null
  paper: string
  notes: string | null
  /** True when the user filled in the documented template. */
  templated: boolean
}

const FIELD = /^\s*(target\s+conference|conference|venue|task|paper|manuscript|notes)\s*:\s*/i

/**
 * Reads the documented prompt template out of a free-form prompt.
 *
 * Doing this in code means the Supervisor's routing call only ever sees a short
 * header instead of the whole manuscript.
 */
export function parsePrompt(prompt: string): ParsedPrompt {
  const lines = prompt.replace(/\r\n?/g, '\n').split('\n')
  const buckets: Record<string, string[]> = {}
  let current: string | null = null
  let matched = 0

  for (const line of lines) {
    const m = line.match(FIELD)
    if (m) {
      matched++
      const key = m[1].toLowerCase()
      current =
        key === 'task' ? 'task' : key === 'notes' ? 'notes' : key.includes('paper') || key.includes('manuscript') ? 'paper' : 'conference'
      buckets[current] ??= []
      const rest = line.slice(m[0].length)
      if (rest.trim()) buckets[current].push(rest)
      continue
    }
    if (current) buckets[current].push(line)
  }

  const templated = matched >= 2 && Boolean(buckets.paper?.join('').trim())

  if (!templated) {
    return { target_conference: null, task: null, paper: prompt.trim(), notes: null, templated: false }
  }

  const rawTask = (buckets.task ?? []).join(' ').trim().toLowerCase()
  const task: Task | null = rawTask.includes('both')
    ? 'both'
    : rawTask.includes('fram')
      ? 'framing'
      : rawTask.includes('format')
        ? 'format'
        : null

  return {
    target_conference: (buckets.conference ?? []).join(' ').trim() || null,
    task,
    paper: (buckets.paper ?? []).join('\n').trim(),
    notes: (buckets.notes ?? []).join('\n').trim() || null,
    templated: true,
  }
}

/**
 * The slice of the paper the Supervisor's router needs: enough to identify the
 * venue and the topic, and nothing more.
 */
export function routerDigest(prompt: string, parsed: ParsedPrompt): string {
  if (!parsed.templated) return prompt.slice(0, 1500)
  const head = parsed.paper.slice(0, 700)
  return [
    parsed.target_conference ? `Target conference: ${parsed.target_conference}` : null,
    parsed.task ? `Task: ${parsed.task}` : null,
    parsed.notes ? `Notes: ${parsed.notes}` : null,
    `Paper (first 700 chars): ${head}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * The slice FramingAgent needs: title, abstract, contribution bullets and the
 * opening of the introduction. Never the whole manuscript.
 */
export function framingDigest(m: ParsedManuscript): string {
  const intro = m.sections.find((s) => s.name === 'Introduction')
  const contributions = intro
    ? (intro.body.match(/^\s*(?:[-*•]|\(?\d+[.)])\s+.{20,300}$/gm) ?? []).slice(0, 6)
    : []
  return [
    `Title: ${m.title ?? '(none given)'}`,
    `Abstract: ${(m.abstract ?? '(none given)').slice(0, 2200)}`,
    contributions.length ? `Stated contributions:\n${contributions.join('\n')}` : null,
    intro ? `Introduction opening: ${intro.body.slice(0, 1200)}` : null,
    `Sections present: ${m.sections.map((s) => s.name).join(', ') || '(unstructured text)'}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
