# @pushary/codex-app-server

Route live Codex app-server command and file approvals to an enrolled Pushary Partner customer. The host keeps control of Codex authentication, process lifetime, native UI, and response delivery. This MIT package uses only the public `@pushary/server` SDK.

Experimental release: pinned to **Codex 0.160.1**, Node 22/24, and **@pushary/server >=2.3.0**. See [compatibility and verification](COMPATIBILITY.md).

[Connect a test customer](https://pushary.com/sign-up?from=agent&plan=partner&utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-codex-app-server&utm_content=partner-start) · [Partner setup guide](https://pushary.com/docs/agents/build/quickstart?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-codex-app-server&utm_content=guide)

Live delivery requires a Pushary Partner workspace and an enrolled customer. The compatibility limits above still apply.

## Install and enroll

```sh
npm install @pushary/codex-app-server
```

Install Codex separately if your host launches it. The adapter never installs or starts a Codex process automatically.

```ts
import { connect, createPusharyCodexHandler } from '@pushary/codex-app-server'

const enrollment = await connect({
  apiKey: partnerBackendKey,
}, authenticatedCustomerId)
```

Use a full-access Partner backend key for enrollment and issuing customer-bound keys. Agent and customer-bound keys cannot enroll users.

Show the returned enrollment link inside your authenticated customer flow. The customer must enroll before receiving decisions. `externalId` comes from your authenticated tenant/customer mapping, never from model output. Keep the Partner key on your host; do not put it into the agent's environment or workspace. Each handler belongs to one tenant, customer and live connection. A full-access key requires your host to enforce tenant isolation; a customer-bound key also enforces the recipient at the API boundary.

## Attach to your transport

```ts
const approvals = createPusharyCodexHandler({
  apiKey: partnerApiKey,
  tenantId: authenticatedTenantId,
  externalId: authenticatedCustomerId,
  codexVersion: '0.160.1',
  agentName: 'My coding assistant',
  maySendSubject: subject => customerPrivacyPolicy.allows(subject),
  sendResponse: reply => connection.enqueue(reply),
  requestTurnInterrupt: (threadId, turnId) => {
    connection.enqueueRequest('turn/interrupt', { threadId, turnId })
  },
  onEvent: event => audit.write(event),
})

approvals.registerThread(threadStartOrResumeResult)

function onServerMessage(message: unknown) {
  const dispatch = approvals.handle(message)
  if (dispatch.kind === 'unhandled') nativeReviewOrRefuse(message)
  if (dispatch.kind === 'invalid') closeConnection()
}

const { cleanupFailures } = await approvals.dispose()
```

`handle` returns synchronously. Keep reading server messages while a person answers. `claimed` means this handler owns the reply; never open another answer surface for it. `unhandled` delegates the first delivery to native review; later copies of that RPC are suppressed as `claimed` so the host opens only one answer surface. `observed` is a notification. Route host RPC responses separately. `sendResponse` must synchronously accept a frame into a bounded FIFO without calling back into the handler; enqueue failure must throw. An asynchronous writer failure must close the connection and dispose the handler. An interrupt must enter the same queue before the question error response. Close on `reply_failed` or `capacity_exceeded` events.

Register the effective **result**, not the parameters you requested. Only `on-request`/`untrusted`, reviewer `user`, and `readOnly`/`workspaceWrite` sandboxes qualify. Do not change permissions in `turn/start`. Settings updates unregister the thread; obtain a fresh idle start/resume result before re-registering. Call `invalidateTurn` before stopping or replacing work; invalidation after acceptance enqueue requests interruption and reports an unknown execution outcome.

## Supported subjects

- Full command, working directory and reason. Only one-request `accept`, `decline` or `cancel` is emitted. Known optional exec-policy suggestions do not grant a standing rule. Network, remote environments, stdin, additional permissions and unknown decision options require native handling.
- Complete file patches cached from `item/started` and `item/fileChange/patchUpdated`. A changed patch invalidates an outstanding approval. Missing or ambiguous patches and `grantRoot` are refused. Every path, operation, rename and diff is presented; nothing is truncated.
- Optional `experimentalQuestions: true` accepts a bounded protocol subset: 1–3 blocking, nonsecret questions with `isOther:false`. **The built-in Codex 0.160.1 tool always sets `isOther:true`, so its questions need native UI.** The included headless host interrupts them. Synthetic protocol tests cover the smaller subset; they are not evidence of native phone-question support.

MCP elicitation, permissions, dynamic tools, account/auth callbacks and legacy v1 approvals remain host responsibilities. The [example host](examples/stdio-host.mjs) has explicit fail-closed fallbacks.

## Lifecycle and privacy

The default decision deadline is 300 seconds, configurable from 60 to 600 seconds. It includes create, polling and every question in a batch. Creates use frozen idempotency keys, `wait:false`, and `requireReachable:true`. The key binds the tenant, customer, random connection generation, thread, turn, item, typed RPC ID, callback ID, exact subject and question ordinal. Pending polls are not denials. API errors and malformed answers never grant permission.

`maySendSubject` is mandatory and runs before transmission. It receives a copy of the full subject; false or a thrown error leaves the request for native review. Commands and patches can contain secrets. Invisible characters are escaped visibly. Presentations exceeding 8,000 UTF-16 question units or 2,000 context units require native review. Avoid storing raw subjects in your audit log; adapter events contain IDs, digests and reason codes, not command/diff text.

Limits per connection: 8 pending requests, 32 registered threads, 128 cached patches/4 MiB, 4,096 combined request, turn and completed-item records. Overflow disposes the connection instead of evicting approval identity. Notification callbacks must be fast; thrown callback errors are logged without exception content.

An owned request moves from pending to accepted or closed exactly once. The transition is committed before abort, interruption, or delivery callbacks. Item/turn completion is tracked separately from the reply outcome; cleanup never reopens a request. Deadline refusals use the same transition as other refusals and recheck the context after callbacks.

Disposal immediately fences replies, aborts requests and attempts withdrawal of known pending decision IDs for at most five seconds. It is idempotent. A late create is withdrawn only while the cleanup budget remains. An unobservable create outcome or abrupt termination can leave a prompt until its TTL; this is reported explicitly. A late answer can never be reused by a new handler generation.

This package supports live sessions only. It does not provide restart recovery, webhook-driven replay, durable ownership, or exactly-once execution. Enqueueing `accept` is not proof of execution: record the later Codex item outcome separately.

## Develop and mirror

In the monorepo:

```sh
bun install --frozen-lockfile
bun run --cwd packages/server build
bun run --cwd packages/codex-app-server typecheck
bun run --cwd packages/codex-app-server test
node scripts/ci/check-package-artifact.mjs codex-app-server
```

The conformance suite launches the pinned binary with isolated temporary HOME/CODEX_HOME and a loopback mock Responses/Partner service. It uses no personal login, real model credentials or physical phone. Tests verify actual filesystem effects before and after command/file decisions. They need permission to bind localhost and run the child process.

`packages/codex-app-server` is the source of truth. `scripts/lib/mirrors.mjs` maps it to `Pushary/pushary-codex-app-server`, with managed standalone CI/lockfile and release tags, like the other adapters. Never copy private monorepo dependencies into the mirror.

SDK 2.3.0 is published and the standalone lock resolves its registry artifact. Physical-phone certification and recipient-isolation checks are recorded in [COMPATIBILITY.md](COMPATIBILITY.md). The provisioned public mirror follows this package, and the shared npm release workflow publishes version bumps. Scheduled protocol drift compares latest generated schemas with the certified fixtures; it never widens the runtime version automatically.
