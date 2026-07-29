#!/usr/bin/env node
/**
 * Contract test for the four required endpoints. Runs against a live server —
 * local or the deployed Vercel URL — and asserts the exact response shapes the
 * project specification requires.
 *
 *   node scripts/smoke-test.mjs                      # http://localhost:3000
 *   node scripts/smoke-test.mjs https://conffit.vercel.app
 *
 * Add --live to also exercise a full /api/execute run (spends tokens unless the
 * server is running with MOCK_LLM=1).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const base = (process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:3000').replace(/\/+$/, '')
const live = process.argv.includes('--live')

const MODULES = ['Supervisor', 'ConferenceProfiler', 'FramingAgent', 'FramingReflect', 'FormatComplianceAgent', 'UnifiedFixer']

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function checkSteps(steps, label) {
  check(`${label}: steps is an array`, Array.isArray(steps))
  if (!Array.isArray(steps)) return
  steps.forEach((s, i) => {
    const tag = `${label}: step[${i}]`
    check(`${tag} module is a known module name`, MODULES.includes(s.module), String(s.module))
    check(`${tag} prompt.system_prompt is a string`, typeof s.prompt?.system_prompt === 'string')
    check(`${tag} prompt.user_prompt is a string`, typeof s.prompt?.user_prompt === 'string')
    check(`${tag} prompt.System_prompt mirrors it`, s.prompt?.System_prompt === s.prompt?.system_prompt)
    check(`${tag} prompt.User_prompt mirrors it`, s.prompt?.User_prompt === s.prompt?.user_prompt)
    check(`${tag} response is an object`, isObj(s.response))
  })
}

async function main() {
  console.log(`ConfFit contract test against ${base}\n`)

  // ── GET /api/team_info ─────────────────────────────────────────────────────
  console.log('GET /api/team_info')
  {
    const res = await fetch(`${base}/api/team_info`)
    check('HTTP 200', res.status === 200, `got ${res.status}`)
    const body = await res.json()
    check('group_batch_order_number is a non-placeholder string',
      typeof body.group_batch_order_number === 'string' && !/TODO/i.test(body.group_batch_order_number),
      body.group_batch_order_number)
    check('team_name is a string', typeof body.team_name === 'string')
    check('students is a non-empty array', Array.isArray(body.students) && body.students.length > 0)
    check('every student has a name and a real email',
      (body.students ?? []).every((s) => typeof s.name === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email ?? '') && !/TODO/i.test(s.email)),
      JSON.stringify(body.students))
  }

  // ── GET /api/agent_info ────────────────────────────────────────────────────
  console.log('\nGET /api/agent_info')
  {
    const res = await fetch(`${base}/api/agent_info`)
    check('HTTP 200', res.status === 200, `got ${res.status}`)
    const body = await res.json()
    check('description is a substantial string', typeof body.description === 'string' && body.description.length > 200)
    check('purpose is a string', typeof body.purpose === 'string' && body.purpose.length > 20)
    check('prompt_template.template is a string', typeof body.prompt_template?.template === 'string')
    check('prompt_examples is a non-empty array', Array.isArray(body.prompt_examples) && body.prompt_examples.length > 0)
    for (const [i, ex] of (body.prompt_examples ?? []).entries()) {
      check(`prompt_examples[${i}].prompt is a string`, typeof ex.prompt === 'string')
      check(`prompt_examples[${i}].full_response is a string`, typeof ex.full_response === 'string' && ex.full_response.length > 0)
      checkSteps(ex.steps, `prompt_examples[${i}]`)
    }
    check('no mock output leaked into the examples',
      !/\(mock\)/.test(JSON.stringify(body.prompt_examples ?? [])))
  }

  // ── GET /api/model_architecture ────────────────────────────────────────────
  console.log('\nGET /api/model_architecture')
  {
    const res = await fetch(`${base}/api/model_architecture`)
    check('HTTP 200', res.status === 200, `got ${res.status}`)
    check('Content-Type is image/png', (res.headers.get('content-type') ?? '').startsWith('image/png'),
      res.headers.get('content-type') ?? '')
    const buf = Buffer.from(await res.arrayBuffer())
    check('body starts with the PNG magic bytes', buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    check('body is a plausible diagram size', buf.byteLength > 20_000, `${buf.byteLength} bytes`)
  }

  // ── GET / (the GUI) ────────────────────────────────────────────────────────
  console.log('\nGET / (GUI)')
  {
    const res = await fetch(`${base}/`)
    check('HTTP 200 with no auth redirect', res.status === 200, `got ${res.status}`)
    const html = await res.text()
    check('page mentions Run Agent', /Run Agent/.test(html))
    check('page contains a textarea', /<textarea/.test(html))
    check('page offers manuscript file attachment', /Attach manuscript/.test(html))
    check('file input accepts text formats', /accept="[^"]*\.tex/.test(html))
  }

  // ── POST /api/execute — validation ─────────────────────────────────────────
  console.log('\nPOST /api/execute (validation)')
  {
    const res = await fetch(`${base}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json()
    check('missing prompt yields status "error"', body.status === 'error')
    check('error is a human-readable string', typeof body.error === 'string' && body.error.length > 10)
    check('response is null', body.response === null)
    check('steps is an array', Array.isArray(body.steps))
  }

  // ── POST /api/execute — full run ───────────────────────────────────────────
  if (live) {
    console.log('\nPOST /api/execute (full run — cached venue, both workers)')
    const paper = readFileSync(join(HERE, 'fixtures', 'sample-paper.txt'), 'utf8').trim()
    const started = Date.now()
    const res = await fetch(`${base}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Target conference: ICLR 2027\nTask: both\nPaper: ${paper}`,
        session_id: `smoke-${Date.now()}`,
      }),
    })
    const body = await res.json()
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  (took ${secs}s)`)
    check('top-level keys are exactly status/error/response/steps',
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['error', 'response', 'status', 'steps']),
      Object.keys(body).join(','))
    check('status is "ok"', body.status === 'ok', body.error ?? '')
    check('error is null', body.error === null)
    check('response is a non-trivial string', typeof body.response === 'string' && body.response.length > 400)
    check('response contains a framing report', /Framing report/i.test(body.response ?? ''))
    check('response contains a format report', /Format report/i.test(body.response ?? ''))
    check('response contains the revised manuscript', /Revised manuscript/i.test(body.response ?? ''))
    checkSteps(body.steps, 'execute')
    check('every architecture module appears in the trace',
      MODULES.every((m) => (body.steps ?? []).some((s) => s.module === m)),
      (body.steps ?? []).map((s) => s.module).join(' → '))
    check('run finished well inside the 300s Vercel ceiling', Number(secs) < 240, `${secs}s`)

    console.log('\nPOST /api/execute (unknown venue — human-in-the-loop gate)')
    const session = `smoke-hitl-${Date.now()}`
    const gate = await (
      await fetch(`${base}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `Target conference: A Venue That Does Not Exist 2099\nTask: format\nPaper: ${paper.slice(0, 800)}`, session_id: session }),
      })
    ).json()
    check('gate returns status "ok"', gate.status === 'ok', gate.error ?? '')
    check('gate asks the user before ingesting', /knowledge base/i.test(gate.response ?? ''))
    check('gate reports that nothing was written',
      (gate.steps ?? []).some((s) => s.module === 'ConferenceProfiler' && s.response?.wrote_to_knowledge_base === false))
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('\nFailures:')
    for (const f of failures) console.log(`  • ${f}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(`\nTest run could not complete: ${e.message}`)
  process.exit(1)
})
