import { parseManuscript } from './manuscript'
import type { Edit, FormatRules, ParsedManuscript } from './types'

/**
 * Fixes that are purely mechanical — a rule maps to a rewrite with no judgement
 * involved — are applied here in code. Only fixes that need judgement (trimming
 * an over-length abstract, applying a new framing) reach the UnifiedFixer's LLM
 * call.
 */

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g
const REPO_URL =
  /\bhttps?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|huggingface\.co)\/[\w.-]+(?:\/[\w.-]+)?/gi

export interface MechanicalResult {
  text: string
  applied: string[]
}

export function applyMechanicalFixes(m: ParsedManuscript, rules: FormatRules): MechanicalResult {
  let text = m.raw
  const applied: string[] = []

  if (rules.anonymous) {
    // Author / affiliation block → anonymous placeholder.
    if (m.author_block && !/anonymous/i.test(m.author_block)) {
      const idx = text.indexOf(m.author_block)
      if (idx !== -1) {
        text =
          text.slice(0, idx) +
          'Anonymous Authors\nPaper under double-blind review' +
          text.slice(idx + m.author_block.length)
        applied.push('Replaced the author/affiliation block with an anonymous placeholder.')
      }
    }

    const emails = text.match(EMAIL) ?? []
    if (emails.length) {
      text = text.replace(EMAIL, '[email removed for review]')
      applied.push(`Removed ${emails.length} contact email address(es).`)
    }

    const repos = text.match(REPO_URL) ?? []
    if (repos.length) {
      text = text.replace(REPO_URL, '[anonymised repository link]')
      applied.push(`Anonymised ${repos.length} repository link(s).`)
    }

    const before = text
    text = text
      .replace(/\b[Oo]ur\s+(previous|prior|earlier|recent)\s+(work|paper|study|method|approach)\b/g, '$1 $2')
      .replace(/\b[Mm]y\s+(previous|prior|earlier|recent)\s+(work|paper|study|method|approach)\b/g, '$1 $2')
    if (text !== before) {
      applied.push('Rephrased self-referential citations ("our prior work" → "prior work").')
    }

    for (const name of ['Acknowledgements', 'Funding']) {
      const removed = removeSection(text, name)
      if (removed !== text) {
        text = removed
        applied.push(`Removed the ${name} section (restore it for camera-ready).`)
      }
    }
  }

  return { text, applied }
}

/** Deletes a named section, re-parsing so offsets stay valid after each edit. */
function removeSection(text: string, name: string): string {
  const parsed = parseManuscript(text)
  const sec = parsed.sections.find((s) => s.name === name)
  if (!sec) return text
  return (text.slice(0, sec.start) + text.slice(sec.end)).replace(/\n{3,}/g, '\n\n')
}

/**
 * Splices the UnifiedFixer's edits into the manuscript.
 *
 * The fixer returns targeted replacements rather than a rewritten manuscript:
 * it keeps the expensive call small and guarantees that untouched sections come
 * through byte-identical.
 */
export function applyEdits(text: string, edits: Edit[]): { text: string; applied: string[]; skipped: string[] } {
  let out = text
  const applied: string[] = []
  const skipped: string[] = []

  for (const edit of edits) {
    const parsed = parseManuscript(out)
    const target = edit.target.trim()
    const replacement = edit.action === 'delete' ? '' : edit.new_text

    let span: { start: number; end: number } | null = null

    if (/^title$/i.test(target) && parsed.title) {
      const i = out.indexOf(parsed.title)
      if (i !== -1) span = { start: i, end: i + parsed.title.length }
    } else if (/^author_?block$/i.test(target) && parsed.author_block) {
      const i = out.indexOf(parsed.author_block)
      if (i !== -1) span = { start: i, end: i + parsed.author_block.length }
    } else if (/^abstract$/i.test(target) && parsed.abstract) {
      const i = out.indexOf(parsed.abstract)
      if (i !== -1) span = { start: i, end: i + parsed.abstract.length }
    } else {
      const name = target.replace(/^section:\s*/i, '')
      const sec = parsed.sections.find((s) => s.name.toLowerCase() === name.toLowerCase())
      if (sec) {
        // Keep the heading line, replace the body beneath it.
        const bodyStart = sec.body ? out.indexOf(sec.body, sec.start) : -1
        span = bodyStart === -1 ? { start: sec.start, end: sec.end } : { start: bodyStart, end: bodyStart + sec.body.length }
      }
    }

    if (!span) {
      skipped.push(`${edit.target} (not found in the manuscript)`)
      continue
    }
    out = out.slice(0, span.start) + replacement + out.slice(span.end)
    applied.push(`${edit.action === 'delete' ? 'Removed' : 'Rewrote'} ${edit.target}: ${edit.reason}`)
  }

  return { text: out.replace(/\n{4,}/g, '\n\n\n'), applied, skipped }
}
