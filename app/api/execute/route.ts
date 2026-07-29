import { NextResponse } from 'next/server'
import { execute } from '@/lib/agents/supervisor'
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

  const payload = body as { prompt?: unknown; session_id?: unknown }
  if (typeof payload?.prompt !== 'string') {
    return fail('Request body must be JSON of the form {"prompt": "..."}.', 400)
  }

  // session_id is optional. The GUI sends one so follow-up prompts ("yes") can
  // resume a pending ingestion; a bare {"prompt": "..."} still works, falling
  // back to a shared session that resolves pending approvals by venue.
  const sessionId =
    typeof payload.session_id === 'string' && payload.session_id.trim()
      ? payload.session_id.trim().slice(0, 100)
      : 'anonymous'

  const result = await execute(payload.prompt, sessionId)
  return NextResponse.json(result, { status: 200 })
}

/** Convenience for browsers hitting the endpoint directly. */
export async function GET() {
  return NextResponse.json(
    {
      status: 'error',
      error: 'Use POST with a JSON body: {"prompt": "..."}. The web UI at / does this for you.',
      response: null,
      steps: [],
    },
    { status: 405 },
  )
}
