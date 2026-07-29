import { NextResponse } from 'next/server'
import { execute, type AttachedGuidelines } from '@/lib/agents/supervisor'
import {
  GUIDELINE_EXTENSIONS,
  MAX_GUIDELINE_FILES,
  MAX_GUIDELINE_FILE_BYTES,
  MAX_GUIDELINE_TOTAL_BYTES,
  isGuidelineFilename,
} from '@/lib/compose'
import { combineFiles, extractFile } from '@/lib/guidelines'
import type { ExecuteResult } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/**
 * Vercel caps a serverless function at 300 s. A full both-workers run is
 * roughly 6–9 small model calls and finishes far inside that; the ceiling is
 * here so a slow upstream fails cleanly rather than being cut off mid-write.
 */
export const maxDuration = 300

function fail(error: string, status: number) {
  const body: ExecuteResult = { status: 'error', error, response: null, steps: [] }
  return NextResponse.json(body, { status })
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('Request body must be JSON of the form {"prompt": "..."}.', 400)
  }

  const payload = body as { prompt?: unknown; session_id?: unknown; files?: unknown }
  const hasFiles = Array.isArray(payload?.files) && payload.files.length > 0
  if (typeof payload?.prompt !== 'string' && !hasFiles) {
    return fail('Request body must be JSON of the form {"prompt": "..."}.', 400)
  }

  // session_id is optional. The GUI sends one so follow-up prompts ("yes") can
  // resume a pending ingestion; a bare {"prompt": "..."} still works, falling
  // back to a shared session that resolves pending approvals by venue.
  const sessionId =
    typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim().slice(0, 100)
      : 'anonymous'

  /*
   * Optional guidelines attachments, answering the profiler's source gate.
   * Text is extracted here rather than in the browser so that a PDF *link* and
   * an uploaded PDF travel through exactly the same parser, and so the client
   * never has to ship a PDF engine.
   */
  let attached: AttachedGuidelines | undefined
  if (hasFiles) {
    const parsed = await readAttachments(payload.files as unknown[])
    if ('error' in parsed) return fail(parsed.error, 400)
    attached = parsed.attached
  }

  const result = await execute(typeof payload.prompt === 'string' ? payload.prompt : '', sessionId, attached)
  return NextResponse.json(result, { status: 200 })
}

async function readAttachments(
  raw: unknown[],
): Promise<{ attached: AttachedGuidelines } | { error: string }> {
  if (raw.length > MAX_GUIDELINE_FILES) {
    return { error: `At most ${MAX_GUIDELINE_FILES} guideline files per request; ${raw.length} were sent.` }
  }

  const decoded: { name: string; bytes: Uint8Array }[] = []
  let total = 0
  for (const entry of raw) {
    const file = entry as { name?: unknown; data?: unknown }
    if (typeof file?.name !== 'string' || typeof file?.data !== 'string') {
      return { error: 'Each entry of "files" must be {"name": "...", "data": "<base64>"}.' }
    }
    if (!isGuidelineFilename(file.name)) {
      return { error: `${file.name} is not a supported guidelines file (${GUIDELINE_EXTENSIONS.join(', ')}).` }
    }
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(Buffer.from(file.data, 'base64'))
    } catch {
      return { error: `${file.name} is not valid base64.` }
    }
    total += bytes.byteLength
    if (bytes.byteLength > MAX_GUIDELINE_FILE_BYTES || total > MAX_GUIDELINE_TOTAL_BYTES) {
      return {
        error: `Guideline attachments are limited to ${Math.round(MAX_GUIDELINE_FILE_BYTES / 1_000_000)} MB each and ${Math.round(
          MAX_GUIDELINE_TOTAL_BYTES / 1_000_000,
        )} MB in total. Send the author-instructions document on its own.`,
      }
    }
    decoded.push({ name: file.name, bytes })
  }

  const extracted = await Promise.all(decoded.map((f) => extractFile(f.name, f.bytes)))
  return { attached: combineFiles(extracted) }
}

/** Convenience for browsers hitting the endpoint directly. */
export async function GET() {
  return NextResponse.json(
    {
      status: 'error',
      error:
        'Use POST with a JSON body: {"prompt": "..."}, optionally with "session_id" and "files": [{"name":"cfp.pdf","data":"<base64>"}]. The web UI at / does this for you.',
      response: null,
      steps: [],
    },
    { status: 405 },
  )
}
