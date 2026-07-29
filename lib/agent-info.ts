import { MODULE_ROLES, MODULES, TOOLS } from './modules'

/**
 * Static half of GET /api/agent_info. The prompt_examples are captured from
 * real runs by scripts/capture-examples.mjs and merged in by the route.
 */

export const DESCRIPTION = [
  'ConfFit is an author-facing agent that adapts an existing research paper to a specific academic conference. You give it a target venue, a task, and the manuscript; it returns a framing report, a format-compliance report, and one revised manuscript that applies both.',
  '',
  'What it CAN do: re-position a paper for a venue (which contribution to lead with, a rewritten title, abstract and introduction opening, grounded in the venue’s Call-for-Papers and the emphasis of its accepted papers); check the manuscript against the venue’s submission rules (page and abstract limits, citation style, required sections such as a Limitations or Reproducibility statement, and a double-blind anonymity scan); apply mechanical fixes itself (redacting the author block, removing contact emails, anonymising repository links, rephrasing self-referential citations, stripping acknowledgements); and merge everything into a single revised manuscript. It can profile a venue it has never seen by reading that venue’s Call-for-Papers — but only after the user approves it.',
  '',
  'What it CANNOT do (constraints): it never submits anything anywhere. It reads plain text, not PDF or LaTeX binaries, so page counts are estimates from word count and it cannot verify a compiled template. It does not verify citations or check for plagiarism — that is deliberately out of scope. It will not add a venue to its knowledge base without an explicit go-ahead from the user, and it will not write a claim the manuscript does not already support: the reflection critic exists specifically to strike unsupported claims out of the proposed framing. Requests unrelated to preparing a paper for a venue get a short explanation and the correct prompt shape instead of an answer.',
].join('\n')

export const PURPOSE =
  'Cut the weeks a research team spends re-positioning and re-formatting the same paper for each new venue down to a single pass: one prompt in, a venue-specific framing report, a rule-by-rule format report, and a submission-ready revised manuscript out.'

export const PROMPT_TEMPLATE = {
  template: [
    'Target conference: <venue name or CFP URL, e.g. "ICLR 2027">',
    'Task: <framing | format | both>',
    'Paper: <paste the manuscript text, or at minimum title + abstract + contributions + section headings>',
    'Notes: <optional context, e.g. "rejected from NeurIPS for being too applied">',
  ].join('\n'),
  example: [
    'Target conference: ICLR 2027',
    'Task: both',
    'Paper: Cache-Aware Routing for Mixture-of-Experts Inference',
    '',
    'Ann Researcher, Ben Coder',
    'Institute of Technology — ann@example.edu',
    '',
    'Abstract',
    'We present CAR, a router for mixture-of-experts inference that ...',
    '',
    '1. Introduction',
    '...',
    'Notes: we were rejected from NeurIPS for being "too systems-focused"',
  ].join('\n'),
  notes: [
    'The four fields are parsed in code, so the manuscript itself is never sent to the routing model — only a short header.',
    'If the target venue is not yet in the knowledge base, the agent replies with a confirmation question instead of ingesting it. Reply "yes" (or paste the correct CFP link) as a follow-up prompt to resume.',
    'Send an optional "session_id" alongside "prompt" to keep follow-ups on the same thread. The web UI does this automatically.',
  ],
}

export const ARCHITECTURE_SUMMARY = {
  pattern:
    'Supervisor coordinating one Reflection worker (FramingAgent / FramingReflect) and two ReAct workers (ConferenceProfiler, FormatComplianceAgent), finished by UnifiedFixer.',
  modules: Object.entries(MODULE_ROLES).map(([module, role]) => ({ module, role })),
  module_names: Object.values(MODULES),
  tools: TOOLS,
  models: {
    text: process.env.LLM_TEXT_MODEL?.trim() || 'MB5R2CF-azure/gpt-5.4-mini',
    embeddings: process.env.LLM_EMBED_MODEL?.trim() || 'MB5R2CF-azure/text-embedding-3-small',
  },
  data_layer: {
    supabase: 'conference-profile cache, pending human-in-the-loop approvals, run history',
    pinecone: 'CFP chunks and past accepted papers, one namespace per venue',
  },
  cost_profile: [
    'A cached venue costs 0 LLM calls in ConferenceProfiler.',
    'Manuscript parsing, every measurable format rule, and all mechanical fixes run in code.',
    'The reflection loop is capped at N ≤ 2, and the critic is only re-run when a further revision is still affordable.',
    'FormatComplianceAgent makes no LLM call at all when every rule passes and none is ambiguous.',
    'A full "both" run on a cached venue is typically 6 calls; the worst case, ingesting a new venue, is 9.',
  ],
}
