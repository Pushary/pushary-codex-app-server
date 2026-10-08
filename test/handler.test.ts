import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPusharyCodexHandler } from '../src/index'
import type { CodexReply, PusharyCodexConfig, PusharyCodexEvent, PusharyCodexHandler } from '../src/types'

const command = (id: string | number = 1, extra: Record<string, unknown> = {}) => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'touch output', cwd: '/workspace', startedAtMs: 1, ...extra } })
const question = (extra: Record<string, unknown> = {}) => ({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions: [{ id: 'q1', header: 'Pick', question: 'Which?', isOther: false, isSecret: false, options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }], ...extra } })
const fileStart = (diff = '+hello') => ({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { id: 'file', type: 'fileChange', changes: [{ path: '/workspace/a', kind: { type: 'add' }, diff }] } } })
const fileApproval = () => ({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'file', startedAtMs: 1 } })
const pending = (decisionId = 'd1') => Response.json({ decisionId, status: 'pending', answered: false, type: 'confirm' })
const answered = (value = 'yes', type = 'confirm', decisionId = 'd1') => Response.json({ decisionId, status: 'answered', answered: true, value, type })
const flush = async () => { for (let n = 0; n < 30; n += 1) await Promise.resolve() }
const instances: PusharyCodexHandler[] = []
const setup = (overrides: Partial<PusharyCodexConfig> = {}) => {
  const replies: CodexReply[] = []
  const events: PusharyCodexEvent[] = []
  const interrupts = vi.fn()
  const handler = createPusharyCodexHandler({ apiKey: 'pk_test.test', tenantId: 'tenant', externalId: 'customer', codexVersion: '0.160.1', timeoutMs: 60_000, maySendSubject: () => true, sendResponse: reply => replies.push(reply), onEvent: event => events.push(event), requestTurnInterrupt: interrupts, ...overrides })
  handler.registerThread({ thread: { id: 'thread', status: { type: 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } })
  instances.push(handler)
  return { handler, replies, events, interrupts }
}
afterEach(async () => { await Promise.all(instances.splice(0).map(handler => handler.dispose())); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('live request ownership', () => {
  it.each(['privacy', 'unsupported', 'oversized', 'method', 'unregistered'])('keeps one native owner during %s fallback callbacks and later redelivery', async scenario => {
    const fetch = vi.fn(async () => answered()); vi.stubGlobal('fetch', fetch)
    let allowed = scenario !== 'privacy'
    let handler: PusharyCodexHandler
    const nested: string[] = []
    const configured = setup({
      maySendSubject: () => allowed,
      onEvent: event => {
        if (event.type !== 'native_review_required') return
        allowed = true
        nested.push(handler.handle(command()).kind)
      },
    })
    handler = configured.handler
    if (scenario === 'unregistered') handler.unregisterThread('thread')
    const incoming = scenario === 'method' ? { ...command(), method: 'unsupported/method' }
      : command(1, scenario === 'unsupported' ? { additionalPermissions: { network: true } }
        : scenario === 'oversized' ? { command: 'x'.repeat(9_000) } : {})
    expect(handler.handle(incoming).kind).toBe('unhandled')
    expect(nested).toEqual(['claimed'])
    expect(handler.handle(command()).kind).toBe('claimed')
    await flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(configured.replies).toEqual([])
  })
  it.each([['yes', 'accept'], ['no', 'decline']])('maps %s to %s exactly once', async (value, decision) => {
    const fetch = vi.fn(async () => answered(value)); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup()
    expect(handler.handle(command())).toEqual({ kind: 'claimed' })
    handler.handle(command()); await flush(); handler.handle(command())
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(replies).toEqual([{ id: 1, result: { decision } }])
  })
  it('separates typed RPC ids and callbacks under one item', async () => {
    const fetch = vi.fn(async () => answered()); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup()
    handler.handle(command(1, { approvalId: 'first' })); handler.handle(command('1', { approvalId: 'second' })); await flush()
    const payloads = fetch.mock.calls.map(call => call)
    expect(payloads).toHaveLength(2); expect(replies).toHaveLength(2)
  })
  it.each(['serverRequest/resolved', 'item/completed', 'turn/completed', 'thread/closed', 'thread/settings/updated'])('%s fences an in-flight create whose response is aborted', async method => {
    let complete: (response: Response) => void = () => undefined
    const fetch = vi.fn((_url: unknown, options?: RequestInit) => options?.method === 'DELETE' ? Promise.resolve(Response.json({ decisionId: 'd1', cancelled: true })) : new Promise<Response>(resolve => { complete = resolve }))
    vi.stubGlobal('fetch', fetch)
    const { handler, replies, events } = setup(); handler.handle(command())
    handler.handle({ method, params: { threadId: 'thread', turnId: 'turn', requestId: 1, item: { id: 'item' } } })
    complete(pending()); await flush()
    expect(replies).toEqual([]); expect(fetch.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(false)
    expect(events.some(event => event.type === 'create_outcome_unknown')).toBe(true)
  })
  it('keeps polling after a pending response', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(pending()).mockResolvedValueOnce(pending()).mockResolvedValueOnce(answered())
    vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup(); handler.handle(command()); await flush()
    expect(replies).toEqual([]); await vi.advanceTimersByTimeAsync(50)
    expect(replies).toEqual([{ id: 1, result: { decision: 'accept' } }])
  })
  it('refuses a changed duplicate even when its new form is unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'DELETE' ? Response.json({ decisionId: 'd1', cancelled: true }) : pending()))
    const { handler, replies, interrupts } = setup(); handler.handle(command()); await flush()
    handler.handle(command(1, { additionalPermissions: { network: true } })); await flush()
    expect(interrupts).toHaveBeenCalledOnce(); expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
  })
  it('lets reentrant disposal win before acceptance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answered()))
    let handler: PusharyCodexHandler
    const configured = setup({ onEvent: event => { if (event.type === 'decision_settled') void handler.dispose() } }); handler = configured.handler
    handler.handle(command()); await flush(); expect(configured.replies).toEqual([])
    expect(handler.dispose()).toBe(handler.dispose())
  })
  it('stops the connection when the writer throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answered()))
    const { handler, events } = setup({ sendResponse: () => { throw new Error('writer failed') } })
    handler.handle(command()); await flush()
    expect(events.some(event => event.type === 'reply_failed')).toBe(true)
    expect(handler.handle(command(2)).kind).toBe('invalid')
  })
  it('enforces deadline even with a supplied signal', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_url, options) => options?.method === 'DELETE' ? Response.json({ decisionId: 'd1', cancelled: true }) : pending())
    vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup({ signal: new AbortController().signal }); handler.handle(command())
    await vi.advanceTimersByTimeAsync(60_001)
    expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
    expect(fetch.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(true)
  })
  it('retries transient create with identical idempotency and payload', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(answered())
    vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup(); handler.handle(command()); await vi.advanceTimersByTimeAsync(400)
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body); expect(replies).toHaveLength(1)
  })
  it.each([400, 401, 403, 404, 409])('does not retry HTTP %i', async status => {
    const fetch = vi.fn(async () => Response.json({ error: 'refused' }, { status })); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup(); handler.handle(command()); await flush()
    expect(fetch).toHaveBeenCalledOnce(); expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
  })
  it('rejects malformed decision types without accepting', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'DELETE' ? Response.json({ decisionId: 'd1', cancelled: true }) : answered('yes', 'select')))
    const { handler, replies } = setup(); handler.handle(command()); await flush()
    expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
  })
  it('stops at pending capacity instead of evicting requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => options?.method === 'DELETE' ? Response.json({ decisionId: 'd1', cancelled: true }) : pending()))
    const { handler, events } = setup()
    for (let id = 0; id < 9; id += 1) handler.handle(command(id))
    await flush(); expect(events.some(event => event.type === 'capacity_exceeded')).toBe(true)
    expect(handler.handle(command(10)).kind).toBe('invalid')
  })
})

describe('subjects and fallbacks', () => {
  it('never sends a partial patch for review when an operation is malformed', async () => {
    const fetch = vi.fn(async () => answered()); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup()
    const started = fileStart()
    handler.handle({ ...started, params: { ...started.params, item: { ...started.params.item, changes: [
      ...started.params.item.changes,
      { path: '/workspace/omitted', kind: { type: ['delete'] }, diff: '-omitted' },
    ] } } })
    expect(handler.handle(fileApproval()).kind).toBe('unhandled')
    await flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(replies).toEqual([])
  })
  it.each([{ kind: 'writeStdin' }, { networkApprovalContext: {} }, { proposedExecpolicyAmendment: [1] }, { additionalPermissions: {} }, { environmentId: 'remote' }, { command: 'x'.repeat(8001) }])('does not prompt unsupported subject %j', extra => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { handler } = setup(); expect(['unhandled', 'claimed']).toContain(handler.handle(command(1, extra)).kind); expect(fetch).not.toHaveBeenCalled()
  })
  it('enforces privacy before network access', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { handler } = setup({ maySendSubject: () => false }); expect(handler.handle(command()).kind).toBe('unhandled'); expect(fetch).not.toHaveBeenCalled()
  })
  it.each([null, true, 1.2, {}])('rejects invalid RPC id %j', id => {
    const { handler } = setup(); expect(handler.handle({ ...command(), id }).kind).toBe('invalid')
  })
  it('rejects auto reviewer and unrestricted sandbox', () => {
    const { handler } = setup()
    for (const extra of [{ approvalsReviewer: 'auto_review' }, { sandbox: { type: 'dangerFullAccess' } }, { approvalPolicy: 'never' }, { approvalPolicy: ['on-request'] }]) expect(() => handler.registerThread({ thread: { id: 'other', status: { type: 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, ...extra })).toThrow()
  })
  it('requires a complete cached patch', () => {
    const { handler } = setup(); expect(handler.handle(fileApproval()).kind).toBe('unhandled')
  })
  it('withdraws an approval if the patch changes', async () => {
    const fetch = vi.fn(async (_url, options) => options?.method === 'DELETE' ? Response.json({ decisionId: 'd1', cancelled: true }) : pending()); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup(); handler.handle(fileStart()); handler.handle(fileApproval()); await flush()
    handler.handle({ method: 'item/fileChange/patchUpdated', params: { threadId: 'thread', turnId: 'turn', itemId: 'file', changes: [{ path: '/workspace/a', kind: { type: 'add' }, diff: '+changed' }] } }); await flush()
    expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }]); expect(fetch.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(true)
  })
  it('returns exact question labels and IDs atomically', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answered('B', 'select')))
    const { handler, replies } = setup({ experimentalQuestions: true }); handler.handle(question()); await flush()
    expect(replies).toEqual([{ id: 1, result: { answers: { q1: { answers: ['B'] } } } }])
  })
  it('interrupts a blocking question before returning failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answered('not an option', 'select')))
    const order: string[] = []
    const { handler } = setup({ experimentalQuestions: true, requestTurnInterrupt: () => { order.push('interrupt') }, sendResponse: () => { order.push('reply') } })
    handler.handle(question()); await flush(); expect(order).toEqual(['interrupt', 'reply'])
  })
  it('prevalidates the whole batch before showing any question', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const { handler } = setup({ experimentalQuestions: true })
    const batch = question(); batch.params.questions.push({ ...batch.params.questions[0], id: 'q2', isSecret: true })
    expect(handler.handle(batch).kind).toBe('unhandled'); expect(fetch).not.toHaveBeenCalled()
  })
})

describe('cleanup and terminal races', () => {
  it('interrupts an accepted turn invalidated after enqueue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answered()))
    const { handler, interrupts, events } = setup(); handler.handle(command()); await flush()
    handler.invalidateTurn('thread', 'turn', 'Host stopped')
    expect(interrupts).toHaveBeenCalledOnce(); expect(events.some(event => event.reason?.includes('outcome unknown'))).toBe(true)
  })
  it('does not interrupt an already completed accepted item', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answered()))
    const { handler, interrupts } = setup(); handler.handle(command()); await flush()
    handler.handle({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'item' } } })
    handler.invalidateTurn('thread', 'turn', 'Host stopped'); expect(interrupts).not.toHaveBeenCalled()
  })
  it('bounds disposal and reports an unobservable aborted create after the cleanup deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let complete: (response: Response) => void = () => undefined
    const fetch = vi.fn(() => new Promise<Response>(resolve => { complete = resolve })); vi.stubGlobal('fetch', fetch)
    const { handler, events, replies } = setup(); handler.handle(command())
    const disposal = handler.dispose(); await vi.advanceTimersByTimeAsync(5001)
    expect(await disposal).toEqual({ cleanupFailures: [] })
    complete(pending()); await flush()
    expect(events.some(event => event.type === 'create_outcome_unknown')).toBe(true)
    expect(replies).toEqual([]); expect(fetch).toHaveBeenCalledOnce()
  })
  it('waits for confirmation of known decision cancellation within disposal budget', async () => {
    let completeCancel: (response: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      if (options?.method === 'POST') return Promise.resolve(pending())
      if (options?.method === 'DELETE') return new Promise<Response>(resolve => { completeCancel = resolve })
      return new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
    }))
    const { handler } = setup(); handler.handle(command()); await flush(); let disposed = false
    const disposal = handler.dispose().then(() => { disposed = true }); await flush()
    expect(disposed).toBe(false); completeCancel(Response.json({ decisionId: 'd1', cancelled: true })); await disposal
    expect(disposed).toBe(true)
  })
  it('fresh-reads when cancellation loses to an answer and never resurrects the request', async () => {
    let gets = 0
    const fetch = vi.fn(async (_url, options) => {
      if (options?.method === 'POST') return pending()
      if (options?.method === 'DELETE') return Response.json({ decisionId: 'd1', cancelled: false })
      gets += 1
      if (gets === 1) return new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
      return answered()
    }); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup(); handler.handle(command()); await flush(); handler.invalidateTurn('thread', 'turn', 'cancel'); await flush()
    expect(replies).toEqual([]); expect(gets).toBe(2)
  })
  it('reports an unknown create outcome when owner abort reaches fetch', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))))
    const { handler, events } = setup(); handler.handle(command()); await handler.dispose()
    expect(events.some(event => event.type === 'create_outcome_unknown')).toBe(true)
  })
  it('records cleanup failures after three transient attempts', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (_url, options) => options?.method === 'DELETE' ? Response.json({ error: 'down' }, { status: 503 }) : pending()); vi.stubGlobal('fetch', fetch)
    const { handler } = setup(); handler.handle(command()); await flush()
    const disposed = handler.dispose(); await vi.advanceTimersByTimeAsync(500)
    expect(await disposed).toEqual({ cleanupFailures: ['d1'] })
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'DELETE')).toHaveLength(3)
  })
  it('does not leak raw callback errors into telemetry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answered()))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { handler, replies } = setup({ onEvent: () => { throw new Error('secret') } }); handler.handle(command()); await flush()
    expect(replies).toHaveLength(1); expect(JSON.stringify(logged.mock.calls)).not.toContain('secret'); logged.mockRestore()
  })
  it('fences a poll answer that arrives after invalidation', async () => {
    let complete: (response: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn((_url, options) => options?.method === 'POST' ? Promise.resolve(pending()) : options?.method === 'DELETE' ? Promise.resolve(Response.json({ decisionId: 'd1', cancelled: true })) : new Promise<Response>(resolve => { complete = resolve })))
    const { handler, replies } = setup(); handler.handle(command()); await flush()
    handler.invalidateTurn('thread', 'turn', 'stop'); complete(answered()); await flush(); expect(replies).toEqual([])
  })
  it('refuses stale API decision IDs', async () => {
    const fetch = vi.fn(async (_url, options) => options?.method === 'POST' ? pending() : options?.method === 'GET' ? answered('yes', 'confirm', 'someone-else') : Response.json({ decisionId: 'd1', cancelled: true })); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup(); handler.handle(command()); await flush()
    expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
  })
  it('tombstones malformed recognized requests', () => {
    const { handler, replies } = setup(); handler.handle(command(1, { command: null })); handler.handle(command())
    expect(replies).toHaveLength(1); expect(replies[0]).toMatchObject({ error: { code: -32602 } })
  })
  it('binds idempotency to tenant, customer and generation', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => { bodies.push(JSON.parse(options.body)); return answered() }))
    for (const overrides of [{}, {}, { tenantId: 'another-tenant' }, { externalId: 'another-customer' }]) setup(overrides).handler.handle(command())
    await flush(); expect(new Set(bodies.map(body => body.idempotencyKey)).size).toBe(4)
    expect(bodies[3]?.externalId).toBe('another-customer')
  })
})

describe('adversarial reentrancy and terminal ownership', () => {
  it.each(['command', 'files', 'questions'])('settles conflicting %s requests before interrupting and withdraws once', async kind => {
    const fetch = vi.fn(async (_url, options) => options?.method === 'DELETE'
      ? Response.json({ decisionId: 'd1', cancelled: true })
      : Response.json({ decisionId: 'd1', type: kind === 'questions' ? 'select' : 'confirm', status: 'pending', answered: false }))
    vi.stubGlobal('fetch', fetch)
    const request = kind === 'command' ? command() : kind === 'files' ? fileApproval() : question()
    const conflict = { ...request, params: { ...request.params, unknownPermission: true } }
    const order: string[] = []
    let handler: PusharyCodexHandler
    const interruption = vi.fn(() => {
      order.push('interrupt')
      handler.handle(conflict)
    })
    const configured = setup({ experimentalQuestions: true, requestTurnInterrupt: interruption, sendResponse: () => { order.push('reply') } })
    handler = configured.handler
    if (kind === 'files') handler.handle(fileStart())
    handler.handle(request); await flush()
    handler.handle(conflict); await flush()
    handler.handle(conflict); await flush()
    expect(interruption).toHaveBeenCalledOnce()
    expect(order).toEqual(['interrupt', 'reply'])
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'DELETE')).toHaveLength(1)
    expect(configured.events.filter(event => event.type === 'request_abandoned')).toHaveLength(1)
  })
  it.each(['turn/completed', 'item/completed', 'dispose'])('suppresses deadline replies if interruption reentrantly causes %s', async action => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const fetch = vi.fn(async (_url, options) => options?.method === 'DELETE'
      ? Response.json({ decisionId: 'd1', cancelled: true })
      : Response.json({ decisionId: 'd1', type: 'select', status: 'pending', answered: false }))
    vi.stubGlobal('fetch', fetch)
    let handler: PusharyCodexHandler
    const interruption = vi.fn(() => {
      if (action === 'dispose') void handler.dispose()
      else handler.handle({ method: action, params: { threadId: 'thread', turnId: 'turn', item: { id: 'item' } } })
    })
    const configured = setup({ experimentalQuestions: true, requestTurnInterrupt: interruption })
    handler = configured.handler
    handler.handle(question()); await flush()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(interruption).toHaveBeenCalledOnce()
    expect(configured.replies).toEqual([])
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'DELETE')).toHaveLength(1)
    expect(configured.events.filter(event => event.type === 'request_abandoned')).toHaveLength(1)
  })
  it('commits refusal before interruption callbacks can redispatch conflicting questions', async () => {
    const fetch = vi.fn(async () => answered('invalid', 'select')); vi.stubGlobal('fetch', fetch)
    let handler: PusharyCodexHandler
    const interruption = vi.fn(() => { handler.handle(question({ isBlocking: false })) })
    const configured = setup({ experimentalQuestions: true, requestTurnInterrupt: interruption })
    handler = configured.handler
    handler.handle(question()); await flush()
    expect(interruption).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    expect(configured.replies).toEqual([{ id: 1, error: { code: -32000, message: 'Question did not receive a valid answer' } }])
    expect(configured.events.filter(event => event.type === 'request_abandoned')).toHaveLength(1)
  })
  it('reserves ownership before reentrant privacy review', async () => {
    const fetch = vi.fn(async () => answered()); vi.stubGlobal('fetch', fetch)
    let reentered = false
    let handler: PusharyCodexHandler
    const configured = setup({ maySendSubject: () => {
      if (!reentered) { reentered = true; expect(handler.handle(command())).toEqual({ kind: 'claimed' }) }
      return true
    } }); handler = configured.handler
    handler.handle(command()); await flush()
    expect(fetch).toHaveBeenCalledOnce(); expect(configured.replies).toEqual([{ id: 1, result: { decision: 'accept' } }])
  })
  it('fences patch changes delivered inside privacy review', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    let handler: PusharyCodexHandler
    const configured = setup({ maySendSubject: () => {
      handler.handle({ method: 'item/fileChange/patchUpdated', params: { threadId: 'thread', turnId: 'turn', itemId: 'file', changes: [{ path: '/workspace/a', kind: { type: 'add' }, diff: '+changed' }] } })
      return true
    } }); handler = configured.handler
    handler.handle(fileStart()); handler.handle(fileApproval()); await flush()
    expect(fetch).not.toHaveBeenCalled(); expect(configured.replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
  })
  it.each(['invalidate', 'turn/completed', 'item/completed'])('refuses new RPCs after %s even with no earlier request', async notification => {
    const fetch = vi.fn(async () => answered()); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup()
    if (notification === 'invalidate') handler.invalidateTurn('thread', 'turn', 'Stopped')
    else handler.handle({ method: notification, params: { threadId: 'thread', turnId: 'turn', item: { id: 'item' } } })
    handler.handle(command()); await flush()
    expect(fetch).not.toHaveBeenCalled(); expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
  })
  it('cannot resurrect an observed turn by unregistering and registering', async () => {
    const fetch = vi.fn(async () => answered()); vi.stubGlobal('fetch', fetch)
    const { handler, replies } = setup()
    handler.handle({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } })
    handler.unregisterThread('thread')
    handler.registerThread({ thread: { id: 'thread', status: { type: 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } })
    handler.handle(command()); await flush()
    expect(fetch).not.toHaveBeenCalled(); expect(replies).toEqual([{ id: 1, result: { decision: 'cancel' } }])
  })
  it.each(['patch', 'thread/settings/updated', 'unregister'])('interrupts %s changes after acceptance before item completion', async action => {
    vi.stubGlobal('fetch', vi.fn(async () => answered()))
    const { handler, interrupts, events, replies } = setup()
    handler.handle(fileStart()); handler.handle(fileApproval()); await flush()
    if (action === 'patch') handler.handle({ method: 'item/fileChange/patchUpdated', params: { threadId: 'thread', turnId: 'turn', itemId: 'file', changes: [{ path: '/workspace/a', kind: { type: 'add' }, diff: '+changed' }] } })
    else if (action === 'unregister') handler.unregisterThread('thread')
    else handler.handle({ method: action, params: { threadId: 'thread' } })
    expect(interrupts).toHaveBeenCalledOnce()
    expect(events.some(event => event.reason?.includes('outcome unknown'))).toBe(true)
    expect(replies).toEqual([{ id: 1, result: { decision: 'accept' } }])
  })
  it('fences a turn before invoking interruption callbacks', async () => {
    const fetch = vi.fn(async () => answered()); vi.stubGlobal('fetch', fetch)
    let handler: PusharyCodexHandler
    const configured = setup({ requestTurnInterrupt: () => { handler.handle(command(2)) } }); handler = configured.handler
    handler.handle(command()); await flush(); handler.invalidateTurn('thread', 'turn', 'stop'); await flush()
    expect(fetch).toHaveBeenCalledOnce()
    expect(configured.replies).toEqual([{ id: 1, result: { decision: 'accept' } }, { id: 2, result: { decision: 'cancel' } }])
  })
})
