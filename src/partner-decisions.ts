import { PusharyApiError, type DecisionType } from '@pushary/server'
import { isRecord, isText } from './protocol'

export interface DecisionSnapshot {
  readonly decisionId: string
  readonly status: 'pending' | 'answered' | 'expired' | 'cancelled' | 'stopped'
  readonly answered: boolean
  readonly value: string | null
  readonly type: DecisionType
}
export const decisionSnapshot = (value: unknown, type: DecisionType, expectedId?: string): DecisionSnapshot => {
  if (!isRecord(value) || !isText(value.decisionId) || (expectedId !== undefined && value.decisionId !== expectedId) || value.type !== type || typeof value.answered !== 'boolean') throw new Error('Invalid decision response')
  const status = value.status
  if (status !== 'pending' && status !== 'answered' && status !== 'expired' && status !== 'cancelled' && status !== 'stopped') throw new Error('Unknown decision status')
  if ((status === 'answered') !== value.answered || (status === 'answered' && typeof value.value !== 'string') || (status !== 'answered' && value.value != null)) throw new Error('Inconsistent decision response')
  return { decisionId: value.decisionId, status, answered: value.answered, value: typeof value.value === 'string' ? value.value : null, type }
}
export const isRetryable = (error: unknown): boolean => error instanceof PusharyApiError ? error.status === 429 || error.status >= 500 : error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')
export const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return }
  const onAbort = (): void => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
  signal.addEventListener('abort', onAbort, { once: true })
})
export const withRetry = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted()
    try { return await operation() } catch (error) {
      if (signal.aborted || attempt >= 3 || !isRetryable(error)) throw error
      await delay(250 * 2 ** attempt + Math.floor(Math.random() * 101), signal)
    }
  }
}

export const decisionFailureReason = (error: unknown): string => {
  if (error instanceof PusharyApiError) return `Partner HTTP ${error.status}`
  if (error instanceof TypeError) return 'Decision transport unavailable'
  if (error instanceof Error && error.name === 'TimeoutError') return 'Decision HTTP deadline elapsed'
  return 'Decision response invalid or unavailable'
}
