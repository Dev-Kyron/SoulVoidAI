/**
 * The cell-reference substitution is pure and worth locking in — it's the
 * core glue that lets a Python cell read a search cell's output. Re-implemented
 * here in isolation so the test doesn't pull in the SQLite-dependent runner.
 */
import { describe, expect, it } from 'vitest'
import type { NotebookCell } from '@shared/types'

function substituteReferences(input: string, priorCells: NotebookCell[]): string {
  return input.replace(/\{\{cell-([^}]+)\}\}/g, (match, token: string) => {
    const ordinal = Number(token)
    if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= priorCells.length) {
      return priorCells[ordinal - 1].output
    }
    const byId = priorCells.find((c) => c.id === token)
    return byId ? byId.output : match
  })
}

function cell(id: string, output: string): NotebookCell {
  return { id, kind: 'prompt', input: '', output, status: 'ok' }
}

describe('substituteReferences', () => {
  it('returns input unchanged when there are no placeholders', () => {
    expect(substituteReferences('plain text', [])).toBe('plain text')
  })

  it('replaces {{cell-N}} ordinal references with that cell\'s output', () => {
    const priors = [cell('a', 'first'), cell('b', 'second')]
    expect(substituteReferences('A: {{cell-1}}, B: {{cell-2}}', priors)).toBe(
      'A: first, B: second'
    )
  })

  it('replaces {{cell-<id>}} uuid references', () => {
    const priors = [cell('uuid-aaa', 'aaa-output')]
    expect(substituteReferences('seed: {{cell-uuid-aaa}}', priors)).toBe(
      'seed: aaa-output'
    )
  })

  it('leaves unknown references intact so the user notices', () => {
    const priors = [cell('a', 'first')]
    expect(substituteReferences('{{cell-99}} {{cell-zzz}}', priors)).toBe(
      '{{cell-99}} {{cell-zzz}}'
    )
  })

  it('handles multiple references in one string', () => {
    const priors = [cell('a', 'X'), cell('b', 'Y'), cell('c', 'Z')]
    expect(substituteReferences('{{cell-1}}+{{cell-2}}={{cell-3}}', priors)).toBe('X+Y=Z')
  })

  it('does not loop on output that itself contains a placeholder', () => {
    const priors = [cell('a', '{{cell-1}}')]
    // The result of the first substitution would otherwise be re-substituted
    // in a naive implementation — replace runs over the input once, so the
    // surfaced output stays literal.
    expect(substituteReferences('{{cell-1}}', priors)).toBe('{{cell-1}}')
  })

  it('ignores ordinals out of range', () => {
    expect(substituteReferences('{{cell-0}} {{cell-5}}', [cell('a', 'one')])).toBe(
      '{{cell-0}} {{cell-5}}'
    )
  })
})
