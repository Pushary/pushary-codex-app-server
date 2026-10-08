import type { CodexReply, CodexRequestId } from './types'

export type RequestState = 'pending' | 'accepted' | 'closed'
export type RequestCompletion =
  | { readonly kind: 'reply'; readonly reply: CodexReply }
  | { readonly kind: 'refuse' | 'conflict' | 'abandon'; readonly reason: string }
  | { readonly kind: 'native' }

interface RequestContext {
  readonly id: CodexRequestId
  readonly isQuestion: boolean
  readonly replyAllowed: boolean
  readonly deadlineElapsed: boolean
}
interface RequestTransition {
  readonly state: Exclude<RequestState, 'pending'>
  readonly reply: CodexReply | null
  readonly interruption: string | null
  readonly abandonment: string | null
}

export const transitionRequest = (state: RequestState, completion: RequestCompletion, context: RequestContext): RequestTransition | null => {
  if (state !== 'pending') return null
  if (completion.kind === 'reply') {
    if (!context.replyAllowed || context.deadlineElapsed) return null
    const reply = completion.reply
    const accepted = 'result' in reply && 'decision' in reply.result && reply.result.decision === 'accept'
    return { state: accepted ? 'accepted' : 'closed', reply, interruption: null, abandonment: null }
  }
  if (completion.kind === 'native') return { state: 'closed', reply: null, interruption: null, abandonment: null }
  if (completion.kind === 'abandon' || !context.replyAllowed) return { state: 'closed', reply: null, interruption: null, abandonment: completion.reason }
  const reply: CodexReply = context.isQuestion
    ? { id: context.id, error: { code: -32000, message: completion.reason } }
    : { id: context.id, result: { decision: 'cancel' } }
  return { state: 'closed', reply, interruption: context.isQuestion || completion.kind === 'conflict' ? completion.reason : null, abandonment: completion.reason }
}
