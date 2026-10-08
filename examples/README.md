# Examples

`node examples/simulated-host.mjs` runs a synthetic Codex request through a local mock Partner HTTP service. It needs no credentials and does not execute a command or contact a phone.

`stdio-host.mjs` exports `startStdioHost` for a real, pinned Codex child process. Supply an explicit executable/CLI path, workspace, separate CODEX_HOME, and adapter configuration. Initialize that home with the intended model/provider configuration first. Only `OPENAI_API_KEY` or `CODEX_TEST_API_KEY` may be passed in `modelEnvironment`; the host does not inherit the Partner key or your personal Codex login. Never place the Partner credential in the workspace or Codex config.

```js
import { startStdioHost } from './stdio-host.mjs'

const host = await startStdioHost({
  executable: process.execPath,
  args: ['/absolute/path/to/@openai/codex/bin/codex.js'],
  cwd: '/absolute/path/to/customer-workspace',
  codexHome: '/absolute/path/to/isolated-codex-home',
  modelEnvironment: { OPENAI_API_KEY: modelApiKey },
  adapterConfig: {
    apiKey: partnerApiKey,
    tenantId: authenticatedTenantId,
    externalId: authenticatedCustomerId,
    codexVersion: '0.160.1',
    maySendSubject: subject => privacyPolicy.allows(subject),
    onEvent: event => audit.write(event),
  },
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void host.close() })
}
try {
  const { thread } = await host.startThread()
  const { turn } = await host.startTurn(thread.id, 'Inspect the repository.')
  const outcome = await host.waitForTurn(turn.id)
  console.log(outcome.status)
} finally {
  await host.close()
}
```

This is an opt-in live example: Codex/model usage and Partner decisions can be billed. The customer must already be enrolled (see `connect` in the package README). Each supported question in a batch creates a separate Partner decision. Reachability confirms an available delivery channel, not receipt by a person.

The host is intentionally small: stdio, bounded frames/FIFO/RPCs, fixed user-reviewed read-only start settings, no per-turn permission overrides, native refusal for unsupported requests, and bounded graceful child shutdown. It verifies the binary's initialization version. It does not provide interactive authentication, production audit storage, WebSocket reconnect, multi-tenant worker orchestration, or restart replay. Extend those host responsibilities before production use. SIGKILL may leave pending prompts until TTL expiry.

Run `npm run test:conformance` after a build to exercise real Codex command/file side effects against mock model and Partner services. The suite uses temporary files and cleans up its own child processes.
