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

const SCENARIOS = [
  {
    label: 'both — cached venue',
    session: 'capture-both',
    prompt: `Target conference: ICLR 2027\nTask: both\nPaper: ${paper}\nNotes: we were rejected from NeurIPS for being too systems-focused`,
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
  const result = await post(s.prompt, s.session)
  if (result.status !== 'ok') throw new Error(`scenario "${s.label}" failed: ${result.error}`)
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
