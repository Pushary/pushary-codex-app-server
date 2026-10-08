import { expect, it } from 'vitest'
import { decisionSnapshot } from '../src/partner-decisions'
import { visibleText, presentSubject } from '../src/presentation'
import { certifiedThread, fileChangesOf, isId } from '../src/protocol'
it.each([NaN, Infinity, 1.5, {}, null, undefined, true, Number.MAX_SAFE_INTEGER + 1])('rejects non-RPC ids %s', value => expect(isId(value)).toBe(false))
it.each(['pending', 'answered', 'expired', 'cancelled', 'stopped'])('validates %s status consistency', status => {
  const response = { decisionId: 'id', type: 'confirm', status, answered: status === 'answered', value: status === 'answered' ? 'no' : null }
  expect(decisionSnapshot(response, 'confirm').status).toBe(status)
  expect(() => decisionSnapshot({ ...response, answered: !response.answered }, 'confirm')).toThrow()
})
it.each([null, {}, { decisionId: 'id', type: 'select', status: 'answered', answered: true, value: 'yes' }, { decisionId: 'id', type: 'confirm', status: 'unknown', answered: false }])('rejects malformed API responses %j', value => expect(() => decisionSnapshot(value, 'confirm')).toThrow())
it('escapes invisible characters without collapsing literal escape text', () => {
  expect(visibleText('\u202e')).not.toBe(visibleText('\\u{202e}'))
  expect(visibleText('a\nb')).toBe('a\\u{a}b')
})
it('refuses an oversized full patch instead of truncating', () => expect(presentSubject({ kind: 'files', reason: null, changes: [{ path: '/a', operation: 'add', movePath: null, diff: 'x'.repeat(8000) }] })).toBeNull())
it.each([[], [{}], [{ path: '/a', kind: { type: 'move' }, diff: 'x' }], [{ path: '/a', kind: { type: 'add' }, diff: 123 }]])('rejects incomplete file patches %j', value => expect(fileChangesOf(value)).toBeNull())
it('preserves a rename and complete diff', () => expect(fileChangesOf([{ path: '/a', kind: { type: 'update', move_path: '/b' }, diff: '-old\n+new' }])).toEqual([{ path: '/a', operation: 'update', movePath: '/b', diff: '-old\n+new' }]))
it.each([{ type: ['delete'] }, { type: { toString: () => 'delete' } }, { type: null }])('rejects the whole patch when one operation has the wrong type: %j', kind => {
  const valid = { path: '/reviewed', kind: { type: 'add' }, diff: '+reviewed' }
  const invalid = { path: '/omitted', kind, diff: '-omitted' }
  expect(fileChangesOf([valid, invalid])).toBeNull()
  expect(fileChangesOf([invalid, valid])).toBeNull()
})
it.each([{ policy: ['on-request'] }, { policy: { toString: () => 'untrusted' } }, { policy: null }])('rejects coerced approval policies: %j', ({ policy }) => {
  expect(certifiedThread({ thread: { id: 't', status: { type: 'idle' } }, approvalPolicy: policy, approvalsReviewer: 'user', sandbox: { type: 'readOnly' } })).toBeNull()
})
it('refuses unknown permission profiles', () => expect(certifiedThread({ thread: { id: 't', status: { type: 'idle' } }, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, activePermissionProfile: { type: 'newProfile' } })).toBeNull())
