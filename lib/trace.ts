import { chat, parseJsonObject, UsageMeter, type ChatRequest } from './llm'
import type { ModuleName } from './modules'
import type { Step } from './types'

/**
 * Collects the `steps` array required by /api/execute.
 *
 * Rule we hold ourselves to: a step is emitted for every LLM call, and for the
 * ConferenceProfiler's retrieval pass (which the architecture document shows as
 * a traced step even when it costs nothing). Steps that did not involve the
 * model carry `llm_call: false` in their response so the trace never overstates
 * what the agent spent.
 */
export class Tracer {
  readonly steps: Step[] = []
  readonly usage = new UsageMeter()

  /** Records a step for work that ran in code rather than in the model. */
  addDeterministic(
    module: ModuleName,
    prompt: { system: string; user: string },
    response: Record<string, unknown>,
  ): void {
    this.push(module, prompt, { llm_call: false, ...response })
  }

  /** Runs one LLM call and records it. */
  async call(
    module: ModuleName,
    req: ChatRequest,
    /** Shown in the trace instead of the raw string when the reply is JSON. */
    asJson = true,
  ): Promise<string> {
    const { text, usage } = await chat(req)
    this.usage.record(usage)

    let response: Record<string, unknown>
    if (asJson) {
      try {
        response = parseJsonObject<Record<string, unknown>>(text)
      } catch {
        response = { text }
      }
    } else {
      response = { text }
    }
    this.push(module, { system: req.system, user: req.user }, response)
    return text
  }

  /** Runs one LLM call, records it, and returns the parsed object. */
  async callJson<T>(module: ModuleName, req: ChatRequest): Promise<T> {
    const text = await this.call(module, { ...req, json: true }, true)
    return parseJsonObject<T>(text)
  }

  private push(
    module: ModuleName,
    prompt: { system: string; user: string },
    response: Record<string, unknown>,
  ): void {
    this.steps.push({
      module,
      prompt: {
        system_prompt: prompt.system,
        user_prompt: prompt.user,
        // The spec's schema block capitalises these keys while its worked
        // example does not; emitting both satisfies either reading.
        System_prompt: prompt.system,
        User_prompt: prompt.user,
      },
      response,
    })
  }
}
