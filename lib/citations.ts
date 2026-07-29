/**
 * Citation-command conversion for LaTeX manuscripts.
 *
 * The venue decides the style, so when it requires one and the source uses the
 * other, ConfFit converts rather than merely reporting it.
 *
 * The two directions are not symmetric:
 *
 *  - to numeric is purely mechanical. \citep{x} and \citet{x} both collapse to
 *    \cite{x}, so it runs in code for no tokens.
 *  - to author-year needs judgement exactly once per site: natbib's \citet
 *    renders "Smith et al. (2020)" and reads as part of the sentence, while
 *    \citep renders "(Smith et al., 2020)" and is parenthetical support.
 *    Picking the wrong one produces grammatical nonsense, so that choice is the
 *    one thing here worth a model call — over the citing sentences only, never
 *    the whole paper.
 */

export interface CiteSite {
  /** Offset of the backslash. */
  start: number
  /** Offset just past the closing brace. */
  end: number
  command: string
  /** Optional args, e.g. the "see" in \cite[see][]{x}. */
  optional: string
  keys: string
  /** Surrounding prose, for the citet/citep decision. */
  context: string
}

const CITE = /\\(cite[a-zA-Z]*)\s*((?:\[[^\]]*\]\s*)*)\{([^}]*)\}/g

export function findCiteSites(src: string): CiteSite[] {
  const out: CiteSite[] = []
  let m: RegExpExecArray | null
  CITE.lastIndex = 0
  while ((m = CITE.exec(src))) {
    const start = m.index
    const end = start + m[0].length
    out.push({
      start,
      end,
      command: m[1],
      optional: m[2].trim(),
      keys: m[3].trim(),
      context: contextAround(src, start, end),
    })
  }
  return out
}

/** A window of prose around the citation, trimmed to sentence boundaries. */
function contextAround(src: string, start: number, end: number): string {
  const before = src.slice(Math.max(0, start - 220), start)
  const after = src.slice(end, end + 90)
  const sentenceStart = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n\n'))
  const lead = sentenceStart === -1 ? before : before.slice(sentenceStart + 1)
  return `${lead.trim()} <<CITE>> ${after.split(/(?<=\.)\s/)[0].trim()}`.replace(/\s+/g, ' ').slice(0, 320)
}

/** Rewrites the sites in one pass, back to front so offsets stay valid. */
function rewrite(src: string, edits: { site: CiteSite; command: string }[]): string {
  let out = src
  for (const { site, command } of [...edits].sort((a, b) => b.site.start - a.site.start)) {
    const opt = site.optional ? site.optional : ''
    out = out.slice(0, site.start) + `\\${command}${opt}{${site.keys}}` + out.slice(site.end)
  }
  return out
}

export interface ConversionResult {
  text: string
  changed: number
  note: string | null
}

/** Author–year → numeric. Mechanical: no judgement, no tokens. */
export function convertToNumeric(src: string): ConversionResult {
  const sites = findCiteSites(src).filter((s) => /^cite[pt]\*?$/.test(s.command))
  if (!sites.length) return { text: src, changed: 0, note: null }
  return {
    text: rewrite(
      src,
      sites.map((site) => ({ site, command: 'cite' })),
    ),
    changed: sites.length,
    note: `Converted ${sites.length} \\citep/\\citet call(s) to \\cite for the venue's numeric style.`,
  }
}

/**
 * Verbs that, immediately after a citation, mean the citation was the subject:
 * "\citet{x} shows that ..." reads correctly, "(Smith, 2020) shows" does not.
 */
const VERB_AFTER =
  /^\s*(shows?|showed|proposes?|proposed|introduces?|introduced|demonstrates?|demonstrated|argues?|argued|finds?|found|reports?|reported|presents?|presented|observes?|observed|notes?|noted|extends?|extended|studies|studied|develops?|developed|applies|applied|uses?|used|considers?|considered)\b/i

/** Constructions that need the citation to supply a noun phrase. */
const TRIGGER_BEFORE =
  /\b(following|as in|unlike|similar to|compared to|proposed by|introduced by|building on|builds on|according to|described by|the work of)\s*$/i

/**
 * Picks \citet or \citep for one site, in code.
 *
 * \citep is the safe default: it is parenthetical, so it reads correctly
 * wherever a bare \cite did. \citet is only correct when the citation itself
 * supplies a noun the sentence needs — and getting that wrong produces visible
 * nonsense ("Marble Cheng et al. (2025) performs ..."), which is exactly the
 * failure mode when a sentence already names the system it is citing.
 *
 * So \citet is claimed only on two high-precision signals: the citation opens
 * the clause and is followed by a verb, or it follows a construction that
 * grammatically requires a noun. Everything else takes \citep.
 */
export function chooseCommand(site: CiteSite, src: string): 'citet' | 'citep' {
  const before = src.slice(Math.max(0, site.start - 120), site.start)
  const after = src.slice(site.end, site.end + 40)

  if (TRIGGER_BEFORE.test(before.replace(/\s+$/, ' ').trimEnd() + ' ')) return 'citet'

  // Clause-initial: the citation opens the sentence, so nothing but a sentence
  // break, a line break or a heading sits in front of it. A closing brace only
  // counts when it ends a sectioning command — otherwise "\textbf{Blender}
  // \cite{...}" would read as clause-initial when it is a named system.
  const trimmed = before.replace(/\s+$/, '')
  const clauseInitial =
    trimmed === '' ||
    /[.;:!?]$/.test(trimmed) ||
    /\\\\$/.test(trimmed) ||
    /\\(?:sub)*(?:section|paragraph)\*?\s*\{[^}]*\}$/.test(trimmed) ||
    /\\begin\s*\{[^}]*\}$/.test(trimmed)

  if (clauseInitial && VERB_AFTER.test(after)) return 'citet'

  return 'citep'
}

/**
 * Converts numeric-style \cite to natbib author-year, deciding each command in
 * code. No model call: an LLM asked to make this judgement misread the common
 * "named system, then citation" pattern often enough to emit ungrammatical
 * text, and the deterministic rule above is both safer and free.
 */
export function convertToAuthorYear(src: string): ConversionResult {
  const sites = findCiteSites(src).filter((s) => s.command === 'cite')
  if (!sites.length) return { text: src, changed: 0, note: null }

  let textual = 0
  const edits = sites.map((site) => {
    const command = chooseCommand(site, src)
    if (command === 'citet') textual++
    return { site, command }
  })

  return {
    text: rewrite(src, edits),
    changed: edits.length,
    note:
      `Converted ${edits.length} bare \\cite call(s) to natbib author–year: ` +
      `${textual} \\citet where the citation is the subject of the sentence, ${edits.length - textual} \\citep parenthetical.`,
  }
}
