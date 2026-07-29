/**
 * Single source of truth for module names.
 *
 * The project spec requires that sub-module / sub-agent names are identical
 * across (a) the architecture PNG, (b) the `steps` trace of /api/execute and
 * (c) every description we publish. Everything that names a module imports
 * from here — the PNG renderer, /api/agent_info and the tracer — so the three
 * surfaces cannot drift apart.
 */
export const MODULES = {
  SUPERVISOR: 'Supervisor',
  PROFILER: 'ConferenceProfiler',
  FRAMING: 'FramingAgent',
  FRAMING_REFLECT: 'FramingReflect',
  FORMAT: 'FormatComplianceAgent',
  FIXER: 'UnifiedFixer',
} as const

export type ModuleName = (typeof MODULES)[keyof typeof MODULES]

export const MODULE_LIST: ModuleName[] = Object.values(MODULES)

/** One-line role of each module, reused by /api/agent_info and the diagram. */
export const MODULE_ROLES: Record<ModuleName, string> = {
  [MODULES.SUPERVISOR]:
    'Thin coordinator. Routes at runtime (which venue, which workers), then merges the workers’ output into the final response.',
  [MODULES.PROFILER]:
    'ReAct + RAG over the venue’s Call-for-Papers and past accepted papers. Produces the ConferenceProfile. Guarded by a human-in-the-loop gate: an unknown venue is never ingested without the user’s approval.',
  [MODULES.FRAMING]:
    'Reflection agent, Generate half. Proposes how to re-position the paper for the venue and rewrites title / abstract / intro opening.',
  [MODULES.FRAMING_REFLECT]:
    'Reflection agent, Reflect half. Critiques the proposal against the ConferenceProfile and flags claims the paper does not support. Loop capped at N ≤ 2.',
  [MODULES.FORMAT]:
    'ReAct agent. Deterministic rule checks (page limits, abstract length, citation style, anonymity, required sections) in code; calls rules_lookup only when a rule is ambiguous. Produces the format report.',
  [MODULES.FIXER]:
    'Applies the framing report and the format report to the manuscript in a single pass, emitting edits that code splices in to produce one revised manuscript.',
}

/** Tools exposed to the ReAct agents (MCP-style tools/list, tools/call). */
export const TOOLS = ['web_search', 'web_fetch', 'vector_search', 'rules_lookup'] as const
export type ToolName = (typeof TOOLS)[number]
