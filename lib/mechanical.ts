import {
  bibliographyStyleOf,
  innerSpan,
  insertPackage,
  stripCommand,
  stripPackage,
  usedPackages,
} from './latex'
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

/** Whole-line `\setlength{\textwidth}{...}` style overrides. */
const LAYOUT_LENGTH_LINE =
  /^[ \t]*\\setlength\s*\{\s*\\(?:textwidth|textheight|topmargin|oddsidemargin|evensidemargin|hoffset|voffset|marginparwidth)\s*\}\s*\{[^}]*\}[ \t]*\n?/gm

/** Drops one option from `\usepackage[a,b]{style}`, removing `[]` when empty. */
function removeStyleOption(src: string, pkg: string | null, option: string): string {
  if (!pkg) return src
  const re = new RegExp(`\\\\usepackage\\s*\\[([^\\]]*)\\]\\s*\\{\\s*${pkg}\\s*\\}`, 'g')
  return src.replace(re, (whole, opts: string) => {
    const kept = opts
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o && o !== option)
    if (kept.length === opts.split(',').map((o) => o.trim()).filter(Boolean).length) return whole
    return kept.length ? `\\usepackage[${kept.join(', ')}]{${pkg}}` : `\\usepackage{${pkg}}`
  })
}

export interface MechanicalResult {
  text: string
  applied: string[]
}

export function applyMechanicalFixes(m: ParsedManuscript, rules: FormatRules): MechanicalResult {
  let text = m.raw
  const applied: string[] = []

  // ── Template setup ─────────────────────────────────────────────────────────
  // Putting the submission into the venue's format is mechanical, so it happens
  // here rather than costing a model call.
  const spec = rules.template_spec
  if (m.format === 'latex' && spec) {
    if (spec.style_package && !usedPackages(text).some((p) => p.name === spec.style_package)) {
      text = insertPackage(text, spec.style_package)
      applied.push(
        `Loaded the venue style file (\\usepackage{${spec.style_package}}). Put ${spec.style_package}.sty next to your .tex before compiling${
          spec.template_url ? ` — download it from ${spec.template_url}` : ''
        }.`,
      )
    }

    if (spec.forbids_layout_override) {
      const before = text
      // geometry and \geometry{...} must go together: leaving either behind is
      // a build error, which would be worse than the finding it fixes.
      text = stripPackage(text, 'geometry')
      text = stripCommand(text, 'geometry')
      text = text.replace(LAYOUT_LENGTH_LINE, '')
      if (text !== before) {
        applied.push('Removed page-geometry overrides; the venue style file fixes the text block.')
      }
    }

    if (spec.bibliography_style && bibliographyStyleOf(text) !== spec.bibliography_style) {
      const had = bibliographyStyleOf(text)
      text = had
        ? text.replace(/\\bibliographystyle\s*\{[^}]*\}/, `\\bibliographystyle{${spec.bibliography_style}}`)
        : text.replace(/(\\bibliography\s*\{)/, `\\bibliographystyle{${spec.bibliography_style}}\n$1`)
      applied.push(
        had
          ? `Changed \\bibliographystyle{${had}} to {${spec.bibliography_style}}.`
          : `Added \\bibliographystyle{${spec.bibliography_style}}.`,
      )
    }

    if (rules.anonymous) {
      for (const macro of spec.forbidden_macros) {
        const name = macro.replace(/^\\/, '')
        const before = text
        text = stripCommand(text, name)
        if (text !== before) applied.push(`Removed ${macro} — it de-anonymises a double-blind submission.`)
      }
      for (const opt of spec.deanonymising_options) {
        const before = text
        text = removeStyleOption(text, spec.style_package, opt)
        if (text !== before) {
          applied.push(`Removed the [${opt}] style option — it prints author names on a double-blind submission.`)
        }
      }
    }
  }

  if (rules.anonymous) {
    // Author / affiliation block → anonymous placeholder. For LaTeX the block
    // is the contents of \author{...}, so the replacement has to stay valid
    // LaTeX: line breaks are \\, not newlines.
    if (m.author_block && !/anonymous/i.test(m.author_block)) {
      const idx = text.indexOf(m.author_block)
      if (idx !== -1) {
        const placeholder =
          m.format === 'latex'
            ? 'Anonymous Authors \\\\ Paper under double-blind review'
            : 'Anonymous Authors\nPaper under double-blind review'
        text = text.slice(0, idx) + placeholder + text.slice(idx + m.author_block.length)
        applied.push('Replaced the author/affiliation block with an anonymous placeholder.')
      }
    }

    // \thanks{...} and \acknowledgments carry funding and affiliation details.
    if (m.format === 'latex') {
      const before = text
      text = text.replace(/\\thanks\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
      if (text !== before) applied.push('Removed \\thanks{...} footnotes (restore them for camera-ready).')
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
    // Models sometimes decorate the target ("section:Introduction (opening)");
    // strip any parenthetical before matching.
    const target = edit.target.trim().replace(/\s*\([^)]*\)\s*$/, '')
    const sectionName = target.replace(/^section:\s*/i, '')
    const existing = parsed.sections.find((s) => s.name.toLowerCase() === sectionName.toLowerCase())

    // A section the manuscript does not have yet — a required Limitations or
    // Ethics Statement — is an insertion, not a replacement.
    if (edit.action === 'insert' || (/^section:/i.test(target) && !existing && edit.action === 'replace')) {
      if (!edit.new_text.trim()) {
        skipped.push(`${edit.target} (no text to insert)`)
        continue
      }
      out = insertSection(out, sectionName, edit.new_text, parsed)
      applied.push(`Added ${sectionName}: ${edit.reason}`)
      continue
    }

    const replacement = edit.action === 'delete' ? '' : edit.new_text
    let span: { start: number; end: number } | null = null

    if (/^title$/i.test(target)) {
      span =
        parsed.format === 'latex'
          ? innerSpan(out, 'title')
          : locateVerbatim(out, parsed.title)
    } else if (/^author_?block$/i.test(target)) {
      span = locateVerbatim(out, parsed.author_block)
    } else if (/^abstract$/i.test(target)) {
      span =
        parsed.format === 'latex'
          ? innerSpan(out, 'abstract')
          : locateVerbatim(out, parsed.abstract)
    } else if (/^intro(duction)?_?opening$/i.test(target)) {
      span = introOpeningSpan(out, parsed)
    } else if (existing) {
      // Keep the heading line, replace the body beneath it.
      const bodyStart = existing.body ? out.indexOf(existing.body, existing.start) : -1
      span =
        bodyStart === -1
          ? { start: existing.start, end: existing.end }
          : { start: bodyStart, end: bodyStart + existing.body.length }
    }

    if (!span) {
      skipped.push(`${edit.target} (not found in the manuscript)`)
      continue
    }
    out = out.slice(0, span.start) + replacement + out.slice(span.end)
    applied.push(`${edit.action === 'delete' ? 'Removed' : 'Rewrote'} ${target}: ${edit.reason}`)
  }

  return { text: out.replace(/\n{4,}/g, '\n\n\n'), applied, skipped }
}

function locateVerbatim(text: string, needle: string | null): { start: number; end: number } | null {
  if (!needle?.trim()) return null
  const i = text.indexOf(needle)
  return i === -1 ? null : { start: i, end: i + needle.length }
}

/**
 * The first real paragraph of the introduction, in original-source coordinates.
 *
 * A LaTeX \section{Introduction} followed straight away by \subsection{...} has
 * no prose of its own, so the opening paragraph lives in the first subsection.
 */
function introOpeningSpan(text: string, parsed: ParsedManuscript): { start: number; end: number } | null {
  const idx = parsed.sections.findIndex((s) => s.name === 'Introduction')
  if (idx === -1) return null

  let target = parsed.sections[idx]
  if (!target.body.trim()) {
    for (let i = idx + 1; i < parsed.sections.length; i++) {
      if (parsed.sections[i].level <= parsed.sections[idx].level) break
      if (parsed.sections[i].body.trim()) {
        target = parsed.sections[i]
        break
      }
    }
  }

  const para = target.body.split(/\n\s*\n/).find((p) => p.trim().length > 60)?.trim()
  if (!para) return null
  const at = text.indexOf(para, target.start)
  return at === -1 ? null : { start: at, end: at + para.length }
}

/**
 * Inserts a new section immediately before the reference list, which is where
 * venues expect statements like Limitations, Ethics and Reproducibility.
 */
function insertSection(text: string, name: string, body: string, parsed: ParsedManuscript): string {
  // The model usually repeats the heading at the top of new_text; drop it so
  // the inserted section does not end up with the title twice.
  const lines = body.trim().split('\n')
  const first = lines[0]
    ?.replace(/^#{1,6}\s*/, '')
    .replace(/^\**|\**$/g, '')
    .replace(/\\(sub)?section\*?\s*\{([^}]*)\}/, '$2')
    .replace(/[:.]\s*$/, '')
    .trim()
  if (first && first.toLowerCase() === name.toLowerCase()) lines.shift()

  const heading = parsed.format === 'latex' ? `\\section*{${name}}` : name
  const block = `\n\n${heading}\n${lines.join('\n').trim()}\n`

  // Insert before the bibliography, which is where venues expect statements
  // like Limitations, Ethics and Reproducibility to sit.
  let anchor = -1
  if (parsed.format === 'latex') {
    const bib = /\\begin\s*\{thebibliography\}|\\bibliographystyle\s*\{|\\bibliography\s*\{|\\end\s*\{document\}/.exec(text)
    anchor = bib ? bib.index : -1
  } else {
    anchor = parsed.sections.find((s) => s.name === 'References')?.start ?? -1
  }

  if (anchor !== -1) {
    return (text.slice(0, anchor) + block + '\n' + text.slice(anchor)).replace(/\n{4,}/g, '\n\n\n')
  }
  return (text.trimEnd() + block).replace(/\n{4,}/g, '\n\n\n')
}
