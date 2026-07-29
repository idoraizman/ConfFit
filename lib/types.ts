import type { ModuleName } from './modules'

// ─── Wire format required by the project spec ────────────────────────────────

/**
 * One entry per LLM call, in order.
 *
 * The spec writes the prompt keys as `System_prompt` / `User_prompt` in the
 * schema block but as `system_prompt` / `user_prompt` in its worked example.
 * We emit both spellings so either reading validates.
 */
export interface Step {
  module: ModuleName
  prompt: {
    system_prompt: string
    user_prompt: string
    System_prompt: string
    User_prompt: string
  }
  response: Record<string, unknown>
}

export interface ExecuteOk {
  status: 'ok'
  error: null
  response: string
  steps: Step[]
}

export interface ExecuteErr {
  status: 'error'
  error: string
  response: null
  steps: Step[]
}

export type ExecuteResult = ExecuteOk | ExecuteErr

// ─── Domain model ────────────────────────────────────────────────────────────

export type CitationStyle = 'numeric' | 'author-year' | 'unknown'

/**
 * The parts of a venue's LaTeX template that can be verified from the author's
 * source.
 *
 * Deliberately narrow. Most typographic rules a venue publishes — 10pt type,
 * a 5.5x9 inch text block, Times, small-caps headings — are imposed by the
 * style file itself, so looking for them in a .tex proves nothing. They live in
 * the RAG corpus instead. What the source *does* determine is preamble hygiene,
 * and that is what this describes.
 */
export interface TemplateSpec {
  /** Style package the venue requires, e.g. "iclr2026_conference". */
  style_package: string | null
  /** The \bibliographystyle the venue requires. */
  bibliography_style: string | null
  /** Style options that switch anonymity off, e.g. ["final", "preprint"]. */
  deanonymising_options: string[]
  /** Macros that must not appear in a submission, e.g. ["\\iclrfinalcopy"]. */
  forbidden_macros: string[]
  /** The venue forbids changing the text rectangle it defines. */
  forbids_layout_override: boolean
  /** Where the author downloads the template. */
  template_url: string | null
}

export interface FormatRules {
  /** Main-body page limit, excluding references/appendix. */
  page_limit: number | null
  /** Whether references count against the page limit. */
  references_in_limit: boolean | null
  /** Max words in the abstract. */
  abstract_word_limit: number | null
  /** ICLR: "The abstract must be limited to one paragraph." */
  abstract_single_paragraph: boolean | null
  /** Double-blind submission. */
  anonymous: boolean | null
  citation_style: CitationStyle
  /** Human-readable template name, e.g. "ICLR 2027 LaTeX style (natbib)". */
  template: string | null
  /** Machine-checkable template requirements; null when the venue's are unknown. */
  template_spec: TemplateSpec | null
  /** Sections whose absence is a rule violation (ACL desk-rejects without one). */
  required_sections: string[]
  /**
   * Sections the venue encourages but does not mandate. Kept separate because
   * reporting "strongly encouraged" as a failure is an over-claim — it sends
   * authors chasing a problem the venue does not actually have.
   */
  recommended_sections: string[]
  /** Anything the profiler could not resolve; drives the ReAct rules_lookup. */
  unresolved: string[]
}

export interface ConferenceProfile {
  /** Canonical slug, e.g. "iclr-2027". Used as the Pinecone namespace. */
  venue_id: string
  /** Display name, e.g. "ICLR 2027". */
  venue: string
  focus_areas: string[]
  valued_criteria: string[]
  accepted_paper_emphasis: string[]
  format_rules: FormatRules
  /**
   * Where the profile came from — the built-in seed corpus, the cache, a CFP the
   * agent fetched, or guidelines the author pasted in when no page could be read.
   */
  source: 'seed' | 'cache' | 'ingested' | 'provided'
  source_url: string | null
  updated_at: string
}

// ─── Manuscript ──────────────────────────────────────────────────────────────

export interface Section {
  name: string
  body: string
  /** Character offsets into the original manuscript text. */
  start: number
  end: number
  /**
   * Heading depth: 1 for \section, 2 for \subsection. A top-level section whose
   * prose lives entirely in its subsections has an empty `body`, so anything
   * that wants "the text of the introduction" must walk the deeper levels too —
   * see sectionProse().
   */
  level: number
}

export interface ParsedManuscript {
  raw: string
  /** Drives heading detection, mechanical fixes and how the fixer must write. */
  format: 'text' | 'latex'
  title: string | null
  /** The block between the title and the abstract (authors + affiliations). */
  author_block: string | null
  abstract: string | null
  sections: Section[]
  references: string[]
  /** Numbered `[3]` vs parenthetical `(Smith, 2020)` in-text citations. */
  in_text_style: CitationStyle
  word_count: number
  /** Body words, i.e. excluding the reference list. */
  body_word_count: number
  estimated_pages: number
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown'

export interface CheckResult {
  rule: string
  status: CheckStatus
  /** What the deterministic check actually measured. */
  detail: string
  suggestion: string
  /** Verbatim excerpt that triggered a fail/warn, for the UnifiedFixer. */
  evidence?: string
}

export interface FormatReport {
  venue: string
  checklist: CheckResult[]
  /** Fixes code already applied without an LLM. */
  mechanical_fixes: string[]
  /** Rules the ReAct loop had to look up because the profile was silent. */
  looked_up: string[]
}

export interface FramingProposal {
  angle: string
  foreground: string[]
  background: string[]
  suggested_title: string
  suggested_abstract: string
  intro_opening: string
  rationale: string
}

export interface FramingCritique {
  critique: string
  pros: string[]
  cons: string[]
  unsupported_claims: string[]
  verdict: 'accept' | 'revise'
  revision_notes: string
}

export interface FramingReport {
  venue: string
  proposal: FramingProposal
  critique: FramingCritique
  iterations: number
}

/**
 * A single splice the UnifiedFixer asks code to apply.
 *
 * Targets are deliberately narrow: "title", "abstract", "intro_opening" (the
 * first paragraph of the introduction only) and "section:<Name>". Offering the
 * whole introduction as a replace target would let a model that writes only an
 * opening silently delete the rest of the section.
 */
export interface Edit {
  target: string
  action: 'replace' | 'delete' | 'insert'
  new_text: string
  reason: string
}

// ─── Routing & session ───────────────────────────────────────────────────────

export type Task = 'framing' | 'format' | 'both'

export interface Route {
  target_conference: string | null
  task: Task
  is_approval_reply: boolean
  /** A CFP URL the user pasted directly in their prompt, if any. */
  provided_url: string | null
  notes: string | null
}

/** Persisted while we wait for the user to approve ingesting a new venue. */
export interface PendingApproval {
  session_id: string
  venue: string
  venue_id: string
  proposed_url: string
  /** The original request, replayed verbatim once the user approves. */
  original_prompt: string
  task: Task
  created_at: string
}

export interface RunUsage {
  llm_calls: number
  prompt_tokens: number
  completion_tokens: number
  embedding_calls: number
}
