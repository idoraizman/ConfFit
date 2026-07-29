import { looksBinary } from './compose'
import { chunk } from './store/vector'

/**
 * Reading venue guidelines out of what the author hands over.
 *
 * The human-in-the-loop gate never goes looking for a venue's rules on its own —
 * measured from the deployed server, the only reachable search engine answers a
 * query for a real conference with genealogy forums and a supermarket. So the
 * author supplies the source: a link, one or more files, or pasted text. Files
 * are usually PDFs, because that is the form venues publish formatting
 * instructions in.
 */

export interface ExtractedFile {
  name: string
  text: string
  /** Set when the file yielded nothing usable, for a message the author can act on. */
  problem: string | null
}

/**
 * Pulls the text out of one uploaded guidelines file.
 *
 * PDFs are parsed with pdf.js on the server rather than in the browser, so a
 * pasted PDF *link* can travel through exactly the same extraction as an upload.
 */
export async function extractFile(name: string, bytes: Uint8Array): Promise<ExtractedFile> {
  if (/\.pdf$/i.test(name)) {
    const { text, pages } = await extractPdfText(bytes)
    if (!text.trim()) {
      return {
        name,
        text: '',
        problem:
          pages > 0
            ? `${name} has ${pages} page(s) but no text layer — it looks like a scan or an image export, so there is nothing to read. Send a text-based PDF, or copy the rules in as text.`
            : `${name} could not be opened as a PDF.`,
      }
    }
    return { name, text, problem: null }
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!text.trim()) return { name, text: '', problem: `${name} is empty.` }
  // A .docx or an image renamed .txt decodes without throwing but is not text.
  if (looksBinary(text)) {
    return {
      name,
      text: '',
      problem: `${name} does not look like text. ConfFit reads PDFs and plain text — export a Word document as PDF, or paste the rules in.`,
    }
  }
  return { name, text, problem: null }
}

/** Extracts the text layer of a PDF. Returns page count so a scan can be named as such. */
export async function extractPdfText(bytes: Uint8Array, maxPages = 30): Promise<{ text: string; pages: number }> {
  // Imported lazily: nothing else in a run needs pdf.js, and it is a large module.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: false,
      // A CFP is text; skipping the rest keeps a serverless invocation small.
      disableFontFace: true,
    }).promise

    const pages: string[] = []
    for (let i = 1; i <= Math.min(maxPages, doc.numPages); i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/[ \t]{2,}/g, ' '),
      )
    }
    return { text: pages.join('\n\n').trim(), pages: doc.numPages }
  } catch (e) {
    console.warn('[guidelines] PDF extraction failed:', (e as Error).message)
    return { text: '', pages: 0 }
  } finally {
    await doc?.destroy().catch(() => {})
  }
}

/** Vocabulary that marks a passage as stating a submission rule rather than prose. */
const RULE_SIGNALS: [RegExp, number][] = [
  [/\bpage limit\b|\b\d+\s*pages?\b|\bmaximum of \d+\b/gi, 3],
  [/anonym|double.blind|single.blind|\bblind review\b/gi, 3],
  [/\btemplate\b|\bstyle file\b|\.sty\b|\bacmart\b|\blatex\b|\bword\b/gi, 2],
  [/\bcitation\b|\bbibliograph|\bnatbib\b|\bcite\b/gi, 2],
  [/\babstract\b.{0,40}\b(word|limit|character)/gi, 3],
  [/\bmargin|\bfont size\b|\bcolumn\b|\btext area\b|\bpoint\b/gi, 1],
  [/desk.reject|\brequired\b|\bmust\b|\bmandatory\b|\bnot permitted\b/gi, 1],
  [/\bdeadline\b|\bsubmission site\b|\bsupplementary\b|\bappendix\b/gi, 1],
]

/**
 * Keeps the parts of a long source that actually state rules.
 *
 * One five-page formatting-instructions PDF extracts to more than the synthesis
 * budget on its own, and the author was invited to send several files. Slicing
 * the concatenation would silently drop whatever came last — quite possibly the
 * page limit — and produce a confident profile with a hole in it. So passages are
 * scored against the vocabulary rules are written in, and the highest-scoring
 * ones are kept in their original order until the budget is full.
 */
export function selectRulePassages(text: string, budget: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= budget) return trimmed

  const passages = chunk(trimmed, 1400, 100)
  const scored = passages.map((passage, index) => {
    let score = 0
    for (const [re, weight] of RULE_SIGNALS) {
      const matches = passage.match(re)
      if (matches) score += weight * Math.min(matches.length, 4)
    }
    return { passage, index, score }
  })

  const kept: typeof scored = []
  let used = 0
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (item.score === 0) break
    if (used + item.passage.length > budget) continue
    kept.push(item)
    used += item.passage.length
  }
  // Nothing scored: fall back to the head, which is where a short CFP states its rules.
  if (!kept.length) return trimmed.slice(0, budget)

  kept.sort((a, b) => a.index - b.index)
  const dropped = passages.length - kept.length
  const note = dropped > 0 ? `\n\n[${dropped} passage(s) that stated no submission rule were left out.]` : ''
  return kept.map((k) => k.passage).join('\n\n') + note
}

/** One text blob for synthesis, plus a label naming where it came from. */
export interface ProvidedGuidelines {
  text: string
  label: string
  problems: string[]
}

export function combineFiles(files: ExtractedFile[]): ProvidedGuidelines {
  const usable = files.filter((f) => f.text.trim())
  return {
    text: usable.map((f) => `--- ${f.name} ---\n${f.text.trim()}`).join('\n\n'),
    label: usable.length
      ? `${usable.length} uploaded file${usable.length === 1 ? '' : 's'}: ${usable.map((f) => f.name).join(', ')}`
      : '',
    problems: files.filter((f) => f.problem).map((f) => f.problem as string),
  }
}
