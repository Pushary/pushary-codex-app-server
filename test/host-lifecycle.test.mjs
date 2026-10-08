import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startStdioHost } from '../examples/stdio-host.mjs'

const adapterConfig = { apiKey: 'pk_test.secret', tenantId: 'tenant', externalId: 'customer', codexVersion: '0.160.1', maySendSubject: () => true, onEvent: () => {} }
const peerSource = `
import { createInterface } from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'pushary_codex_host/0.160.1 fake-peer' } })
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread', status: { type: 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } } })
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } })
    send({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 1, command: 'echo test', cwd: process.cwd() } })
  }
})
`
const fixture = async context => {
  const scratch = await mkdtemp(join(tmpdir(), 'pushary-codex-host-lifecycle-'))
  context.after(() => rm(scratch, { recursive: true, force: true }))
  const peer = join(scratch, 'peer.mjs')
  await writeFile(peer, peerSource)
  return { executable: process.execPath, args: [peer], cwd: scratch, codexHome: scratch, adapterConfig }
}

test('invalid adapter configuration is rejected before spawning a process', { timeout: 5000 }, async context => {
  const options = await fixture(context)
  const spawn = context.mock.method(childProcess, 'spawn', () => { throw new Error('Unexpected child spawn') })
  syncBuiltinESMExports()
  try {
    await assert.rejects(startStdioHost({ ...options, adapterConfig: { ...adapterConfig, timeoutMs: 1 } }), /configuration/)
    assert.equal(spawn.mock.callCount(), 0)
  } finally { spawn.mock.restore(); syncBuiltinESMExports() }
})

test('a missing executable settles startup failure and shutdown', { timeout: 5000 }, async context => {
  const options = await fixture(context)
  await assert.rejects(startStdioHost({ ...options, executable: join(options.cwd, 'missing-codex') }), /closed/)
})

test('a synchronous spawn failure disposes the adapter and rejects', { timeout: 5000 }, async context => {
  const options = await fixture(context)
  await assert.rejects(startStdioHost({ ...options, executable: '' }), /file|argument/i)
})

test('a pre-aborted owner never launches a child', { timeout: 5000 }, async context => {
  const options = await fixture(context)
  const reason = new Error('owner stopped')
  await assert.rejects(startStdioHost({ ...options, adapterConfig: { ...adapterConfig, signal: AbortSignal.abort(reason) } }), error => error === reason)
})

test('closed hosts reject new turn waiters and RPCs immediately', { timeout: 5000 }, async context => {
  const host = await startStdioHost(await fixture(context))
  context.after(() => host.close())
  const closing = host.close()
  assert.equal(host.close(), closing)
  await closing
  await assert.rejects(host.waitForTurn('turn'), /closed/)
  await assert.rejects(host.startThread(), /closed/)
})

test('turn waiting covers the complete default decision deadline and completion buffer', { timeout: 5000 }, async context => {
  const host = await startStdioHost(await fixture(context))
  context.after(() => host.close())
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const waiting = host.waitForTurn('turn')
  const rejection = assert.rejects(waiting, /Turn deadline elapsed/).then(() => { settled = true })
  context.mock.timers.tick(300_001)
  await Promise.resolve()
  assert.equal(settled, false)
  context.mock.timers.tick(119_999)
  await rejection
  context.mock.timers.reset()
  await host.close()
})

test('shutdown is reserved before reentrant disposal notifications', { timeout: 5000 }, async context => {
  const options = await fixture(context)
  let decisionCreated
  const created = new Promise(resolve => { decisionCreated = resolve })
  let host
  let reentrantShutdown
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') return Response.json({ decisionId: 'd1', type: 'confirm', status: 'pending', answered: false })
    if (options.method === 'DELETE') return Response.json({ decisionId: 'd1', cancelled: true })
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  })
  host = await startStdioHost({ ...options, adapterConfig: { ...adapterConfig, onEvent: event => {
    if (event.type === 'decision_created') decisionCreated()
    if (event.type === 'request_abandoned') reentrantShutdown = host.close()
  } } })
  context.after(() => host.close())
  await host.startThread()
  await host.startTurn('thread', 'Ask for approval')
  await created
  const shutdown = host.close()
  assert.equal(reentrantShutdown, shutdown)
  await shutdown
})
