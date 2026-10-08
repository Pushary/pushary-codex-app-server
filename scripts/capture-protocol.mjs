import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const cli = require.resolve('@openai/codex/bin/codex.js')
const scratch = mkdtempSync(join(tmpdir(), 'pushary-codex-schema-'))
const destination = resolve(process.argv[2] ?? 'test/fixtures/0.160.1')
const schemas = ['CommandExecutionRequestApprovalParams', 'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalParams', 'FileChangeRequestApprovalResponse', 'FileChangePatchUpdatedNotification', 'ToolRequestUserInputParams', 'ToolRequestUserInputResponse', 'ThreadStartResponse', 'McpServerElicitationRequestResponse', 'PermissionsRequestApprovalResponse', 'DynamicToolCallResponse']
try {
  const env = { PATH: process.env.PATH, HOME: scratch, CODEX_HOME: scratch, TMPDIR: scratch }
  const version = execFileSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' }).trim()
  const release = /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(version)?.[1]
  if (!release) throw new Error('Unrecognized Codex version')
  execFileSync(process.execPath, [cli, 'app-server', 'generate-json-schema', '--experimental', '--out', join(scratch, 'schemas')], { env, stdio: 'pipe' })
  mkdirSync(destination, { recursive: true })
  const hashes = {}
  for (const name of schemas) {
    const matches = readdirSync(join(scratch, 'schemas'), { recursive: true }).filter(path => path === name + '.json' || path.endsWith('/' + name + '.json'))
    if (matches.length !== 1) throw new Error('Ambiguous or missing schema: ' + name)
    const bytes = readFileSync(join(scratch, 'schemas', matches[0]))
    writeFileSync(join(destination, name + '.json'), bytes)
    hashes[name] = createHash('sha256').update(bytes).digest('hex')
  }
  writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ version, source: `https://github.com/openai/codex/tree/rust-v${release}`, license: 'Apache-2.0', hashes }, null, 2) + '\n')
} finally { rmSync(scratch, { recursive: true, force: true }) }
