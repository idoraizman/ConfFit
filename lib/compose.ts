/**
 * Helpers for composing the prompt template in the browser.
 *
 * Kept separate from lib/manuscript.ts so the client bundle does not pull in
 * the whole manuscript parser just to drop a file into the textarea.
 */

/** Extensions we can read as text. PDF and .docx are deliberately excluded. */
export const ACCEPTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.tex', '.rst', '.text'] as const

/** Generous ceiling; the server rejects anything over 200k characters. */
export const MAX_FILE_BYTES = 2_000_000

/*
 * Guideline attachments — the venue's rules, not the author's paper. PDFs are
 * accepted here (and only here) because that is how venues publish formatting
 * instructions; the text is extracted on the server, so the browser ships no PDF
 * engine. The limits are stated on both sides: the client so the author is told
 * before uploading, the server because it cannot trust the client.
 */
export const GUIDELINE_EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown', '.tex', '.rst', '.text'] as const
export const MAX_GUIDELINE_FILE_BYTES = 4_000_000
/** Total before base64 expansion, which is a third larger, under the 4.5 MB body limit. */
export const MAX_GUIDELINE_TOTAL_BYTES = 3_000_000
export const MAX_GUIDELINE_FILES = 5

export function isGuidelineFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return GUIDELINE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

const FIELD_START = /^\s*(notes|target\s+conference|conference|venue|task)\s*:/i
const PAPER_START = /^\s*(paper|manuscript)\s*:/i

// Control characters that never appear in real text: C0 except tab, LF, VT, FF
// and CR, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function isAcceptedFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Rejects content that is not really text.
 *
 * A dropped PDF is the common case: it decodes without throwing but is full of
 * control bytes, and pasting it into the prompt would waste a run.
 */
export function looksBinary(text: string): boolean {
  if (text.startsWith('%PDF-')) return true
  if (text.startsWith('PK\u0003\u0004')) return true // .docx / .odt / .zip container
  const sample = text.slice(0, 4000)
  if (sample.includes('\u0000')) return true
  const control = (sample.match(CONTROL) ?? []).length
  return control / Math.max(1, sample.length) > 0.02
}

/**
 * Splices `paper` into the `Paper:` field of the current prompt, leaving the
 * other template fields the user already filled in untouched.
 *
 * If there is no template yet, one is created around the paper.
 */
export function withPaper(current: string, paper: string): string {
  const body = paper.replace(/\r\n?/g, '\n').trim()
  const lines = current.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((l) => PAPER_START.test(l))

  if (start === -1) {
    // Keep any header the user already typed; otherwise start a fresh template.
    return lines.some((l) => FIELD_START.test(l))
      ? `${current.trimEnd()}\nPaper: ${body}`
      : `Target conference: \nTask: both\nPaper: ${body}`
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (FIELD_START.test(lines[i])) {
      end = i
      break
    }
  }
  return [...lines.slice(0, start), `Paper: ${body}`, ...lines.slice(end)].join('\n')
}

export function describeFile(name: string, text: string): string {
  const words = (text.match(/\S+/g) ?? []).length
  const size =
    text.length >= 1000 ? `${Math.round(text.length / 1000)}k characters` : `${text.length} characters`
  return `${name} — ${words.toLocaleString()} words, ${size}`
}
