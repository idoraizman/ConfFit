'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '@/lib/markdown'
import type { ExecuteResult, Step } from '@/lib/types'

const TEMPLATE = `Target conference: ICLR 2027
Task: both
Paper: <paste your manuscript here — title, author block, abstract, sections, references>
Notes: <optional, e.g. "rejected from NeurIPS for being too applied">`

interface Turn {
  id: number
  prompt: string
  result: ExecuteResult | null
  /** Transport-level failure, distinct from a status:"error" body. */
  transportError?: string
}

export default function Page() {
  const [prompt, setPrompt] = useState(TEMPLATE)
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const sessionId = useSessionId()
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  async function run() {
    const text = prompt.trim()
    if (!text || busy) return
    const id = Date.now()
    setTurns((t) => [...t, { id, prompt: text, result: null }])
    setBusy(true)
    setPrompt('')

    try {
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, session_id: sessionId }),
      })
      const body = (await res.json()) as ExecuteResult
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, result: body } : x)))
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, transportError: (e as Error).message } : x)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wrap">
      <header className="top">
        <h1>ConfFit</h1>
        <span className="tag">Conference Submission Agent</span>
      </header>
      <p className="lede">
        Give it a target venue and your manuscript. A Supervisor routes the request, a ReAct profiler grounds it in the
        venue’s Call-for-Papers, a Reflection agent re-frames the contribution, a ReAct agent checks the submission
        rules, and a UnifiedFixer returns one revised manuscript.
      </p>

      <nav className="links">
        <a href="/api/team_info" target="_blank" rel="noreferrer">GET /api/team_info</a>
        <a href="/api/agent_info" target="_blank" rel="noreferrer">GET /api/agent_info</a>
        <a href="/api/model_architecture" target="_blank" rel="noreferrer">GET /api/model_architecture</a>
      </nav>

      <div className="panel">
        <label htmlFor="prompt" className="hint">
          Prompt
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={TEMPLATE}
          spellCheck={false}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void run()
            }
          }}
        />
        <div className="row">
          <button onClick={() => void run()} disabled={busy || !prompt.trim()}>
            {busy && <span className="spinner" />}
            {busy ? 'Running…' : 'Run Agent'}
          </button>
          <button className="ghost" onClick={() => setPrompt(TEMPLATE)} disabled={busy}>
            Insert template
          </button>
          {turns.length > 0 && (
            <button className="ghost" onClick={() => setTurns([])} disabled={busy}>
              Clear history
            </button>
          )}
          <span className="hint">
            ⌘/Ctrl + Enter to run. Follow-up prompts stay in the same session — reply “yes” to approve adding an unknown
            venue.
          </span>
        </div>
      </div>

      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} />
      ))}
      <div ref={bottom} />

      <footer className="foot">
        ConfFit · Itay Krausz, Ido Raizman, Roi Teichman · Supervisor + Reflection + ReAct · gpt-5.4-mini ·
        Supabase + Pinecone
      </footer>
    </div>
  )
}

function TurnView({ turn }: { turn: Turn }) {
  const { result } = turn
  return (
    <>
      <div className="turn">
        <div className="who">You</div>
        <div className="bubble user">{turn.prompt}</div>
      </div>

      <div className="turn">
        <div className="who">ConfFit</div>
        {turn.transportError ? (
          <div className="bubble err">Could not reach the agent: {turn.transportError}</div>
        ) : !result ? (
          <div className="bubble">
            <p className="hint">
              <span className="spinner" />
              Running the agent — routing, profiling the venue, then the workers.
            </p>
          </div>
        ) : result.status === 'error' ? (
          <div className="bubble err">
            <strong>Error:</strong> {result.error}
          </div>
        ) : (
          <div className="bubble">
            <Markdown source={result.response} />
          </div>
        )}
        {result && result.steps.length > 0 && <Trace steps={result.steps} />}
      </div>
    </>
  )
}

function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

function Trace({ steps }: { steps: Step[] }) {
  const llmCalls = steps.filter((s) => (s.response as { llm_call?: boolean }).llm_call !== false).length
  return (
    <details className="trace" open>
      <summary>
        Execution trace — {steps.length} step{steps.length === 1 ? '' : 's'} ({llmCalls} LLM call
        {llmCalls === 1 ? '' : 's'})
      </summary>
      {steps.map((step, i) => {
        const inCode = (step.response as { llm_call?: boolean }).llm_call === false
        return (
          <details className="step" key={i}>
            <summary>
              <span className="idx">{i + 1}</span>
              <span className="mod">{step.module}</span>
              <span className={inCode ? 'badge code' : 'badge'}>{inCode ? 'in code · 0 tokens' : 'LLM call'}</span>
            </summary>
            <div className="body">
              <div className="field">
                <span className="label">system_prompt</span>
                <pre>{step.prompt.system_prompt}</pre>
              </div>
              <div className="field">
                <span className="label">user_prompt</span>
                <pre>{step.prompt.user_prompt}</pre>
              </div>
              <div className="field">
                <span className="label">response</span>
                <pre>{JSON.stringify(step.response, null, 2)}</pre>
              </div>
            </div>
          </details>
        )
      })}
    </details>
  )
}

/** Stable per-tab id so follow-up prompts resume the same pending approval. */
function useSessionId(): string {
  const [id, setId] = useState('anonymous')
  useEffect(() => {
    const KEY = 'conffit.session'
    let existing = sessionStorage.getItem(KEY)
    if (!existing) {
      existing = crypto.randomUUID()
      sessionStorage.setItem(KEY, existing)
    }
    setId(existing)
  }, [])
  return id
}
