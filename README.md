# ConfFit — Agentic System for Academic Conference Submission

An author-facing agent that adapts a research paper to a target academic conference: it
re-frames the contribution for that venue and checks the manuscript against the venue's
submission rules, then returns **one revised manuscript** that applies both.

Course project · Itay Krausz, Ido Raizman, Roi Teichman

- **Live app:** https://conffit.vercel.app
- **Repository:** https://github.com/idoraizman/ConfFit
- **Architecture diagram:** https://conffit.vercel.app/api/model_architecture

---

## The problem

The same core research goes to many venues. Each rejection cycle burns weeks on
re-positioning rather than science, because every venue has (a) a different focus and a
different sense of what a good paper looks like, and (b) different formatting rules —
template, citation style, page limits, double-blind anonymity.

ConfFit does both passes in one run, grounded in the venue's own Call-for-Papers.

## Architecture

A thin **Supervisor** coordinating one Reflection worker and two ReAct workers.

```
POST /api/execute { prompt }
        │
   Supervisor ──────────── route · monitor · merge          (1 LLM call)
        │ dispatch
   ConferenceProfiler ──── ReAct + RAG over the CFP          (0 calls when cached)
        │                  ├─ cache HIT  → straight to the workers
        │ cache MISS       └─ cache MISS → HUMAN-IN-THE-LOOP GATE
        │                                  ask before ingesting anything
        ├──────────────────────────────┐
   FramingAgent                   FormatComplianceAgent
   Reflection: Generate →         ReAct over a deterministic core
   FramingReflect → repeat N≤2    rules_lookup only when a rule is ambiguous
        │ framing report               │ format report
        └──────────────┬───────────────┘
              UnifiedFixer ──────────── both reports, one pass, targeted edits
                     │
              Supervisor: merge ─────── response + steps[]
```

`Supervisor · ConferenceProfiler · FramingAgent · FramingReflect · FormatComplianceAgent ·
UnifiedFixer` — these six names are declared once in [`lib/modules.ts`](lib/modules.ts) and
consumed by the diagram renderer, `/api/agent_info` and every `steps` entry, so the three
surfaces cannot drift apart. `scripts/render_architecture.py` fails the render if a box
label and `lib/modules.ts` disagree.

### Why this shape

| Rejected as top level | Why not |
| --- | --- |
| A single flat ReAct loop | Mixes writing, rule checks and tool use; every step logs under one module, so the trace says nothing. |
| Plan-and-Execute | Its strength is re-planning one evolving task. Here the two tasks are known up front, so a planner is pure overhead. |

**Chosen: Supervisor.** It makes one runtime routing decision (which venue, which workers)
and one merge — that runtime choice is what makes this an agent rather than a fixed
pipeline. Framing uses **Reflection** because re-positioning is a judgement task with no
single right answer; format uses **ReAct** because rule checking is mostly deterministic and
only needs a tool when a rule is genuinely unclear.

## Cost discipline

The project budget is $13 total, so the design spends tokens only where judgement is
required:

- **Parsing is code, not tokens.** Splitting the manuscript into sections, counting words,
  detecting citation style, and scanning for anonymity leaks all run in `lib/manuscript.ts`
  and `lib/checks.ts`.
- **A cached venue costs nothing.** `ConferenceProfiler` returns a cached profile with zero
  LLM calls. Eight major venues ship pre-seeded, so the common case is a hit on the very
  first request.
- **The router never sees the manuscript.** `parsePrompt` extracts the template fields in
  code and hands the routing call a short header.
- **Each worker gets only its slice.** `FramingAgent` sees the title, abstract, contributions
  and introduction opening — never the whole paper. `UnifiedFixer` sees only the spans it may
  edit and returns targeted edits, which code splices in.
- **Calls are skipped when they would say nothing.** `FormatComplianceAgent` makes no LLM call
  at all if every rule passes and none is ambiguous; the reflection critic is not re-run when
  no further revision is affordable.
- **Structure recovery is a fallback, not a pass.** Asking the model to read the manuscript's
  shape on every run would cost ~10k prompt tokens and, worse, make a *checking* tool
  non-deterministic — the same paper could report a different page count twice. Code parses
  LaTeX, markdown and numbered headings; the model is only asked when that finds nothing, and
  it returns verbatim anchors that code locates, so edit offsets stay exact.
- **The reflection loop is capped** at N ≤ 2 in code, not by prompt instruction.

A full `both` run on a cached venue is typically **6 LLM calls**; the worst case — ingesting a
new venue — is **9**. Every response ends with the exact call and token count for that run.

## Human-in-the-loop RAG

ConfFit never silently crawls and ingests. When a venue is not in the knowledge base,
`/api/execute` returns a normal `status:"ok"` whose `response` is a confirmation question,
and the trace shows `ConferenceProfiler` reporting `wrote_to_knowledge_base: false`. The
user's next prompt (`yes`, or a pasted CFP link) resumes ingestion. No extra endpoint is
needed — it rides on the GUI's follow-up prompt support.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /` | The web UI. No authentication of any kind. |
| `GET /api/team_info` | Team and student details. |
| `GET /api/agent_info` | Description, purpose, prompt template, and worked examples with their full `steps` traces (captured from real runs and committed, so hitting this endpoint costs nothing). |
| `GET /api/model_architecture` | The architecture diagram as `image/png`. |
| `POST /api/execute` | `{ "prompt": "…" }` → `{ status, error, response, steps }`. Optionally accepts `session_id` for follow-ups. |

### Prompt template

```
Target conference: <venue name or CFP URL, e.g. "ICLR 2027">
Task: <framing | format | both>
Paper: <paste the manuscript text, or title + abstract + contributions + section headings>
Notes: <optional, e.g. "rejected from NeurIPS for being too applied">
```

Free-form prompts work too — the Supervisor's routing call fills in whatever the template
does not.

### Input formats

Paste the manuscript, or drop a `.txt` / `.md` / `.tex` file onto the composer in the web UI
(the browser reads it and fills the `Paper:` field — the API contract stays `{"prompt": "..."}`).

| Input | Handling |
| --- | --- |
| **LaTeX source** | Parsed natively: `\section`, `\subsection`, `\begin{abstract}`, `\title`, `\author`, `\thanks`, `\bibliographystyle` and `\cite`. Word counts exclude markup, maths and floats. The revision is returned as compilable LaTeX — macros, citations and equations survive untouched, anonymisation rewrites `\author{...}` in place, and a required section is inserted as `\section*{...}` before the bibliography. |
| **Markdown / plain text** | `#` headings, `1. Introduction`, and ALL-CAPS headings. |
| **Text copied out of a PDF** | Usually parses fine, since rendered headings survive the copy. If they do not, the Supervisor spends one call to recover the structure and says so in the response. |
| **PDF / .docx** | Not accepted. Programmatic extraction mangles two-column layouts badly enough to corrupt section parsing; copying the text out of a viewer gives much cleaner input. |

Paste `references.bib` alongside a `.tex` if you want the reference list checked —
`\bibliography{references}` points at a file the agent cannot open.

## Running locally

```bash
npm install
cp .env.example .env          # fill in LLMOD_API_KEY at minimum
npm run dev                   # http://localhost:3000
```

Without any credentials the app still runs: `MOCK_LLM` engages automatically when
`LLMOD_API_KEY` is empty, Supabase falls back to an in-process store, and Pinecone falls back
to an in-process cosine search. That is enough to exercise every code path for free.

### Tests

```bash
npm test                                   # contract test against localhost:3000
npm run test:live                          # …plus two full agent runs
node scripts/smoke-test.mjs https://… --live   # against the deployed app
```

The contract test asserts the exact response shapes the specification requires: the four
endpoints, the `status/error/response/steps` top-level keys, every `steps` entry's module
name against `lib/modules.ts`, both prompt-key spellings, the PNG magic bytes, and that the
GUI loads without an auth redirect.

### Regenerating the diagram

```bash
python3 -m venv .venv && .venv/bin/pip install Pillow
.venv/bin/python scripts/render_architecture.py
```

Writes `public/architecture.png` and the base64 module `lib/architecture-png.ts` that
`/api/model_architecture` serves. Bundling the bytes as a module rather than reading
`public/` at request time keeps the endpoint independent of the serverless bundle layout.

### Regenerating the `agent_info` examples

```bash
npm run dev                       # with a real LLMOD_API_KEY
node scripts/capture-examples.mjs
```

Captures three real runs — a cached-venue `both` run, a `format`-only run that shows routing
skipping `FramingAgent`, and the human-in-the-loop gate — into `lib/agent-examples.json`. It
refuses to write mock output.

## Deployment

Deployed on Vercel. All routes run on the Node.js runtime; `/api/execute` declares
`maxDuration = 300` to match the platform ceiling, though a real run finishes far inside it.

Environment variables to set in the Vercel project:

| Variable | Required | Notes |
| --- | --- | --- |
| `LLMOD_API_KEY` | yes | LLMod.ai key for the group. |
| `LLMOD_BASE_URL` | yes | OpenAI-compatible base that serves `/chat/completions` and `/embeddings`. |
| `LLM_TEXT_MODEL` | no | Defaults to `MB5R2CF-azure/gpt-5.4-mini`. |
| `LLM_EMBED_MODEL` | no | Defaults to `MB5R2CF-azure/text-embedding-3-small`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | no | Profile cache, pending approvals, run history. Falls back to memory. |
| `PINECONE_API_KEY`, `PINECONE_INDEX` | no | RAG store. Falls back to memory. Create the index with `npm run setup:pinecone`. |
| `TEAM_BATCH_ORDER`, `TEAM_EMAIL_*` | no | Override the values in `lib/team.ts` without a code change. |

Supabase schema: [`docs/supabase.sql`](docs/supabase.sql).

## Scope

Deliberately **out of scope**: citation verification and plagiarism checking. ConfFit reads
source text, not a compiled PDF, so page counts are estimates from word count and the format
report says so on every run.

## Layout

```
app/
  page.tsx                 GUI — prompt, Run Agent, response, full steps trace
  api/{team_info,agent_info,model_architecture,execute}/route.ts
lib/
  modules.ts               the six module names — single source of truth
  agents/                  supervisor · profiler · framing · format · fixer
  manuscript.ts            deterministic parsing and per-agent context slices
  checks.ts                deterministic rule checks
  mechanical.ts            mechanical fixes and edit splicing
  llm.ts                   LLMod.ai client (dialect fallback, retries, usage)
  trace.ts                 the steps[] recorder
  store/                   Supabase + Pinecone with in-memory fallbacks
  tools/                   MCP-style web_search · web_fetch · vector_search · rules_lookup
  seed/venues.ts           pre-seeded venue baselines and CFP corpus
scripts/
  render_architecture.py   diagram → PNG → base64 module
  capture-examples.mjs     records agent_info examples from real runs
  smoke-test.mjs           endpoint contract test
  setup-pinecone.mjs       creates the vector index
```
