'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACCEPTED_EXTENSIONS,
  GUIDELINE_EXTENSIONS,
  MAX_FILE_BYTES,
  MAX_GUIDELINE_FILES,
  MAX_GUIDELINE_FILE_BYTES,
  MAX_GUIDELINE_TOTAL_BYTES,
  isGuidelineFilename,
  describeFile,
  isAcceptedFilename,
  looksBinary,
  withPaper,
} from '@/lib/compose'
import { renderMarkdown } from '@/lib/markdown'
import type { ExecuteResult, Step } from '@/lib/types'

const TEMPLATE = `Target conference: ICLR 2026
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
  const [link, setLink] = useState('')
  const [guidelineFiles, setGuidelineFiles] = useState<File[]>([])
  const guidelineInput = useRef<HTMLInputElement>(null)

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
    async (text: string, files?: { name: string; data: string }[]) => {
      const body = text.trim()
      if (!body && !files?.length) return
      const id = Date.now()
      setTurns((t) => [...t, { id, prompt: body, result: null }])
      setBusy(true)
      try {
        const res = await fetch('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: body, session_id: sessionId, ...(files?.length ? { files } : {}) }),
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

  /** A bare URL, which the Supervisor recognises in code as the venue's source. */
  async function sendLink() {
    const url = link.trim()
    if (busy || !url) return
    setLink('')
    await send(url)
  }

  /**
   * Validates the chosen guideline files before they are sent.
   *
   * The total matters as much as each file: the request carries them base64
   * encoded, which is a third larger, and going over the platform's body limit
   * would fail as an opaque 413 rather than as a message about attachments.
   */
  function pickGuidelines(list: FileList | null) {
    setFileError(null)
    if (!list?.length) return
    const chosen = Array.from(list)
    const rejected = chosen.filter((f) => !isGuidelineFilename(f.name))
    if (rejected.length) {
      setFileError(
        `${rejected.map((f) => f.name).join(', ')}: ConfFit reads ${GUIDELINE_EXTENSIONS.join(', ')}. Export a Word document as PDF.`,
      )
      return
    }
    const merged = [...guidelineFiles]
    for (const f of chosen) if (!merged.some((m) => m.name === f.name && m.size === f.size)) merged.push(f)
    if (merged.length > MAX_GUIDELINE_FILES) {
      setFileError(`At most ${MAX_GUIDELINE_FILES} files.`)
      return
    }
    const oversized = merged.find((f) => f.size > MAX_GUIDELINE_FILE_BYTES)
    if (oversized) {
      setFileError(`${oversized.name} is ${Math.round(oversized.size / 1_000_000)} MB; the limit is ${Math.round(MAX_GUIDELINE_FILE_BYTES / 1_000_000)} MB per file.`)
      return
    }
    const total = merged.reduce((sum, f) => sum + f.size, 0)
    if (total > MAX_GUIDELINE_TOTAL_BYTES) {
      setFileError(
        `Those files total ${Math.round(total / 1_000_000)} MB; the limit is ${Math.round(MAX_GUIDELINE_TOTAL_BYTES / 1_000_000)} MB. Send the author-instructions document on its own.`,
      )
      return
    }
    setGuidelineFiles(merged)
  }

  async function sendGuidelineFiles() {
    if (busy || !guidelineFiles.length) return
    const files = guidelineFiles
    setGuidelineFiles([])
    setFileError(null)
    try {
      const encoded = await Promise.all(files.map(async (f) => ({ name: f.name, data: await toBase64(f) })))
      await send(`Guidelines attached: ${files.map((f) => f.name).join(', ')}`, encoded)
    } catch (e) {
      setFileError(`Could not read the attachments: ${(e as Error).message}`)
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
        <div className={gate ? `panel reply gated ${gate.kind}` : 'panel reply'}>
          {gate?.kind === 'source' ? (
            <>
              <h2 className="gatetitle">Guidelines needed for {gate.venue ?? 'this venue'}</h2>

              <div className="gategrid">
                <div className="gatefield">
                  <label htmlFor="gate-url">A link to the call-for-papers or author instructions</label>
                  <div className="inline">
                    <input
                      id="gate-url"
                      type="url"
                      value={link}
                      placeholder="https://venue.org/submissions/author-guidelines"
                      onChange={(e) => setLink(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && link.trim()) {
                          e.preventDefault()
                          void sendLink()
                        }
                      }}
                    />
                    <button className="ghost" onClick={() => void sendLink()} disabled={busy || !link.trim()}>
                      Read this link
                    </button>
                  </div>
                  <span className="sub">HTML pages and PDFs both work.</span>
                </div>

                <div className="gatefield">
                  <label htmlFor="gate-files">Or attach the guidelines</label>
                  <div className="inline">
                    <input
                      id="gate-files"
                      ref={guidelineInput}
                      type="file"
                      multiple
                      accept={GUIDELINE_EXTENSIONS.join(',')}
                      onChange={(e) => {
                        pickGuidelines(e.target.files)
                        e.target.value = ''
                      }}
                    />
                    <button
                      onClick={() => void sendGuidelineFiles()}
                      disabled={busy || guidelineFiles.length === 0}
                    >
                      {busy && <span className="spinner" />}
                      {busy
                        ? 'Reading…'
                        : guidelineFiles.length
                          ? `Send ${guidelineFiles.length} file${guidelineFiles.length === 1 ? '' : 's'}`
                          : 'Send files'}
                    </button>
                  </div>
                  <span className="sub">
                    PDF or text, up to {MAX_GUIDELINE_FILES} files and {Math.round(MAX_GUIDELINE_TOTAL_BYTES / 1_000_000)} MB
                    total. Scanned PDFs have no text to read.
                  </span>
                  {guidelineFiles.length > 0 && (
                    <ul className="filelist">
                      {guidelineFiles.map((f) => (
                        <li key={f.name}>
                          {f.name} <span className="sub">{Math.max(1, Math.round(f.size / 1000))} kB</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {fileError && <p className="filenote bad">{fileError}</p>}
                </div>
              </div>

              <label htmlFor="reply" className="hint">
                Or paste the rules as text
              </label>
            </>
          ) : gate?.kind === 'save' ? (
            <>
              <h2 className="gatetitle">Add {gate.venue ?? 'this venue'} to the knowledge base?</h2>
              <p className="gatenote">
                The rules above were used for this run only. Nothing has been written yet.
              </p>
              <div className="row">
                <button onClick={() => void sendReply('yes')} disabled={busy}>
                  {busy && <span className="spinner" />}
                  Yes — remember these rules
                </button>
                <button className="ghost" onClick={() => void sendReply('no')} disabled={busy}>
                  No — this run only
                </button>
              </div>
              <label htmlFor="reply" className="hint">
                Or reply in words
              </label>
            </>
          ) : (
            <label htmlFor="reply" className="hint">
              Reply — same session, no need to resend the paper
            </label>
          )}

          <textarea
            id="reply"
            ref={replyBox}
            className="short"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={
              gate?.kind === 'source'
                ? 'Page limit: 8 pages excluding references. Review is double-blind…'
                : gate?.kind === 'save'
                  ? 'yes  ·  no'
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
                Yes — read {shortUrl(gate.proposedUrl)}
              </button>
            )}
            {gate?.baseline && (
              <button className="ghost approve" onClick={() => void sendReply('baseline')} disabled={busy}>
                Use the built-in {gate.baseline} rules
              </button>
            )}
          </div>

          <p className="hint">
            {gate?.kind === 'source'
              ? 'Whatever you send is used verbatim — ConfFit reads only the source you name. ⌘/Ctrl + Enter sends.'
              : gate?.kind === 'save'
                ? 'Saving means the next paper for this venue skips the profiler entirely. ⌘/Ctrl + Enter sends.'
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

interface Gate {
  /** `source` — ConfFit needs the guidelines. `save` — it asks whether to keep them. */
  kind: 'source' | 'save'
  proposedUrl: string | null
  venue: string | null
  /** A built-in baseline exists, but for a different edition, e.g. "ICML 2026". */
  baseline: string | null
}

/**
 * Reads which gate, if any, the last turn left open.
 *
 * Both gates are already fully described by the `steps` trace the API returns, so
 * the dedicated cell is driven from that rather than from an extra field on the
 * response — the wire contract stays {status, error, response, steps}.
 */
function gateOf(result: ExecuteResult | null): Gate | null {
  if (!result || result.status !== 'ok') return null

  // A save decision was just answered; that gate is closed.
  for (const step of result.steps) {
    const r = step.response as { gate?: unknown; decision?: unknown }
    if (r.gate === 'save' && typeof r.decision === 'string') return null
  }

  for (let i = result.steps.length - 1; i >= 0; i--) {
    const r = result.steps[i].response as {
      ask_user?: unknown
      proposed_url?: unknown
      venue?: unknown
      gate?: unknown
      baseline_available?: unknown
    }
    if (typeof r.ask_user === 'string') {
      return {
        kind: 'source',
        proposedUrl: typeof r.proposed_url === 'string' && r.proposed_url ? r.proposed_url : null,
        venue: typeof r.venue === 'string' ? r.venue : null,
        baseline: typeof r.baseline_available === 'string' ? r.baseline_available : null,
      }
    }
  }

  // The run finished and offered to remember the rules it just used.
  if (/^## Add .+ to the knowledge base\?$/m.test(result.response)) {
    const venue = result.response.match(/^## Add (.+) to the knowledge base\?$/m)?.[1] ?? null
    return { kind: 'save', proposedUrl: null, venue, baseline: null }
  }
  return null
}

/** Shortens a URL for a button label. */
function shortUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.slice(0, 30)
  }
}

/** Base64 for the JSON body; FileReader keeps this off the main thread's stack. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`could not read ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
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
