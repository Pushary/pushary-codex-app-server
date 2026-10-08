import type { CodexReviewSubject } from './types'
import type { DecisionType } from '@pushary/server'

export interface PhoneQuestion {
  readonly question: string
  readonly context: string
  readonly type: DecisionType
  readonly options?: readonly string[]
  readonly questionId?: string
}
export const visibleText = (text: string): string => text.replace(/\\/g, '\\\\').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => `\\u{${character.codePointAt(0)?.toString(16)}}`)
const bounded = (questions: readonly PhoneQuestion[]): readonly PhoneQuestion[] | null => questions.every(question => question.question.length <= 8000 && question.context.length <= 2000 && question.options?.some(option => option.length > 200) !== true) ? questions : null
export const presentSubject = (subject: CodexReviewSubject): readonly PhoneQuestion[] | null => {
  if (subject.kind === 'command') return bounded([{ type: 'confirm', question: `Approve this command once?\n\n${visibleText(subject.command)}\n\nWorking directory: ${visibleText(subject.cwd)}\nReason: ${visibleText(subject.reason ?? '(none)')}`, context: 'Codex command approval. This approval applies only to this request.' }])
  if (subject.kind === 'files') {
    const patches = subject.changes.map(change => `${change.operation}: ${visibleText(change.path)}${change.movePath === null ? '' : ` -> ${visibleText(change.movePath)}`}\n${visibleText(change.diff)}`).join('\n\n')
    return bounded([{ type: 'confirm', question: `Approve these exact file changes once?\n\n${patches}\n\nReason: ${visibleText(subject.reason ?? '(none)')}`, context: 'Codex file approval. Includes every file and the complete patch.' }])
  }
  return bounded(subject.questions.map(question => ({ questionId: question.id, type: question.options ? 'select' : 'input', question: `${visibleText(question.header)}\n${visibleText(question.question)}${question.options ? '\n\n' + question.options.map(option => `${visibleText(option.label)}: ${visibleText(option.description)}`).join('\n') : ''}`, options: question.options?.map(option => visibleText(option.label)), context: 'Answer this Codex question. This answer does not grant tool permissions.' })))
}
