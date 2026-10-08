export type CodexRequestId = string | number
export type CodexReply =
  | { readonly id: CodexRequestId; readonly result: { readonly decision: 'accept' | 'decline' | 'cancel' } }
  | { readonly id: CodexRequestId; readonly result: { readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>> } }
  | { readonly id: CodexRequestId; readonly error: { readonly code: number; readonly message: string } }
export type CodexDispatchResult =
  | { readonly kind: 'claimed' | 'observed' }
  | { readonly kind: 'unhandled' | 'invalid'; readonly reason: string }
export interface FileChange {
  readonly path: string
  readonly operation: 'add' | 'delete' | 'update'
  readonly movePath: string | null
  readonly diff: string
}
export interface CodexQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options: readonly { readonly label: string; readonly description: string }[] | null
}
export type CodexReviewSubject =
  | { readonly kind: 'command'; readonly command: string; readonly cwd: string; readonly reason: string | null }
  | { readonly kind: 'files'; readonly changes: readonly FileChange[]; readonly reason: string | null }
  | { readonly kind: 'questions'; readonly questions: readonly CodexQuestion[] }
export interface PusharyCodexEvent {
  readonly type: 'decision_created' | 'decision_settled' | 'request_abandoned' | 'native_review_required' | 'cleanup_failed' | 'create_outcome_unknown' | 'reply_failed' | 'capacity_exceeded'
  readonly requestId?: CodexRequestId
  readonly threadId?: string
  readonly turnId?: string
  readonly decisionId?: string
  readonly subjectDigest?: string
  readonly reason?: string
}
export interface PusharyCodexConfig {
  readonly apiKey: string
  readonly externalId: string
  readonly tenantId: string
  readonly agentName?: string
  readonly baseUrl?: string
  readonly codexVersion: '0.160.1'
  readonly experimentalQuestions?: boolean
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly sendResponse: (reply: CodexReply) => void
  readonly requestTurnInterrupt: (threadId: string, turnId: string, reason: string) => void
  readonly onEvent: (event: PusharyCodexEvent) => void
  readonly maySendSubject: (subject: CodexReviewSubject) => boolean
}
export interface PusharyCodexHandler {
  readonly registerThread: (startOrResumeResult: unknown) => void
  readonly unregisterThread: (threadId: string) => void
  readonly handle: (message: unknown) => CodexDispatchResult
  readonly invalidateTurn: (threadId: string, turnId: string, reason: string) => void
  readonly dispose: () => Promise<{ readonly cleanupFailures: readonly string[] }>
}
export interface RequestIdentity {
  readonly id: CodexRequestId
  readonly method: string
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly approvalId: string | null
}
