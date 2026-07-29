import { NextResponse } from 'next/server'
import {
  ARCHITECTURE_SUMMARY,
  DESCRIPTION,
  PROMPT_TEMPLATE,
  PURPOSE,
} from '@/lib/agent-info'
import examples from '@/lib/agent-examples.json'
import type { Step } from '@/lib/types'

export const runtime = 'nodejs'

interface CapturedExample {
  prompt: string
  full_response: string
  steps: Step[]
}

/**
 * The examples are captured from real runs by scripts/capture-examples.mjs and
 * committed, rather than generated per request — a reviewer hitting this
 * endpoint should not spend the project's budget.
 */
export async function GET() {
  return NextResponse.json({
    description: DESCRIPTION,
    purpose: PURPOSE,
    prompt_template: PROMPT_TEMPLATE,
    prompt_examples: (examples as { examples: CapturedExample[] }).examples,
    architecture: ARCHITECTURE_SUMMARY,
  })
}
