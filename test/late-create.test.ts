import { afterEach, expect, it, vi } from 'vitest'
import { createPusharyCodexHandler } from '../src/index'
import type { PusharyCodexEvent } from '../src/types'
const sdk = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), cancel: vi.fn() }))
vi.mock('@pushary/server', async importOriginal => ({ ...await importOriginal<typeof import('@pushary/server')>(), createPusharyServer: () => ({ decisions: sdk }) }))
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })
const setup = () => {
  const events: PusharyCodexEvent[] = []
  const replies = vi.fn()
  const handler = createPusharyCodexHandler({ apiKey: 'pk_test.secret', tenantId: 'tenant', externalId: 'customer', codexVersion: '0.160.1', maySendSubject: () => true, sendResponse: replies, requestTurnInterrupt: () => {}, onEvent: event => events.push(event) })
  handler.registerThread({ thread: { id: 'thread', status: { type: 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } })
  handler.handle({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'echo test', cwd: '/tmp', startedAtMs: 1 } })
  return { handler, events, replies }
}
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() }
it('withdraws an SDK create result observed after cancellation before the cleanup deadline', async () => {
  let complete: (result: unknown) => void = () => undefined
  sdk.create.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  sdk.cancel.mockResolvedValue({ decisionId: 'late', cancelled: true })
  const { handler, replies } = setup()
  const disposal = handler.dispose()
  complete({ decisionId: 'late', type: 'confirm', status: 'pending', answered: false })
  expect(await disposal).toEqual({ cleanupFailures: [] })
  expect(sdk.cancel).toHaveBeenCalledWith('late', { signal: expect.any(AbortSignal) })
  expect(replies).not.toHaveBeenCalled()
})
it('reports an SDK create result observed after disposal without extending the finished cleanup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let complete: (result: unknown) => void = () => undefined
  sdk.create.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const { handler, events, replies } = setup()
  const disposal = handler.dispose(); await vi.advanceTimersByTimeAsync(5001)
  expect(await disposal).toEqual({ cleanupFailures: [] })
  complete({ decisionId: 'late', type: 'confirm', status: 'pending', answered: false }); await flush()
  expect(events).toContainEqual(expect.objectContaining({ type: 'cleanup_failed', decisionId: 'late' }))
  expect(sdk.cancel).not.toHaveBeenCalled(); expect(replies).not.toHaveBeenCalled()
  expect(await handler.dispose()).toEqual({ cleanupFailures: [] })
})
