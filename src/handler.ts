import { randomUUID } from 'node:crypto'
import { createPusharyServer, isApproved, type CreateDecision } from '@pushary/server'
import { decisionFingerprint } from '@pushary/server/adapters'
import { COMMAND, FILES, QUESTIONS, certifiedThread, fileChangesOf, identityOf, isId, isRecord, isText, subjectOf } from './protocol'
import { presentSubject, type PhoneQuestion } from './presentation'
import { decisionFailureReason, decisionSnapshot, delay, isRetryable, withRetry, type DecisionSnapshot } from './partner-decisions'
import { transitionRequest, type RequestCompletion, type RequestState } from './request-lifecycle'
import type { CodexDispatchResult, CodexReviewSubject, FileChange, PusharyCodexConfig, PusharyCodexEvent, PusharyCodexHandler, RequestIdentity } from './types'

const MAX_PENDING = 8
const MAX_THREADS = 32
const MAX_ITEMS = 128
const MAX_CACHE_BYTES = 4 * 1024 * 1024
const MAX_REQUESTS = 4096
const CLEANUP_MS = 5000
const MIN_QUESTION_BUDGET_MS = 10_000
interface OwnedRequest {
  readonly identity: RequestIdentity
  readonly declineDecision: 'decline' | 'cancel'
  readonly digest: string
  readonly envelopeDigest: string
  readonly subject: CodexReviewSubject
  readonly controller: AbortController
  readonly deadline: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly decisionIds: Set<string>
  readonly cleanupIds: Set<string>
  state: RequestState
  cleanupDeadline: number
}
interface CachedPatch { readonly changes: readonly FileChange[] | null; readonly digest: string; readonly bytes: number }
const itemKey = (threadId: string, turnId: string, itemId: string): string => JSON.stringify([threadId, turnId, itemId])
const turnKey = (threadId: string, turnId: string): string => JSON.stringify([threadId, turnId])
const rpcKey = (id: string | number): string => JSON.stringify([typeof id, id])

export const createPusharyCodexHandler = (configuration: PusharyCodexConfig): PusharyCodexHandler => {
  const config = Object.freeze({ ...configuration })
  const timeoutMs = config.timeoutMs ?? 300_000
  if (config.codexVersion !== '0.160.1' || !Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 600_000 || !config.tenantId?.trim() || !config.externalId?.trim()) throw new TypeError('Invalid Codex adapter configuration')
  if ([config.sendResponse, config.requestTurnInterrupt, config.onEvent, config.maySendSubject].some(callback => typeof callback !== 'function')) throw new TypeError('All host callbacks are required')
  const decisions = createPusharyServer({ apiKey: config.apiKey, baseUrl: config.baseUrl, requestTimeoutMs: 10_000 }).decisions
  const generation = randomUUID()
  const threads = new Set<string>()
  const requests = new Map<string, OwnedRequest>()
  const closedRequestIds = new Set<string>()
  const turns = new Map<string, { readonly threadId: string; readonly turnId: string; terminal: boolean }>()
  const completedItems = new Set<string>()
  const patches = new Map<string, CachedPatch>()
  const jobs = new Set<Promise<void>>()
  const cleanupFailures: string[] = []
  const cleanupControllers = new Set<AbortController>()
  let cacheBytes = 0
  let disposed = false
  let disposal: Promise<{ readonly cleanupFailures: readonly string[] }> | undefined
  let disposalDeadline = Infinity
  const emit = (event: PusharyCodexEvent): void => {
    try { config.onEvent(event) } catch { console.error('Pushary Codex onEvent callback failed') }
  }
  const eventFor = (request: OwnedRequest, type: PusharyCodexEvent['type'], reason?: string, decisionId?: string): void => emit({ type, requestId: request.identity.id, threadId: request.identity.threadId, turnId: request.identity.turnId, subjectDigest: request.digest, decisionId, reason })
  const track = (job: Promise<void>): void => { jobs.add(job); void job.finally(() => jobs.delete(job)).catch(() => undefined) }
  const cleanupFailed = (request: OwnedRequest, id: string): void => {
    cleanupFailures.push(id)
    eventFor(request, 'cleanup_failed', 'Decision cleanup not confirmed before deadline', id)
  }
  const cleanup = async (request: OwnedRequest, id: string): Promise<void> => {
    if (request.cleanupIds.has(id)) return
    request.cleanupIds.add(id)
    const remaining = Math.min(request.cleanupDeadline, disposalDeadline) - performance.now()
    if (remaining <= 0) { cleanupFailed(request, id); return }
    const controller = new AbortController()
    cleanupControllers.add(controller)
    const timer = setTimeout(() => controller.abort(), remaining)
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result: unknown = await decisions.cancel(id, { signal: controller.signal })
          if (!isRecord(result) || result.decisionId !== id || typeof result.cancelled !== 'boolean') throw new Error('Invalid cancellation result')
          if (result.cancelled) return
          const latest: unknown = await decisions.get(id, { signal: controller.signal })
          if (isRecord(latest) && (latest.type === 'confirm' || latest.type === 'select' || latest.type === 'input')) {
            const snapshot = decisionSnapshot(latest, latest.type, id)
            if (snapshot.status !== 'pending') return
          }
          throw new TypeError('Cancellation still pending')
        } catch (error) {
          if (controller.signal.aborted || attempt === 2 || !isRetryable(error)) throw error
          await delay(attempt === 0 ? 100 : 300, controller.signal)
        }
      }
    } catch { cleanupFailed(request, id) } finally { clearTimeout(timer); cleanupControllers.delete(controller) }
  }
  const beginCleanup = (request: OwnedRequest): void => {
    clearTimeout(request.timer)
    request.cleanupDeadline = Math.min(performance.now() + CLEANUP_MS, disposalDeadline)
    request.controller.abort()
    for (const id of request.decisionIds) track(cleanup(request, id))
  }
  const completeRequest = (request: OwnedRequest, completion: RequestCompletion): void => {
    const transition = transitionRequest(request.state, completion, {
      id: request.identity.id,
      isQuestion: request.subject.kind === 'questions',
      replyAllowed: contextLive(request),
      deadlineElapsed: performance.now() >= request.deadline,
    })
    if (!transition) return
    request.state = transition.state
    beginCleanup(request)
    if (transition.reply && contextLive(request)) {
      const interrupted = transition.interruption === null || interrupt(request.identity, transition.interruption)
      if (interrupted && contextLive(request)) {
        try { config.sendResponse(transition.reply) } catch { fatal('Response enqueue failed; close connection') }
      }
    }
    if (transition.abandonment !== null) eventFor(request, 'request_abandoned', transition.abandonment)
  }
  const dispose = (): Promise<{ readonly cleanupFailures: readonly string[] }> => {
    if (disposal) return disposal
    disposed = true
    disposalDeadline = performance.now() + CLEANUP_MS
    config.signal?.removeEventListener('abort', onAbort)
    let resolveDisposal: (value: { readonly cleanupFailures: readonly string[] }) => void = () => undefined
    disposal = new Promise(resolve => { resolveDisposal = resolve })
    threads.clear()
    patches.clear()
    cacheBytes = 0
    for (const request of requests.values()) completeRequest(request, { kind: 'abandon', reason: 'Connection disposed' })
    const finish = async (): Promise<void> => {
      const controller = new AbortController()
      const drain = async (): Promise<void> => { while (jobs.size > 0 && performance.now() < disposalDeadline) await Promise.allSettled([...jobs]) }
      await Promise.race([drain(), delay(CLEANUP_MS, controller.signal)]).catch(() => undefined)
      controller.abort()
      for (const cleanupController of cleanupControllers) cleanupController.abort()
      await Promise.resolve()
      resolveDisposal({ cleanupFailures: [...cleanupFailures] })
    }
    void finish()
    return disposal
  }
  const fatal = (reason: string): void => {
    void dispose()
    emit({ type: 'reply_failed', reason })
  }
  const overflow = (): void => { void dispose(); emit({ type: 'capacity_exceeded', reason: 'Connection must close; bounded adapter capacity exceeded' }) }
  const stateCount = (): number => requests.size + closedRequestIds.size + turns.size + completedItems.size
  const rememberTurn = (threadId: string, turnId: string, terminal: boolean): boolean => {
    const key = turnKey(threadId, turnId)
    const previous = turns.get(key)
    if (previous) { previous.terminal ||= terminal; return true }
    if (stateCount() >= MAX_REQUESTS) { overflow(); return false }
    turns.set(key, { threadId, turnId, terminal })
    return true
  }
  const contextEnded = (identity: RequestIdentity): boolean => turns.get(turnKey(identity.threadId, identity.turnId))?.terminal === true || completedItems.has(itemKey(identity.threadId, identity.turnId, identity.itemId))
  const contextLive = (request: OwnedRequest): boolean => !disposed && !contextEnded(request.identity) && threads.has(request.identity.threadId)
  const live = (request: OwnedRequest): boolean => request.state === 'pending' && contextLive(request) && performance.now() < request.deadline
  const interrupt = (identity: RequestIdentity, reason: string): boolean => {
    try { config.requestTurnInterrupt(identity.threadId, identity.turnId, reason); return !disposed } catch { fatal('Turn interrupt enqueue failed; close connection'); return false }
  }
  const fenceTurn = (threadId: string, turnId: string, reason: string): void => {
    if (!rememberTurn(threadId, turnId, true)) return
    for (const request of requests.values()) if (request.identity.threadId === threadId && request.identity.turnId === turnId) completeRequest(request, { kind: 'abandon', reason })
    for (const key of patches.keys()) {
      if (key.startsWith(JSON.stringify([threadId, turnId]).slice(0, -1) + ',')) { cacheBytes -= patches.get(key)?.bytes ?? 0; patches.delete(key) }
    }
  }
  const invalidateTurn = (threadId: string, turnId: string, reason: string): void => {
    const accepted = [...requests.values()].find(request => request.identity.threadId === threadId && request.identity.turnId === turnId && request.state === 'accepted' && !contextEnded(request.identity))
    fenceTurn(threadId, turnId, reason)
    if (accepted) {
      if (!disposed) interrupt(accepted.identity, reason)
      eventFor(accepted, 'request_abandoned', 'Invalidated after acceptance enqueue; execution outcome unknown')
    }
  }
  const unregisterThread = (threadId: string): void => {
    threads.delete(threadId)
    for (const turn of turns.values()) if (turn.threadId === threadId) invalidateTurn(threadId, turn.turnId, 'Thread unregistered')
    for (const key of patches.keys()) if (key.startsWith(JSON.stringify([threadId]).slice(0, -1) + ',')) { cacheBytes -= patches.get(key)?.bytes ?? 0; patches.delete(key) }
  }
  const createAndWait = async (request: OwnedRequest, phone: PhoneQuestion, ordinal: number): Promise<DecisionSnapshot> => {
    const payload: CreateDecision = { question: phone.question, type: phone.type, options: phone.options, context: phone.context, externalId: config.externalId, agentName: config.agentName ?? 'Codex', wait: false, requireReachable: true, expiresInSeconds: Math.ceil(timeoutMs / 1000), idempotencyKey: decisionFingerprint({ tenantId: config.tenantId, externalId: config.externalId, generation, ...request.identity, subjectDigest: request.digest, ordinal, questionId: phone.questionId ?? null }) }
    let raw: unknown
    try { raw = await withRetry(() => decisions.create(payload, { signal: request.controller.signal }), request.controller.signal) } catch (error) {
      if (request.controller.signal.aborted || isRetryable(error)) eventFor(request, 'create_outcome_unknown', 'Create may have reached server; TTL bounds residual prompt')
      throw error
    }
    if (isRecord(raw) && isText(raw.decisionId)) {
      request.decisionIds.add(raw.decisionId)
      if (!live(request)) { track(cleanup(request, raw.decisionId)); throw new Error('Request no longer live') }
    }
    if (!isRecord(raw) || !isText(raw.decisionId)) eventFor(request, 'create_outcome_unknown', 'Create returned no usable decision ID')
    let snapshot = decisionSnapshot(raw, phone.type)
    eventFor(request, 'decision_created', undefined, snapshot.decisionId)
    while (snapshot.status === 'pending') {
      if (!live(request)) throw new Error('Request no longer live')
      const next: unknown = await withRetry(() => decisions.get(snapshot.decisionId, { wait: 5, signal: request.controller.signal }), request.controller.signal)
      snapshot = decisionSnapshot(next, phone.type, snapshot.decisionId)
      if (snapshot.status === 'pending') await delay(50, request.controller.signal)
    }
    request.decisionIds.delete(snapshot.decisionId)
    eventFor(request, 'decision_settled', snapshot.status, snapshot.decisionId)
    return snapshot
  }
  const runRequest = async (request: OwnedRequest, phones: readonly PhoneQuestion[]): Promise<void> => {
    try {
      const answers: Record<string, { answers: readonly string[] }> = Object.create(null)
      for (const [ordinal, phone] of phones.entries()) {
        if (!live(request)) return
        if (ordinal > 0 && request.deadline - performance.now() < MIN_QUESTION_BUDGET_MS) { completeRequest(request, { kind: 'refuse', reason: 'Insufficient time for another question' }); return }
        const result = await createAndWait(request, phone, ordinal)
        if (!live(request)) return
        if (request.subject.kind !== 'questions') {
          const approved = result.type === 'confirm' && result.status === 'answered' && isApproved({ status: result.status, type: result.type, value: result.value })
          completeRequest(request, { kind: 'reply', reply: { id: request.identity.id, result: { decision: approved ? 'accept' : request.declineDecision } } })
          return
        }
        if (!result.answered || !result.value?.trim() || result.value.length > 2000 || (phone.options && !phone.options.includes(result.value))) { completeRequest(request, { kind: 'refuse', reason: 'Question did not receive a valid answer' }); return }
        const question = request.subject.questions[ordinal]
        if (!question || !phone.questionId) throw new Error('Question identity missing')
        const selectedIndex = phone.options?.indexOf(result.value)
        const answer = selectedIndex !== undefined ? question.options?.[selectedIndex]?.label : result.value
        if (answer === undefined) throw new Error('Question option missing')
        answers[phone.questionId] = { answers: [answer] }
      }
      completeRequest(request, { kind: 'reply', reply: { id: request.identity.id, result: { answers } } })
    } catch (error) { if (live(request)) completeRequest(request, { kind: 'refuse', reason: decisionFailureReason(error) }) }
  }
  const observe = (method: string, params: Record<string, unknown>): CodexDispatchResult => {
    if (method === 'serverRequest/resolved' && isId(params.requestId)) {
      const request = requests.get(rpcKey(params.requestId))
      if (request && params.threadId === request.identity.threadId) completeRequest(request, { kind: 'abandon', reason: 'Server request resolved' })
    }
    if (isText(params.threadId)) {
      if (threads.has(params.threadId) && isRecord(params.turn) && isText(params.turn.id) && method === 'turn/started') rememberTurn(params.threadId, params.turn.id, false)
      if (['thread/closed', 'thread/archived', 'thread/settings/updated'].includes(method)) unregisterThread(params.threadId)
      if (isText(params.turnId) && ['turn/completed', 'turn/interrupted', 'turn/failed'].includes(method)) fenceTurn(params.threadId, params.turnId, method)
      if (isRecord(params.turn) && isText(params.turn.id) && method === 'turn/completed') fenceTurn(params.threadId, params.turn.id, method)
      const itemId = isRecord(params.item) && isText(params.item.id) ? params.item.id : params.itemId
      if (isText(params.turnId) && isText(itemId)) {
        const key = itemKey(params.threadId, params.turnId, itemId)
        if (method === 'item/completed') {
          if (!completedItems.has(key) && stateCount() >= MAX_REQUESTS) { overflow(); return { kind: 'invalid', reason: 'Terminal item capacity exceeded' } }
          completedItems.add(key)
          for (const request of requests.values()) if (itemKey(request.identity.threadId, request.identity.turnId, request.identity.itemId) === key) completeRequest(request, { kind: 'abandon', reason: 'Item completed' })
          cacheBytes -= patches.get(key)?.bytes ?? 0
          patches.delete(key)
        }
        if (threads.has(params.threadId) && !completedItems.has(key) && turns.get(turnKey(params.threadId, params.turnId))?.terminal !== true && (method === 'item/fileChange/patchUpdated' || (method === 'item/started' && isRecord(params.item) && params.item.type === 'fileChange'))) {
          if (!rememberTurn(params.threadId, params.turnId, false)) return { kind: 'invalid', reason: 'Turn capacity exceeded' }
          const raw = method === 'item/started' && isRecord(params.item) ? params.item.changes : params.changes
          const previous = patches.get(key)
          const parsed = fileChangesOf(raw)
          const digest = decisionFingerprint(parsed)
          const conflict = previous !== undefined && previous.digest !== digest
          const changes = (method === 'item/fileChange/patchUpdated' && !previous) || (method === 'item/started' && conflict) || previous?.changes === null ? null : parsed
          const bytes = Buffer.byteLength(JSON.stringify(changes))
          if ((!previous && patches.size >= MAX_ITEMS) || cacheBytes - (previous?.bytes ?? 0) + bytes > MAX_CACHE_BYTES) { overflow(); return { kind: 'invalid', reason: 'Patch capacity exceeded' } }
          patches.set(key, { changes, digest, bytes })
          cacheBytes += bytes - (previous?.bytes ?? 0)
          if (conflict || changes === null) for (const request of requests.values()) if (itemKey(request.identity.threadId, request.identity.turnId, request.identity.itemId) === key) {
            if (request.state === 'accepted' && !contextEnded(request.identity)) invalidateTurn(request.identity.threadId, request.identity.turnId, 'Reviewed patch changed after acceptance')
            else completeRequest(request, { kind: 'refuse', reason: 'Reviewed patch changed' })
          }
        }
      }
    }
    return { kind: 'observed' }
  }
  const delegateToNative = (id: string | number, reason: string): CodexDispatchResult => {
    if (stateCount() >= MAX_REQUESTS) { overflow(); return { kind: 'invalid', reason: 'Request capacity exceeded' } }
    closedRequestIds.add(rpcKey(id))
    emit({ type: 'native_review_required', requestId: id, reason })
    return disposed ? { kind: 'invalid', reason: 'Disposed during native handoff' } : { kind: 'unhandled', reason }
  }
  const dispatch = (message: unknown): CodexDispatchResult => {
    if (disposed) return { kind: 'invalid', reason: 'Adapter disposed' }
    if (!isRecord(message) || !isText(message.method) || !isRecord(message.params)) return { kind: 'invalid', reason: 'Invalid server envelope' }
    if (message.id === undefined) return observe(message.method, message.params)
    if (!isId(message.id)) return { kind: 'invalid', reason: 'Invalid RPC ID' }
    if (closedRequestIds.has(rpcKey(message.id))) return { kind: 'claimed' }
    const previous = requests.get(rpcKey(message.id))
    if (previous) {
      if (previous.envelopeDigest !== decisionFingerprint({ method: message.method, params: message.params })) {
        if (previous.state === 'accepted') invalidateTurn(previous.identity.threadId, previous.identity.turnId, 'Conflicting duplicate request')
        else completeRequest(previous, { kind: 'conflict', reason: 'Conflicting duplicate request' })
      }
      return { kind: 'claimed' }
    }
    if (![COMMAND, FILES, QUESTIONS].includes(message.method)) return delegateToNative(message.id, 'Unsupported server method')
    const identity = identityOf(message.id, message.method, message.params)
    if (!identity) return { kind: 'invalid', reason: 'Malformed request identity; close connection' }
    if (contextEnded(identity)) {
      if (stateCount() >= MAX_REQUESTS) { overflow(); return { kind: 'invalid', reason: 'Request capacity exceeded' } }
      closedRequestIds.add(rpcKey(identity.id))
      if (identity.method === QUESTIONS && !interrupt(identity, 'Request context has ended')) return { kind: 'invalid', reason: 'Interrupt failed' }
      if (!disposed) config.sendResponse(identity.method === QUESTIONS ? { id: identity.id, error: { code: -32000, message: 'Request context has ended' } } : { id: identity.id, result: { decision: 'cancel' } })
      return { kind: 'claimed' }
    }
    if (!threads.has(identity.threadId)) return delegateToNative(message.id, 'Unregistered request context')
    if (!rememberTurn(identity.threadId, identity.turnId, false)) return { kind: 'invalid', reason: 'Turn capacity exceeded' }
    const subject = subjectOf(message.method, message.params, patches.get(itemKey(identity.threadId, identity.turnId, identity.itemId))?.changes ?? null, config.experimentalQuestions === true)
    if (subject.kind === 'malformed') {
      if (stateCount() >= MAX_REQUESTS) { overflow(); return { kind: 'invalid', reason: 'Request capacity exceeded' } }
      closedRequestIds.add(rpcKey(message.id))
      if (message.method === QUESTIONS && !interrupt(identity, subject.reason)) return { kind: 'invalid', reason: 'Interrupt failed' }
      try { config.sendResponse({ id: message.id, error: { code: -32602, message: subject.reason } }) } catch { fatal('Invalid-params response enqueue failed') }
      return { kind: 'claimed' }
    }
    if (subject.kind === 'unsupported') return delegateToNative(message.id, subject.reason)
    const digest = decisionFingerprint(subject.subject)
    const phones = presentSubject(subject.subject)
    if (!phones) return delegateToNative(message.id, 'Subject exceeds presentation limits')
    if (stateCount() >= MAX_REQUESTS || [...requests.values()].filter(request => request.state === 'pending').length >= MAX_PENDING) { overflow(); return { kind: 'invalid', reason: 'Request capacity exceeded' } }
    const controller = new AbortController()
    const timer = setTimeout(() => { const request = requests.get(rpcKey(identity.id)); if (request) completeRequest(request, { kind: 'refuse', reason: 'Decision deadline elapsed' }) }, timeoutMs)
    const request: OwnedRequest = { identity, declineDecision: Array.isArray(message.params.availableDecisions) && !message.params.availableDecisions.includes('decline') ? 'cancel' : 'decline', digest, envelopeDigest: decisionFingerprint({ method: message.method, params: message.params }), subject: subject.subject, controller, deadline: performance.now() + timeoutMs, timer, decisionIds: new Set(), cleanupIds: new Set(), state: 'pending', cleanupDeadline: Infinity }
    requests.set(rpcKey(identity.id), request)
    let allowed = false
    try { allowed = config.maySendSubject(structuredClone(subject.subject)) === true } catch { allowed = false }
    if (disposed) return { kind: 'invalid', reason: 'Disposed during privacy review' }
    if (!live(request)) return { kind: 'claimed' }
    if (!allowed) {
      completeRequest(request, { kind: 'native' })
      requests.delete(rpcKey(identity.id))
      return delegateToNative(message.id, 'Subject rejected by privacy policy')
    }
    track(runRequest(request, phones))
    return { kind: 'claimed' }
  }
  const handle = (message: unknown): CodexDispatchResult => {
    try { return dispatch(message) } catch {
      fatal('Invalid message or host callback; close connection')
      return { kind: 'invalid', reason: 'Message could not be validated' }
    }
  }
  const registerThread = (value: unknown): void => {
    if (disposed) throw new Error('Adapter disposed')
    const id = certifiedThread(value)
    if (!id) throw new TypeError('Thread requires user approvals and a certified sandbox')
    if ([...requests.values()].some(request => request.state === 'pending' && request.identity.threadId === id)) throw new Error('Cannot replace thread policy while approval is pending')
    if (!threads.has(id) && threads.size >= MAX_THREADS) { overflow(); throw new Error('Thread capacity exceeded') }
    threads.add(id)
  }
  function onAbort(): void { void dispose() }
  config.signal?.addEventListener('abort', onAbort, { once: true })
  if (config.signal?.aborted) void dispose()
  return { registerThread, unregisterThread, handle, invalidateTurn, dispose }
}
