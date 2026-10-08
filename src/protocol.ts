import type { CodexQuestion, CodexRequestId, CodexReviewSubject, FileChange, RequestIdentity } from './types'

export const COMMAND = 'item/commandExecution/requestApproval'
export const FILES = 'item/fileChange/requestApproval'
export const QUESTIONS = 'item/tool/requestUserInput'
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isId = (value: unknown): value is CodexRequestId => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value))
export const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const optionalText = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string'
export const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key))
export const identityOf = (id: CodexRequestId, method: string, params: Record<string, unknown>): RequestIdentity | null => {
  if (!isText(params.threadId) || !isText(params.turnId) || !isText(params.itemId) || !optionalText(params.approvalId)) return null
  return { id, method, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalId: typeof params.approvalId === 'string' ? params.approvalId : null }
}
export const certifiedThread = (value: unknown): string | null => {
  if (!isRecord(value) || !isRecord(value.thread) || !isText(value.thread.id) || !isRecord(value.thread.status) || value.thread.status.type !== 'idle') return null
  if ((value.approvalPolicy !== 'untrusted' && value.approvalPolicy !== 'on-request') || value.approvalsReviewer !== 'user' || !isRecord(value.sandbox)) return null
  const sandbox = value.sandbox
  if (sandbox.type !== 'readOnly' && sandbox.type !== 'workspaceWrite') return null
  if (!onlyKeys(sandbox, ['type', 'networkAccess', 'writableRoots', 'excludeSlashTmp', 'excludeTmpdirEnvVar'])) return null
  if (sandbox.networkAccess !== undefined && typeof sandbox.networkAccess !== 'boolean') return null
  if (sandbox.writableRoots !== undefined && (!Array.isArray(sandbox.writableRoots) || !sandbox.writableRoots.every(isText))) return null
  if (['excludeSlashTmp', 'excludeTmpdirEnvVar'].some(key => sandbox[key] !== undefined && typeof sandbox[key] !== 'boolean')) return null
  if (value.activePermissionProfile !== undefined && value.activePermissionProfile !== null) return null
  return value.thread.id
}
export const fileChangesOf = (value: unknown): readonly FileChange[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return null
  const changes: FileChange[] = []
  for (const change of value) {
    if (!isRecord(change) || !onlyKeys(change, ['path', 'kind', 'diff']) || !isText(change.path) || typeof change.diff !== 'string' || !isRecord(change.kind)) return null
    const kind = change.kind
    if (!onlyKeys(kind, ['type', 'move_path']) || (kind.type !== 'add' && kind.type !== 'delete' && kind.type !== 'update')) return null
    if (!optionalText(kind.move_path) || (kind.type !== 'update' && kind.move_path != null)) return null
    changes.push({ path: change.path, operation: kind.type, movePath: typeof kind.move_path === 'string' ? kind.move_path : null, diff: change.diff })
  }
  return changes
}
type SubjectResult = { readonly kind: 'supported'; readonly subject: CodexReviewSubject } | { readonly kind: 'unsupported'; readonly reason: string } | { readonly kind: 'malformed'; readonly reason: string }
const unsupported = (reason: string): SubjectResult => ({ kind: 'unsupported', reason })
const malformed = (reason: string): SubjectResult => ({ kind: 'malformed', reason })
const isKnownCommandDecision = (value: unknown): boolean => {
  if (typeof value === 'string') return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)
  if (!isRecord(value) || !onlyKeys(value, ['acceptWithExecpolicyAmendment'])) return false
  const amendment = value.acceptWithExecpolicyAmendment
  return isRecord(amendment) && onlyKeys(amendment, ['execpolicy_amendment']) && Array.isArray(amendment.execpolicy_amendment) && amendment.execpolicy_amendment.every(isText)
}
export const subjectOf = (method: string, params: Record<string, unknown>, changes: readonly FileChange[] | null, experimental: boolean): SubjectResult => {
  if (method === COMMAND) {
    if (!onlyKeys(params, ['threadId', 'turnId', 'itemId', 'approvalId', 'startedAtMs', 'kind', 'environmentId', 'command', 'cwd', 'reason', 'commandActions', 'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'availableDecisions'])) return unsupported('Unknown command permission fields')
    if ((params.kind !== undefined && params.kind !== 'command') || (params.environmentId != null && params.environmentId !== 'local') || params.networkApprovalContext != null || params.proposedNetworkPolicyAmendments != null) return unsupported('Command needs native permission review')
    if (params.proposedExecpolicyAmendment != null && (!Array.isArray(params.proposedExecpolicyAmendment) || !params.proposedExecpolicyAmendment.every(isText))) return malformed('Invalid policy suggestion')
    if (params.availableDecisions != null && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes('accept') || !params.availableDecisions.every(isKnownCommandDecision))) return unsupported('Unknown available approval decisions')
    if (!isText(params.command) || !isText(params.cwd) || !optionalText(params.reason) || !Number.isSafeInteger(params.startedAtMs)) return malformed('Incomplete command subject')
    return { kind: 'supported', subject: { kind: 'command', command: params.command, cwd: params.cwd, reason: typeof params.reason === 'string' ? params.reason : null } }
  }
  if (method === FILES) {
    if (!onlyKeys(params, ['threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot']) || params.grantRoot != null) return unsupported('File request widens permissions')
    if (!optionalText(params.reason) || !Number.isSafeInteger(params.startedAtMs)) return malformed('Malformed file request')
    if (!changes) return unsupported('Complete file patch unavailable')
    return { kind: 'supported', subject: { kind: 'files', changes, reason: typeof params.reason === 'string' ? params.reason : null } }
  }
  if (!experimental) return unsupported('Experimental questions disabled')
  if (!onlyKeys(params, ['threadId', 'turnId', 'itemId', 'questions', 'isBlocking', 'autoResolutionMs']) || params.isBlocking !== true || params.autoResolutionMs != null) return unsupported('Question requires native handling')
  if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 3) return malformed('Question count outside supported range')
  const questions: CodexQuestion[] = []
  for (const question of params.questions) {
    if (!isRecord(question) || !onlyKeys(question, ['id', 'header', 'question', 'isOther', 'isSecret', 'options'])) return malformed('Malformed question')
    if (question.isOther !== false || question.isSecret !== false) return unsupported('Secret or other-option question')
    if (!isText(question.id) || !isText(question.header) || !isText(question.question) || questions.some(entry => entry.id === question.id)) return malformed('Invalid question identity')
    let options: CodexQuestion['options'] = null
    if (question.options !== null) {
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 20) return malformed('Invalid options')
      const validated: { label: string; description: string }[] = []
      for (const option of question.options) {
        if (!isRecord(option) || !onlyKeys(option, ['label', 'description']) || !isText(option.label) || option.label.length > 200 || typeof option.description !== 'string' || validated.some(entry => entry.label === option.label)) return malformed('Invalid option')
        validated.push({ label: option.label, description: option.description })
      }
      options = validated
    }
    questions.push({ id: question.id, header: question.header, question: question.question, options })
  }
  return { kind: 'supported', subject: { kind: 'questions', questions } }
}
