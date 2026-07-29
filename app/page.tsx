'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_BYTES,
  describeFile,
  isAcceptedFilename,
  looksBinary,
  withPaper,
} from '@/lib/compose'
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
  const [reply, setReply] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const sessionId = useSessionId()
  const bottom = useRef<HTMLDivElement>(null)
  const replyBox = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const last = turns[turns.length - 1]
  /** The human-in-the-loop gate, read out of the trace the run already returns. */
  const gate = gateOf(last?.result ?? null)

  /** Reads a dropped or chosen manuscript into the Paper: field. */
  const loadFile = useCallback(async (file: File) => {
    setFileError(null)
    setLoaded(null)

    if (!isAcceptedFilename(file.name)) {
      setFileError(
        `${file.name} is not a text file. ConfFit reads ${ACCEPTED_EXTENSIONS.join(', ')}. ` +
          'For a PDF, open it and copy the text in — extraction from PDF mangles two-column layouts.',
      )
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError(`${file.name} is ${Math.round(file.size / 1_000_000)} MB; the limit is 2 MB.`)
      return
    }

    let text: string
    try {
      text = await file.text()
    } catch (e) {
      setFileError(`Could not read ${file.name}: ${(e as Error).message}`)
      return
    }
    if (!text.trim()) {
      setFileError(`${file.name} is empty.`)
      return
    }
    if (looksBinary(text)) {
      setFileError(`${file.name} does not look like plain text. Paste the manuscript text instead.`)
      return
    }

    setPrompt((current) => withPaper(current, text))
    setLoaded(describeFile(file.name, text))
  }, [])

  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns])

  // When the agent asks something, put the cursor where the answer goes: the
  // gate is only a conversation if the next turn is obviously available.
  useEffect(() => {
    if (gate && !busy) replyBox.current?.focus()
  }, [gate, busy])

  /** Posts one prompt as the next turn of this session. */
  const send = useCallback(
    async (text: string) => {
      const body = text.trim()
      if (!body) return
      const id = Date.now()
      setTurns((t) => [...t, { id, prompt: body, result: null }])
      setBusy(true)
      try {
        const res = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: body, session_id: sessionId }),
        })
        const parsed = (await res.json()) as ExecuteResult
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, result: parsed } : x)))
      } catch (e) {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, transportError: (e as Error).message } : x)))
      } finally {
        setBusy(false)
      }
    },
    [sessionId],
  )

  async function run() {
    const text = prompt.trim()
    if (!text || busy) return
    setPrompt('')
    await send(text)
  }

  /**
   * Sends a follow-up. The reply goes over the wire exactly as typed: the
   * Supervisor recognises a bare `yes` and a bare URL in code, and either would
   * stop being recognised if the UI wrapped it in anything.
   */
  async function sendReply(text: string) {
    if (busy || !text.trim()) return
    setReply('')
    await send(text)
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

      <div
        className={dragging ? 'panel dragging' : 'panel'}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          // Only clear when the pointer actually leaves the panel, not when it
          // crosses into a child element.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files?.length) return
          e.preventDefault()
          setDragging(false)
          void loadFile(e.dataTransfer.files[0])
        }}
      >
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

        {dragging && <div className="dropveil">Drop the manuscript to fill the Paper field</div>}
        <div className="row">
          <button onClick={() => void run()} disabled={busy || !prompt.trim()}>
            {busy && <span className="spinner" />}
            {busy ? 'Running…' : 'Run Agent'}
          </button>
          <button className="ghost" onClick={() => fileInput.current?.click()} disabled={busy}>
            Attach manuscript…
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(',')}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void loadFile(file)
              // Reset so choosing the same file twice fires onChange again.
              e.target.value = ''
            }}
          />
          <button className="ghost" onClick={() => setPrompt(TEMPLATE)} disabled={busy}>
            Insert template
          </button>
          {turns.length > 0 && (
            <button className="ghost" onClick={() => setTurns([])} disabled={busy}>
              Clear history
            </button>
          )}
        </div>

        {loaded && <p className="filenote ok">Loaded {loaded}</p>}
        {fileError && <p className="filenote bad">{fileError}</p>}

        <p className="hint">
          Drop a {ACCEPTED_EXTENSIONS.slice(0, 3).join(' / ')} file anywhere on this panel to fill the{' '}
          <code>Paper:</code> field, or paste the text in directly. ⌘/Ctrl + Enter runs. Answers appear below, each with
          a reply box — an unknown venue is added only after you approve it there.
        </p>
      </div>

      {turns.map((turn) => (
        <TurnView key={turn.id} turn={turn} />
      ))}

      {turns.length > 0 && (
        <div className={gate ? 'panel reply gated' : 'panel reply'}>
          <label htmlFor="reply" className="hint">
            {gate ? 'Your answer' : 'Reply — same session, no need to resend the paper'}
          </label>

          {gate?.proposedUrl && (
            <p className="gatenote">
              Waiting on you: may ConfFit read <code>{gate.proposedUrl}</code> and add {gate.venue ?? 'that venue'} to
              the knowledge base?
            </p>
          )}

          <textarea
            id="reply"
            ref={replyBox}
            className="short"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={
              gate
                ? 'yes  ·  or a link to the call-for-papers  ·  or paste the venue guidelines here'
                : 'A follow-up question, an approval, a link, or pasted venue guidelines'
            }
            spellCheck={false}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void sendReply(reply)
              }
            }}
          />

          <div className="row">
            <button onClick={() => void sendReply(reply)} disabled={busy || !reply.trim()}>
              {busy && <span className="spinner" />}
              {busy ? 'Running…' : 'Send reply'}
            </button>
            {gate?.proposedUrl && (
              <button className="ghost approve" onClick={() => void sendReply('yes')} disabled={busy}>
                Yes — fetch it and continue
              </button>
            )}
          </div>

          <p className="hint">
            {gate
              ? 'Pasting the guidelines text is the sure route — the profile is built from exactly what you paste and nothing is fetched. ⌘/Ctrl + Enter sends.'
              : 'The paper stays attached to this session, so a follow-up only needs the new information. ⌘/Ctrl + Enter sends.'}
          </p>
        </div>
      )}
      <div ref={bottom} />

      <footer className="foot">
        ConfFit · Itay Krausz, Ido Raizman, Roi Teichman · Supervisor + Reflection + ReAct · gpt-5.4-mini ·
        Supabase + Pinecone
      </footer>
    </div>
  )
}

/**
 * Reads the human-in-the-loop gate out of a finished turn.
 *
 * The gate is already fully described in the `steps` trace the API returns —
 * `ask_user` with the question and `proposed_url` with the candidate — so the UI
 * can offer a one-click approval without adding a field to the response contract.
 */
function gateOf(result: ExecuteResult | null): { proposedUrl: string | null; venue: string | null } | null {
  if (!result || result.status !== 'ok') return null
  for (let i = result.steps.length - 1; i >= 0; i--) {
    const r = result.steps[i].response as { ask_user?: unknown; proposed_url?: unknown; venue?: unknown }
    if (typeof r.ask_user !== 'string') continue
    return {
      proposedUrl: typeof r.proposed_url === 'string' && r.proposed_url ? r.proposed_url : null,
      venue: typeof r.venue === 'string' ? r.venue : null,
    }
  }
  return null
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

  /**
   * Copy buttons are delegated rather than bound per block: the markdown is
   * injected as HTML, so there is no React element to attach a handler to.
   */
  const onClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]')
    if (!btn) return
    const code = btn.parentElement?.querySelector('code')?.textContent
    if (!code) return

    const restore = (label: string) => {
      btn.textContent = label
      setTimeout(() => {
        btn.textContent = 'Copy'
        btn.classList.remove('done', 'failed')
      }, 1800)
    }
    try {
      await navigator.clipboard.writeText(code)
      btn.classList.add('done')
      restore('Copied')
    } catch {
      // Clipboard access is refused outside a secure context; select the text
      // so ⌘C still works rather than leaving the user with a dead button.
      const range = document.createRange()
      const pre = btn.parentElement?.querySelector('pre')
      if (pre) {
        range.selectNodeContents(pre)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      btn.classList.add('failed')
      restore('Press ⌘C')
    }
  }

  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
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
