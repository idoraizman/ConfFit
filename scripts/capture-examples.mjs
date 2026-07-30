#!/usr/bin/env node
/**
 * Captures prompt_examples for GET /api/agent_info from real runs against a
 * running ConfFit server, and writes lib/agent-examples.json.
 *
 *   npm run dev                    # in another shell
 *   node scripts/capture-examples.mjs [--base http://localhost:3000] [--allow-mock]
 *
 * The examples are committed so that a reviewer hitting /api/agent_info reads a
 * recorded trace instead of triggering a live run against the project budget.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const OUT = join(ROOT, 'lib', 'agent-examples.json')

const args = process.argv.slice(2)
const base = (args[args.indexOf('--base') + 1] || 'http://localhost:3000').replace(/\/+$/, '')
const allowMock = args.includes('--allow-mock')

const paper = readFileSync(join(HERE, 'fixtures', 'sample-paper.txt'), 'utf8').trim()

const PROVIDED_VENUE = 'Colloquium on Provided Guidelines 2099'
const PROVIDED_GUIDELINES = `Colloquium on Provided Guidelines 2099 — Author Instructions

Scope. CPG 2099 publishes work on retrieval-grounded agents, tool-using language models and
their evaluation. We value reproducible systems contributions and honest negative results.

Submission format. The main body is limited to 8 pages; references and appendices do not count
towards the limit. Submissions must use the official cpg2099.sty style file with
\\bibliographystyle{cpg-abbrv}. Do not modify margins, font size or the text area. The style
options "final" and "camera" reveal author identity and must not be used at submission time.

Review model. Review is double-blind. Anonymise the author block and avoid first-person
references to your own prior work.

Abstract. A single paragraph of at most 250 words.

Citations. Numeric citations in square brackets.

Required statements. A Limitations section and a Reproducibility statement are mandatory;
submissions without them are desk rejected. An ethics statement is encouraged but optional.`

const SCENARIOS = [
  {
    label: 'both — cached venue',
    session: 'capture-both',
    prompt: `Target conference: ICLR 2026\nTask: both\nPaper: ${paper}\nNotes: we were rejected from NeurIPS for being too systems-focused`,
  },
  {
    label: 'format only — routing skips FramingAgent',
    session: 'capture-format',
    prompt: `Target conference: CVPR 2026\nTask: format\nPaper: ${paper}`,
  },
  {
    label: 'unknown venue — human-in-the-loop gate',
    session: 'capture-hitl',
    prompt: `Target conference: SIGBOVIK 2027\nTask: both\nPaper: ${paper.slice(0, 1200)}`,
  },
  {
    label: 'gate 1 answered with pasted guidelines — nothing fetched, save offered',
    session: 'capture-provided',
    /*
     * The venue is fictional on purpose. This example has to write a profile to
     * the knowledge base, and writing invented rules under a real venue's name
     * would leave every later run for that venue reading them as fact.
     */
    setup: `Target conference: ${PROVIDED_VENUE}\nTask: both\nPaper: ${paper.slice(0, 1200)}`,
    prompt: PROVIDED_GUIDELINES,
    expect: /Add .* to the knowledge base\?/,
  },
  {
    label: 'gate 2 answered — the profile is stored, at no token cost',
    session: 'capture-provided',
    prompt: 'yes',
    expect: /Saved —/,
  },
]

async function post(prompt, session) {
  const res = await fetch(`${base}/api/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, session_id: session }),
  })
  if (!res.ok) throw new Error(`${base}/api/execute returned HTTP ${res.status}`)
  return res.json()
}

const examples = []
for (const s of SCENARIOS) {
  process.stdout.write(`• ${s.label} … `)
  // A scenario that answers the gate needs the gate to be open first. The setup
  // turn is run but not captured — the example is the reply and its trace.
  if (s.setup) {
    const opened = await post(s.setup, s.session)
    if (opened.status !== 'ok') throw new Error(`scenario "${s.label}" setup failed: ${opened.error}`)
  }
  const result = await post(s.prompt, s.session)
  if (result.status !== 'ok') throw new Error(`scenario "${s.label}" failed: ${result.error}`)
  if (s.expect && !s.expect.test(result.response ?? '')) {
    throw new Error(
      `scenario "${s.label}" did not take the expected path (looking for ${s.expect}).\n` +
        `If this venue is already cached, delete its row from conference_profiles and re-run:\n` +
        `  delete from public.conference_profiles where venue like '%Provided Guidelines%';`,
    )
  }
  console.log(`${result.steps.length} step(s)`)
  examples.push({
    scenario: s.label,
    prompt: s.prompt,
    full_response: result.response,
    steps: result.steps,
  })
}

const serialised = JSON.stringify({ examples }, null, 2)
if (!allowMock && /\(mock\)|"MOCK"/.test(serialised)) {
  console.error(
    '\nRefusing to write: the captured output contains mock content.\n' +
      'Set a real LLMOD_API_KEY (and MOCK_LLM=0) and re-run, or pass --allow-mock to override.',
  )
  process.exit(1)
}

writeFileSync(OUT, serialised + '\n')
console.log(`\nWrote ${OUT} (${examples.length} examples, ${(serialised.length / 1024).toFixed(0)} KB)`)
