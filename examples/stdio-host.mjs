import { spawn } from 'node:child_process'
import { createPusharyCodexHandler } from '@pushary/codex-app-server'

const MAX_FRAME_BYTES = 1024 * 1024
const MAX_QUEUED_BYTES = 4 * MAX_FRAME_BYTES
const TURN_COMPLETION_BUFFER_MS = 120_000
export const startStdioHost = async ({ executable, args = [], cwd, codexHome, modelEnvironment = {}, adapterConfig, onMessage = () => {} }) => {
  if (!codexHome || !cwd) throw new Error('An isolated Codex home and workspace are required')
  if (Object.keys(modelEnvironment).some(key => !['OPENAI_API_KEY', 'CODEX_TEST_API_KEY'].includes(key))) throw new Error('Only model credentials may enter the child environment')
  let child
  let childClosed = Promise.resolve()
  const turnTimeoutMs = (adapterConfig.timeoutMs ?? 300_000) + TURN_COMPLETION_BUFFER_MS
  let sequence = 0
  let closed = false
  let shutdown
  let inbound = Buffer.alloc(0)
  let queuedBytes = 0
  let blocked = false
  const queue = []
  const pending = new Map()
  const ownedThreads = new Set()
  const finishedTurns = new Map()
  const turnWaiters = new Map()
  const stop = () => {
    if (shutdown) return shutdown
    const completion = Promise.withResolvers()
    shutdown = completion.promise
    closed = true
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex connection closed')) }
    pending.clear()
    for (const waiter of turnWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Codex connection closed')) }
    turnWaiters.clear()
    queue.length = 0
    queuedBytes = 0
    void adapter.dispose().then(async () => {
      if (!child) return
      child.stdin?.destroy()
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      try { await childClosed } finally { clearTimeout(timer) }
    }).then(completion.resolve, completion.reject)
    return shutdown
  }
  const drain = () => {
    while (!blocked && queue.length && !closed) {
      const frame = queue.shift()
      queuedBytes -= Buffer.byteLength(frame)
      blocked = !child.stdin.write(frame)
    }
  }
  const enqueue = message => {
    if (closed) throw new Error('Codex connection closed')
    const frame = JSON.stringify(message) + '\n'
    const bytes = Buffer.byteLength(frame)
    if (bytes > MAX_FRAME_BYTES || queuedBytes + child.stdin.writableLength + bytes > MAX_QUEUED_BYTES) { void stop(); throw new Error('Codex transport capacity exceeded') }
    queue.push(frame); queuedBytes += bytes; drain()
  }
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Codex connection closed')); return }
    if (pending.size >= 128) { void stop(); reject(new Error('RPC capacity exceeded')); return }
    const id = `host:${++sequence}`
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex RPC deadline elapsed')); void stop() }, 30_000)
    pending.set(id, { resolve, reject, timer })
    try { enqueue({ id, method, params }) } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
  })
  const adapter = createPusharyCodexHandler({ ...adapterConfig, sendResponse: enqueue, requestTurnInterrupt: (threadId, turnId) => { void rpc('turn/interrupt', { threadId, turnId }).catch(() => stop()) }, onEvent: event => {
    if (event.type === 'reply_failed' || event.type === 'capacity_exceeded') void stop()
    adapterConfig.onEvent(event)
  } })
  const fallback = message => {
    const { id, method, params } = message
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return enqueue({ id, result: { decision: 'decline' } })
    if (method === 'item/permissions/requestApproval') return enqueue({ id, result: { permissions: {}, scope: 'turn' } })
    if (method === 'mcpServer/elicitation/request') return enqueue({ id, result: { action: 'cancel', content: null } })
    if (method === 'item/tool/call') return enqueue({ id, result: { contentItems: [], success: false } })
    if (method === 'item/tool/requestUserInput') {
      if (!params || !ownedThreads.has(params.threadId) || typeof params.turnId !== 'string') { void stop(); return }
      void rpc('turn/interrupt', { threadId: params.threadId, turnId: params.turnId }).catch(() => stop())
      return enqueue({ id, error: { code: -32000, message: 'Question requires native UI; turn interrupted' } })
    }
    if (method.startsWith('account/') || method.startsWith('auth/') || method === 'execCommandApproval' || method === 'applyPatchApproval') { void stop(); return }
    enqueue({ id, error: { code: -32601, message: 'Unsupported server request' } })
  }
  const dispatch = message => {
    if (closed) return
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid server frame')
    onMessage(message)
    if (message.method === undefined) {
      const request = pending.get(message.id)
      if (!request) throw new Error('Unmatched RPC response')
      clearTimeout(request.timer); pending.delete(message.id)
      if (message.error) request.reject(new Error('Codex RPC failed: ' + JSON.stringify(message.error)))
      else request.resolve(message.result)
      return
    }
    const result = adapter.handle(message)
    if (result.kind === 'invalid') { void stop(); return }
    if (message.method === 'turn/completed') {
      const turn = message.params?.turn
      if (turn?.id) {
        const waiter = turnWaiters.get(turn.id)
        if (waiter) { clearTimeout(waiter.timer); turnWaiters.delete(turn.id); waiter.resolve(turn) }
        else { if (finishedTurns.size >= 128) finishedTurns.delete(finishedTurns.keys().next().value); finishedTurns.set(turn.id, turn) }
      }
    }
    if (result.kind === 'unhandled' && message.id !== undefined) fallback(message)
  }
  try {
    adapterConfig.signal?.throwIfAborted()
    child = spawn(executable, [...args, 'app-server', '--stdio'], { cwd, env: { PATH: process.env.PATH, HOME: codexHome, CODEX_HOME: codexHome, TMPDIR: codexHome, ...modelEnvironment }, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) { await stop(); throw error }
  childClosed = new Promise(resolve => child.once('close', resolve))
  child.on('error', () => { void stop() })
  child.on('close', () => { void stop() })
  child.stdout?.on('data', chunk => {
    inbound = Buffer.concat([inbound, chunk])
    try {
      let newline
      while ((newline = inbound.indexOf(10)) !== -1) {
        if (newline > MAX_FRAME_BYTES) throw new Error('Codex frame too large')
        const line = inbound.subarray(0, newline).toString('utf8'); inbound = inbound.subarray(newline + 1)
        dispatch(JSON.parse(line))
      }
      if (inbound.length > MAX_FRAME_BYTES) throw new Error('Codex frame too large')
    } catch { void stop() }
  })
  child.stderr?.resume()
  child.stdin?.on('drain', () => { blocked = false; drain() })
  child.stdin?.on('error', () => { void stop() })
  const waitForTurn = turnId => {
    if (closed) return Promise.reject(new Error('Codex connection closed'))
    if (finishedTurns.has(turnId)) { const turn = finishedTurns.get(turnId); finishedTurns.delete(turnId); return Promise.resolve(turn) }
    if (turnWaiters.has(turnId)) return Promise.reject(new Error('Turn already has a waiter'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { turnWaiters.delete(turnId); reject(new Error('Turn deadline elapsed')); void stop() }, turnTimeoutMs)
      turnWaiters.set(turnId, { resolve, reject, timer })
    })
  }
  try {
    const initialized = await rpc('initialize', { clientInfo: { name: 'pushary_codex_host', version: '0.1.0' }, capabilities: { experimentalApi: adapterConfig.experimentalQuestions === true } })
    if (!initialized?.userAgent?.startsWith('pushary_codex_host/' + adapterConfig.codexVersion + ' ')) throw new Error('Unsupported Codex binary version')
    enqueue({ method: 'initialized' })
  } catch (error) { await stop(); throw error }
  return {
    adapter,
    close: stop,
    waitForTurn,
    startThread: async () => {
      const result = await rpc('thread/start', { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' })
      adapter.registerThread(result); ownedThreads.add(result.thread.id); return result
    },
    startTurn: (threadId, text, collaborationMode) => {
      if (!ownedThreads.has(threadId)) throw new Error('Thread not owned by this connection')
      return rpc('turn/start', { threadId, input: [{ type: 'text', text }], ...(collaborationMode ? { collaborationMode } : {}) })
    },
  }
}
