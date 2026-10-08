# Compatibility evidence

Status: experimental 0.1.0 release; certified only for Codex 0.160.1.

| Boundary | Evidence |
| --- | --- |
| Codex | npm `@openai/codex@0.160.1`; generated schemas and SHA-256 provenance under `test/fixtures/0.160.1` |
| Transport | newline JSON over stdio; 1 MiB frame cap, bounded FIFO, separate host RPC IDs |
| Thread policy | real initialize/start response; user reviewer and read-only sandbox |
| Command | real `exec_command` request, accept/deny, absent side effect before approval, file written only after accept |
| File | real patch interception through `exec_command`, full cached patch approval, accept/deny filesystem evidence |
| Questions | real built-in tool adds `isOther:true`; native fallback interrupts the turn. Restricted `isOther:false` subset tested with synthetic protocol messages only |
| Partner | production Partner service and an enrolled physical iPhone; command approve/deny/expiry, full patch approval, privacy refusal and customer-bound recipient enforcement |
| Runtime | Node 22 on macOS and Debian Linux verified from standalone installs; Node 24 on macOS and Ubuntu also verified |
| Packaging | ESM/CJS packed-consumer smoke with published SDK 2.3.0; standalone lock includes registry URL and integrity |

Regenerate the schemas with `npm run capture:protocol`. They include experimental fields because the supported live messages advertise `availableDecisions`; omitting `--experimental` hides that field from generated schema output. The adapter still refuses unrecognized permission-bearing fields.

A local command uses `environmentId:"local"` and may offer an exec-policy amendment. These are validated; the adapter can answer only the request itself. It never returns `acceptForSession` or any amendment. If the menu omits `decline`, a negative phone answer uses `cancel`.

The mock Responses service scripts the model's tool call but does not replace Codex: Codex validates the tool, requests approval, waits, executes/refuses the action, and emits the turn outcome. This proves the local protocol/execution seam, not mobile delivery or provider behavior. Linux sandbox behavior is checked by the monorepo release-candidate job and must be green before release.

Registry installation is a post-publication check. Local packed-consumer tests do not prove that the npm upload succeeded.

## Local verification, 2026-10-07

On Node 24.3.0/macOS: 106 adapter unit/race tests, 8 real-binary scenarios, 7 host lifecycle tests,
105 SDK tests, 33 Claude adapter regressions, and 20 OpenAI Agents adapter/hosted
regressions passed. The monorepo typecheck passed all 21 tasks. The mandatory
commit gate passed all checks. Packed ESM/CJS imports and the standalone mirror
build/tests/simulated example passed using the locally packed SDK candidate.

The initial sandboxed gate could not bind its localhost fixture; the full gate
was rerun with localhost access and passed. No test used personal Codex config,
a production Partner credential, or a real model endpoint.

## Standalone verification, 2026-10-08

The standalone lock now resolves published SDK 2.3.0 with its npm registry URL
and integrity. A clean install on Node 22.23.3/macOS passed typecheck, all 106
unit/race tests and all 15 pinned-binary/host lifecycle checks. The packed
adapter passed ESM/CJS consumer smoke with the registry SDK on Node 22.

A fresh standalone install in the official `node:22-bookworm` Linux container
also passed typecheck, all 106 unit/race tests and all 15 pinned-binary/host
checks with the registry SDK. Its temporary workspace was isolated from host
configuration and the container was removed after completion.

The [Ubuntu/Node 24 release-candidate job](https://github.com/aadilghani1/pushary/actions/runs/37647923638/job/112883426512)
passed the same 106 unit/race tests and 15 pinned-binary/host checks on October 7.
Its adapter source, tests, examples and package manifest match this revision.
The job built and packed the candidate without publishing it.

The mirror repository and npm package still returned 404 during this check.
No public repository, npm package, or trusted publisher was created, and the
release and provisioning remain blocked pending certification.


## Physical-phone certification, 2026-10-08

A dedicated Partner test customer was enrolled on a physical iPhone. The real
Codex 0.160.1 binary ran with isolated temporary configuration and workspace,
a scripted loopback Responses service and the production Partner API.

- Phone approval resumed the waiting command and wrote exactly the expected file.
- Phone denial interrupted the turn and wrote no file.
- An unanswered decision expired, interrupted the turn and wrote no file.
- A complete file patch reached the phone and approval applied its exact Unicode
  contents. The customer confirmed all beginning/end markers and lines were visible.
- Privacy refusal created no Partner decision and executed nothing.
- A customer-bound key overrode a different requested external ID; the resulting
  decision belonged to the enrolled customer. Enrollment, key issuance and submitting
  a customer answer with that key each returned HTTP 403.

No command or patch executed before an answer. A mistakenly approved denial test
executed as approved; it was repeated with a denial and passed. This verifies the
answer received, not an inferred user intention. One initial unanswered approval
attempt expired without execution and was then repeated successfully.

Known presentation limitation: patch newlines display as literal `\u{a}` text.
All contents are present, but multiline review is less readable. The display fix
is deferred; this release preserves the certified presentation. Native Codex
questions, restart recovery and exactly-once execution remain unsupported as
specified above. No real model-provider behavior was certified by this fixture.
