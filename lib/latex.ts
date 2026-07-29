import type { CitationStyle, ParsedManuscript, Section } from './types'

/**
 * LaTeX-aware manuscript parsing.
 *
 * Authors submit .tex source far more often than prose, and the plain-text
 * parser finds nothing in it: no `#` headings, no `[1]` citations, no reference
 * list (the bibliography lives in a separate .bib). Without this the format
 * report would confidently describe a paper it never actually read.
 *
 * Every offset returned here points into the ORIGINAL source, so the mechanical
 * fixes and the UnifiedFixer's edits splice back into compilable LaTeX rather
 * than into a normalised copy.
 */

export function isLatexSource(text: string): boolean {
  return /\\documentclass|\\begin\s*\{document\}/.test(text)
}

/** Reads a `{...}` group starting at `openIdx`, honouring nesting and escapes. */
function readGroup(text: string, openIdx: number): { content: string; end: number } | null {
  if (text[openIdx] !== '{') return null
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { content: text.slice(openIdx + 1, i), end: i + 1 }
    }
  }
  return null
}

interface Command {
  content: string
  /** Offset of the backslash. */
  start: number
  /** Offset just past the closing brace. */
  end: number
  /** Offset of the first character inside the braces. */
  contentStart: number
}

function findCommand(text: string, name: string, from = 0): Command | null {
  const re = new RegExp(`\\\\${name}\\s*\\{`, 'g')
  re.lastIndex = from
  const m = re.exec(text)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const g = readGroup(text, open)
  if (!g) return null
  return { content: g.content, start: m.index, end: g.end, contentStart: open + 1 }
}

function findEnvironment(text: string, name: string): { content: string; start: number; end: number; contentStart: number } | null {
  const open = new RegExp(`\\\\begin\\s*\\{${name}\\}`).exec(text)
  if (!open) return null
  const close = new RegExp(`\\\\end\\s*\\{${name}\\}`).exec(text.slice(open.index))
  if (!close) return null
  const contentStart = open.index + open[0].length
  const contentEnd = open.index + close.index
  return {
    content: text.slice(contentStart, contentEnd),
    start: open.index,
    end: open.index + close.index + close[0].length,
    contentStart,
  }
}

/** Strips markup so word counts reflect prose, not macros. */
export function stripLatex(src: string): string {
  let t = src

  // Comments, but not an escaped percent.
  t = t.replace(/(^|[^\\])%.*$/gm, '$1')
  // Preamble.
  const doc = /\\begin\s*\{document\}/.exec(t)
  if (doc) t = t.slice(doc.index + doc[0].length)
  t = t.replace(/\\end\s*\{document\}[\s\S]*$/, '')
  // Floats and display math contribute layout, not prose.
  t = t.replace(/\\begin\s*\{(figure|table|tabular|equation|align|algorithm|lstlisting|verbatim)\*?\}[\s\S]*?\\end\s*\{\1\*?\}/g, ' ')
  t = t.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ')
  t = t.replace(/\\\[[\s\S]*?\\\]/g, ' ')
  // Commands that carry no prose.
  t = t.replace(/\\(cite[a-z]*|label|ref|eqref|autoref|includegraphics|usepackage|documentclass|geometry|bibliographystyle|bibliography|vspace|hspace|centering|maketitle|newpage|item)\s*(\[[^\]]*\])?\s*(\{[^{}]*\})?/g, ' ')
  // Remaining commands: drop the name, keep any braced text.
  t = t.replace(/\\[a-zA-Z@]+\s*(\[[^\]]*\])?/g, ' ')
  t = t.replace(/[{}]/g, ' ')
  t = t.replace(/\\\\/g, ' ')
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length
}

const NUMERIC_STYLE = /^(plain|unsrt|abbrv|alpha|ieeetr|acm|siam|IEEEtran|elsarticle-num)$/i
const AUTHOR_YEAR_STYLE = /^(plainnat|abbrvnat|unsrtnat|apalike|agsm|chicago|dinat|kluwer|nature|elsarticle-harv|iclr\w*|neurips\w*|icml\w*|acl_natbib)$/i

export function detectLatexCitationStyle(src: string): CitationStyle {
  const style = findCommand(src, 'bibliographystyle')?.content.trim()
  if (style) {
    if (AUTHOR_YEAR_STYLE.test(style)) return 'author-year'
    if (NUMERIC_STYLE.test(style)) return 'numeric'
  }
  // natbib's parenthetical/textual commands imply author–year.
  if (/\\cite[pt]\*?\s*[[{]/.test(src) || /\\citeauthor|\\citeyear/.test(src)) return 'author-year'
  if (/\\cite\s*[[{]/.test(src)) return 'numeric'
  return 'unknown'
}

/** Canonical names so venue rules like "Limitations" match a \section title. */
const CANONICAL: [RegExp, string][] = [
  [/^abstract$/i, 'Abstract'],
  [/^introduction$/i, 'Introduction'],
  [/^related\s+works?$/i, 'Related Work'],
  [/^background$/i, 'Background'],
  [/^(method(s|ology)?|approach)$/i, 'Method'],
  [/^(experiments?|experimental\s+setup)$/i, 'Experiments'],
  [/^results?$/i, 'Results'],
  [/^(discussion|analysis)$/i, 'Discussion'],
  [/^limitations?$/i, 'Limitations'],
  [/^(ethics|ethics\s+statement|broader\s+impacts?)$/i, 'Ethics Statement'],
  [/^reproducibility(\s+statement)?$/i, 'Reproducibility Statement'],
  [/^conclusions?(\s+and\s+future\s+work)?$/i, 'Conclusion'],
  [/^acknowledge?ments?$/i, 'Acknowledgements'],
  [/^(funding|funding\s+statement)$/i, 'Funding'],
  [/^appendix.*$/i, 'Appendix'],
]

function canonicalise(label: string): string {
  const clean = stripLatex(label).replace(/\s+/g, ' ').trim()
  for (const [re, name] of CANONICAL) if (re.test(clean)) return name
  return clean || 'Section'
}

export function parseLatexManuscript(src: string): ParsedManuscript {
  const text = src.replace(/\r\n?/g, '\n')

  const titleCmd = findCommand(text, 'title')
  const authorCmd = findCommand(text, 'author')
  const abstractEnv = findEnvironment(text, 'abstract')

  // Where the bibliography starts — the body ends there.
  const bibEnv = findEnvironment(text, 'thebibliography')
  const bibCmd = findCommand(text, 'bibliography')
  const endDoc = /\\end\s*\{document\}/.exec(text)
  const bodyEnd = Math.min(
    ...[bibEnv?.start, bibCmd?.start, endDoc?.index, text.length].filter(
      (n): n is number => typeof n === 'number',
    ),
  )

  const sections: Section[] = []

  if (abstractEnv) {
    sections.push({
      name: 'Abstract',
      body: abstractEnv.content.trim(),
      start: abstractEnv.start,
      end: abstractEnv.end,
      level: 1,
    })
  }

  // \section and \subsection headings, in document order.
  const heads: { name: string; start: number; bodyStart: number; level: number }[] = []
  const re = /\\(sub)?section\*?\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1
    const g = readGroup(text, open)
    if (!g) continue
    heads.push({ name: canonicalise(g.content), start: m.index, bodyStart: g.end, level: m[1] ? 2 : 1 })
    re.lastIndex = g.end
  }

  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].start : bodyEnd
    sections.push({ name: h.name, body: text.slice(h.bodyStart, end).trim(), start: h.start, end, level: h.level })
  })
  sections.sort((a, b) => a.start - b.start)

  // References: inline thebibliography, or a .bib the user pasted alongside.
  let references: string[] = []
  if (bibEnv) {
    references = bibEnv.content
      .split(/\\bibitem/)
      .slice(1)
      .map((s) => stripLatex(s).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  } else {
    const bibEntries = text.match(/^@\w+\s*\{/gm)
    if (bibEntries) references = bibEntries.map((_, i) => `bib entry ${i + 1}`)
  }

  const prose = stripLatex(text.slice(0, bodyEnd))
  const bodyWords = countWords(prose)

  return {
    raw: text,
    format: 'latex',
    title: titleCmd ? stripLatex(titleCmd.content).replace(/\s+/g, ' ').trim() : null,
    author_block: authorCmd ? authorCmd.content.trim() : null,
    abstract: abstractEnv ? stripLatex(abstractEnv.content).trim() : null,
    sections,
    references,
    in_text_style: detectLatexCitationStyle(text),
    word_count: countWords(stripLatex(text)),
    body_word_count: bodyWords,
    // LaTeX prose compiles denser than a plain-text estimate suggests.
    estimated_pages: Math.max(1, Math.ceil(bodyWords / 750)),
  }
}

/**
 * Span of the text *inside* an environment or command, in the original source.
 *
 * ParsedManuscript stores the abstract and title stripped of markup so the model
 * reads prose, which means they cannot be located by string search in the raw
 * LaTeX. Edits need the real span instead.
 */
export function innerSpan(text: string, kind: 'abstract' | 'title'): { start: number; end: number } | null {
  if (kind === 'abstract') {
    const open = /\\begin\s*\{abstract\}/.exec(text)
    if (!open) return null
    const rest = text.slice(open.index)
    const close = /\\end\s*\{abstract\}/.exec(rest)
    if (!close) return null
    return { start: open.index + open[0].length, end: open.index + close.index }
  }
  const cmd = findCommand(text, 'title')
  return cmd ? { start: cmd.contentStart, end: cmd.end - 1 } : null
}

/** True when the bibliography lives in a separate .bib the user did not paste. */
export function hasExternalBibliography(src: string): boolean {
  return /\\bibliography\s*\{/.test(src) && !/\\begin\s*\{thebibliography\}/.test(src) && !/^@\w+\s*\{/m.test(src)
}
