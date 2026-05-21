/**
 * Cross-window-safe controlled input. Wraps the classic "local draft +
 * external sync only when not editing" pattern so a config broadcast from
 * the panel window can't snap a Settings-window text/time input back to a
 * stale value while the user is mid-type. The user's edit always wins
 * during an active session — broadcast-derived values only re-seed the
 * draft when the field is idle (no pending edit + not currently dirty).
 *
 * Two commit triggers:
 *   - debounced (default 350 ms) — for sliders / time inputs that fire
 *     onChange constantly
 *   - explicit blur — flushes the current draft synchronously so a quick
 *     edit-then-click-away doesn't lose the change
 *
 * Returns a stable triple `{ value, onChange, onBlur }` ready to spread on
 * an `<input>` / `<textarea>`. Pass the source-of-truth value from config
 * and a `commit` callback that persists it. The hook handles everything in
 * between.
 *
 * **What about lost cross-window edits?** If user A types "foo" in window A
 * while user B mutates the same field in window B, A's commit will win
 * (last-writer-wins). The alternative — snapping A's input back mid-type —
 * is worse UX. Setting fields aren't collaborative documents; users don't
 * expect operational-transform semantics here.
 */
import { useEffect, useRef, useState } from 'react'

interface UseDraftFieldOptions<T> {
  /** Source-of-truth value coming from config / store. */
  source: T
  /** Persists the new value. Called from onBlur and from the debounce timer. */
  commit: (next: T) => void | Promise<void>
  /** Debounce delay before auto-commit. Default 350 ms. */
  debounceMs?: number
}

export interface DraftField<T> {
  value: T
  onChange: (next: T) => void
  onBlur: () => void
}

export function useDraftField<T>(opts: UseDraftFieldOptions<T>): DraftField<T> {
  const [draft, setDraft] = useState<T>(opts.source)
  // `dirty` tracks "the user has typed something we haven't committed yet".
  // Held in a ref so the external-sync effect can read the latest value
  // without re-subscribing (a setState would loop the effect).
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirror the draft in a ref so onBlur and the unmount-flush cleanup can
  // read the LATEST value rather than the one captured at first render.
  // Without this, an unmount flush would commit the initial value.
  const draftRef = useRef(draft)
  draftRef.current = draft
  // Capture the latest commit fn in a ref so the unmount-flush effect
  // doesn't re-bind on every render of the parent.
  const commitRef = useRef(opts.commit)
  commitRef.current = opts.commit

  // External sync — only re-seed the draft from source when NOT dirty.
  // This is the entire point of the hook: stop broadcast updates from
  // overwriting in-progress edits.
  useEffect(() => {
    if (!dirtyRef.current) setDraft(opts.source)
  }, [opts.source])

  const flush = (value: T): void => {
    dirtyRef.current = false
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    void commitRef.current(value)
  }

  const onChange = (next: T): void => {
    dirtyRef.current = true
    setDraft(next)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => flush(next), opts.debounceMs ?? 350)
  }

  const onBlur = (): void => {
    if (dirtyRef.current) flush(draftRef.current)
  }

  // Flush on unmount so a navigate-away doesn't lose a pending edit. Reads
  // the latest draft via the ref so the commit isn't stale.
  useEffect(() => {
    return (): void => {
      if (dirtyRef.current) flush(draftRef.current)
    }
    // Intentionally fires only on unmount; refs read inside survive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { value: draft, onChange, onBlur }
}
