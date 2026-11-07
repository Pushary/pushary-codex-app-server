# Changelog

## 0.2.0

Certified for Codex 0.167.0 as well as 0.160.1; `codexVersion` accepts either, and
`CERTIFIED_CODEX_VERSIONS` lists them. Codex 0.167.0 adds a `humanCommand` approval
kind for managed checkpoints, which Codex sends only to hosts that declare the
`requiredHumanApproval` capability; the adapter leaves it to Codex's own review, as it
does any kind it doesn't know. The thread start response changed only in turn and item
definitions the adapter doesn't read. The 8 real-binary scenarios and 7 host lifecycle
checks pass against the 0.167.0 binary.

## 0.1.0

Experimental Partner approval adapter for live Codex app-server 0.160.1 sessions.
Supports single-request command and complete file-patch approvals, with bounded
deadlines, cancellation, privacy filtering, and native fallback for unsupported
requests. Includes a stdio host, isolated real-binary conformance tests, generated
protocol fixtures, and standalone mirror CI. Certified against the production Partner service with an enrolled physical phone
for command approval, denial and expiry, full patch approval and recipient-bound
key enforcement. Patch line breaks remain visibly escaped in this release.
