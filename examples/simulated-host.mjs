import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { createPusharyCodexHandler } from '@pushary/codex-app-server'
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  const decision = JSON.parse(body)
  assert.equal(decision.externalId, 'simulated-customer')
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ decisionId: 'simulated-decision', status: 'answered', answered: true, value: 'yes', type: 'confirm' }))
})
let handler
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local server address')
  let resolveReply
  const reply = new Promise(resolve => { resolveReply = resolve })
  handler = createPusharyCodexHandler({ apiKey: 'pk_simulated.secret', tenantId: 'simulated-tenant', externalId: 'simulated-customer', baseUrl: `http://127.0.0.1:${address.port}`, codexVersion: '0.160.1', maySendSubject: () => true, onEvent: event => console.log(event.type), sendResponse: resolveReply, requestTurnInterrupt: () => {} })
  handler.registerThread({ thread: { id: 'simulated-thread', status: { type: 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } })
  handler.handle({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'simulated-thread', turnId: 'simulated-turn', itemId: 'simulated-item', command: 'echo simulated', cwd: '/tmp', startedAtMs: Date.now() } })
  assert.deepEqual(await reply, { id: 1, result: { decision: 'accept' } })
  console.log('Simulated approval passed; no command was executed and no phone was contacted.')
} finally { await handler?.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
