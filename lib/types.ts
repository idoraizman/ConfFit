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

export interface FormatRules {
  /** Main-body page limit, excluding references/appendix. */
  page_limit: number | null
  /** Whether references count against the page limit. */
  references_in_limit: boolean | null
  /** Max words in the abstract. */
  abstract_word_limit: number | null
  /** Double-blind submission. */
  anonymous: boolean | null
  citation_style: CitationStyle
  /** Human-readable template name, e.g. "ICLR 2027 LaTeX style (natbib)". */
  template: string | null
  /** Sections the venue expects to be present. */
  required_sections: string[]
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
  /** Where the profile came from — seed corpus, cache, or a fetched CFP. */
  source: 'seed' | 'cache' | 'ingested'
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
}

export interface ParsedManuscript {
  raw: string
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
