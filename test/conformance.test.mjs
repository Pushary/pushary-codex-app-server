import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv'
import { startStdioHost } from '../examples/stdio-host.mjs'
const require = createRequire(import.meta.url)
const cli = require.resolve('@openai/codex/bin/codex.js')
const validators = new Map()
const schemaForMethod = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalParams',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalParams',
  'item/tool/requestUserInput': 'ToolRequestUserInputParams',
}
const validate = async (name, value) => {
  if (!validators.has(name)) validators.set(name, new Ajv({ strict: false, validateFormats: false }).compile(JSON.parse(await readFile(new URL(`./fixtures/0.160.1/${name}.json`, import.meta.url), 'utf8'))))
  const validator = validators.get(name)
  assert.ok(validator(value), JSON.stringify(validator.errors))
}
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
const toolResponse = (name, args) => sse([
  { type: 'response.created', response: { id: 'resp1' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'tool1', call_id: 'call1', name, arguments: JSON.stringify(args) } },
  { type: 'response.completed', response: { id: 'resp1', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
])
const finalResponse = sse([
  { type: 'response.created', response: { id: 'resp2' } },
  { type: 'response.output_item.done', item: { type: 'message', id: 'msg1', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  { type: 'response.completed', response: { id: 'resp2', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
])
const runScenario = async (kind, answer) => {
  const scratch = await mkdtemp(join(tmpdir(), 'pushary-codex-conformance-'))
  const home = join(scratch, 'home'); const cwd = join(scratch, 'workspace'); const target = join(cwd, 'proof.txt')
  await mkdir(home); await mkdir(cwd)
  let modelCalls = 0
  let cancellations = 0
  const messages = []; const decisions = []; const bodies = []; const events = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    if (request.url?.startsWith('/v1/responses')) {
      bodies.push(JSON.parse(body)); modelCalls += 1
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (modelCalls > 1) { response.end(finalResponse); return }
      if (kind === 'command') response.end(toolResponse('exec_command', { cmd: `printf proof > '${target}'`, sandbox_permissions: 'require_escalated', justification: 'Write the conformance proof file' }))
      else if (kind === 'file') response.end(toolResponse('exec_command', { cmd: `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${target}\n+proof\n*** End Patch\nPATCH` }))
      else response.end(toolResponse('request_user_input', { questions: [{ id: 'choice', header: 'Choose', question: 'Which option?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] }))
    } else if (request.method === 'POST' && request.url === '/decisions') {
      const decision = JSON.parse(body); decisions.push(decision)
      await assert.rejects(readFile(target))
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(answer === 'disconnect' ? { decisionId: `d${decisions.length}`, type: decision.type, status: 'pending', answered: false } : { decisionId: `d${decisions.length}`, type: decision.type, status: 'answered', answered: true, value: answer }))
    } else if (request.method === 'DELETE') { cancellations += 1; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ decisionId: 'd1', cancelled: true })) }
    else { response.writeHead(404); response.end() }
  })
  let host
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address(); assert.ok(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}`
    await writeFile(join(home, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "mock"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[model_providers.mock]\nname = "Mock"\nbase_url = "${baseUrl}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`)
    host = await startStdioHost({ executable: process.execPath, args: [cli], cwd, codexHome: home, adapterConfig: { apiKey: 'pk_test.secret', tenantId: 'tenant', externalId: 'customer', baseUrl, codexVersion: '0.160.1', experimentalQuestions: true, timeoutMs: 60_000, maySendSubject: () => answer !== 'privacy-refused', onEvent: event => { events.push(event); if (answer === 'disconnect' && event.type === 'decision_created') void host.close() } }, onMessage: message => messages.push(message) })
    const started = await host.startThread(); await validate('ThreadStartResponse', started)
    assert.equal(started.approvalsReviewer, 'user'); assert.equal(started.approvalPolicy, 'on-request')
    const mode = kind === 'question' ? { mode: 'plan', settings: { model: 'gpt-5.4', reasoning_effort: 'medium', developer_instructions: null } } : undefined
    const turn = await host.startTurn(started.thread.id, 'Run the requested conformance tool.', mode)
    let completed
    if (answer === 'disconnect') {
      await assert.rejects(host.waitForTurn(turn.turn.id), /closed/)
      await host.close()
      assert.equal(cancellations, 1)
    } else completed = await host.waitForTurn(turn.turn.id)
    const requests = messages.filter(message => schemaForMethod[message.method])
    assert.equal(requests.length, 1, JSON.stringify({ messages: messages.filter(m => m.id !== undefined || m.method === "error"), events, modelCalls, tools: bodies[0]?.tools, outputs: bodies.flatMap(b => b.input).filter(i => i.type.endsWith('_output')) }))
    for (const request of requests) await validate(schemaForMethod[request.method], request.params)
    assert.equal(decisions.length, kind === 'question' || answer === 'privacy-refused' ? 0 : 1, JSON.stringify({ requests, events }))
    if (kind === 'question') {
      assert.equal(requests[0].params.questions[0].isOther, true)
      assert.equal(completed.status, 'interrupted')
    } else if (answer === 'yes') assert.match(await readFile(target, 'utf8'), /proof/)
    else await assert.rejects(readFile(target))
    return { started, requests, completed }
  } finally {
    await host?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(scratch, { recursive: true, force: true })
  }
}
for (const kind of ['command', 'file', 'question']) {
  for (const answer of kind === 'question' ? ['native-other-fallback'] : kind === 'command' ? ['yes', 'no', 'privacy-refused', 'disconnect'] : ['yes', 'no', 'disconnect']) {
    test(`pinned binary ${kind}: ${answer}`, { timeout: 45_000 }, () => runScenario(kind, answer))
  }
}
