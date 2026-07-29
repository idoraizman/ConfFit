import { config } from '../config'
import { MODULES } from '../modules'
import type { Tracer } from '../trace'
import type { ParsedManuscript, Section } from '../types'

/**
 * Structure recovery — the Supervisor's pre-processing fallback.
 *
 * Parsing is normally free: LaTeX, markdown, numbered and ALL-CAPS headings are
 * all detected in code. But text copied out of a rendered PDF often arrives with
 * every heading flattened into the body, and then the deterministic parser finds
 * nothing — which would make the format report describe a paper it never really
 * read (no sections, no abstract, a page count off by the whole reference list).
 *
 * So we spend one model call, and only when the deterministic parse is
 * implausible. Two properties make this safe to bolt onto a deterministic core:
 *
 *  - The model returns verbatim anchors, not offsets. We locate each anchor in
 *    the source ourselves, so every span still points at real characters and the
 *    UnifiedFixer's edits keep splicing correctly. An anchor we cannot find is
 *    discarded rather than guessed at.
 *  - It only ever adds structure to a parse that had none. It cannot overturn a
 *    measurement, so a well-formed manuscript is never at its mercy.
 *
 * Logged as Supervisor: the architecture assigns manuscript pre-processing to
 * the Supervisor, so this introduces no new module to the trace or the diagram.
 */

const SYSTEM = `You are given the raw text of an academic paper whose heading structure was lost (for example, copied out of a rendered PDF). Identify where its sections begin.
Return a JSON object only:
{"sections":[{"name":"<canonical section name>","anchor":"<the first 6-10 words of that section, copied EXACTLY from the text>"}]}
Rules:
- Use canonical names where they apply: Abstract, Introduction, Related Work, Background, Method, Experiments, Results, Discussion, Limitations, Ethics Statement, Reproducibility Statement, Conclusion, Acknowledgements, References, Appendix. Otherwise use the heading as written.
- The anchor MUST be copied character-for-character from the text, including capitalisation. Do not paraphrase, correct, or shorten words. If a heading line is present, the anchor is that heading line.
- List sections in the order they appear. Return an empty list if the text is not an academic paper.`

/** True when the deterministic parse clearly failed to find a paper's shape. */
export function looksUnparsed(m: ParsedManuscript): boolean {
  if (m.body_word_count < 400) return false // too short to have sections anyway
  if (m.sections.length === 0) return true
  // A long manuscript with one or two detected headings and no abstract is the
  // signature of flattened PDF text.
  return m.sections.length <= 2 && !m.abstract
}

interface Recovered {
  sections?: { name?: string; anchor?: string }[]
}

export async function recoverStructure(tracer: Tracer, m: ParsedManuscript): Promise<Section[]> {
  const text = m.raw
  const sent = text.slice(0, config.limits.structureRecoveryChars)

  const result = await tracer.callJson<Recovered>(MODULES.SUPERVISOR, {
    system: SYSTEM,
    user:
      sent.length < text.length
        ? `${sent}\n\n[text truncated after ${sent.length} of ${text.length} characters]`
        : sent,
    maxTokens: 800,
    mock: { sections: [{ name: 'Introduction', anchor: text.slice(0, 40) }] },
  })

  const found: { name: string; start: number }[] = []
  let cursor = 0

  for (const s of result.sections ?? []) {
    const name = typeof s.name === 'string' ? s.name.trim() : ''
    const anchor = typeof s.anchor === 'string' ? s.anchor.trim() : ''
    if (!name || anchor.length < 8) continue

    const at = locate(text, anchor, cursor)
    if (at === -1) continue // anchor not in the source — drop it rather than guess
    found.push({ name, start: at })
    cursor = at + 1
  }

  if (!found.length) return []

  return found.map((h, i) => {
    const end = i + 1 < found.length ? found[i + 1].start : text.length
    return { name: h.name, body: text.slice(h.start, end).trim(), start: h.start, end, level: 1 }
  })
}

/**
 * Finds an anchor tolerantly: exact match first, then ignoring whitespace
 * differences, which is where re-wrapped PDF text usually diverges.
 */
function locate(text: string, anchor: string, from: number): number {
  const exact = text.indexOf(anchor, from)
  if (exact !== -1) return exact

  const words = anchor.split(/\s+/).filter(Boolean).slice(0, 8)
  if (words.length < 3) return -1
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const m = new RegExp(pattern, 'i').exec(text.slice(from))
  return m ? from + m.index : -1
}
