/**
 * Modal for sending a review back to the studio. Opens from Settings →
 * About → "Leave a review". Star rating + optional name + review text;
 * submits through Formspree (see `lib/reviews.ts` for the endpoint config).
 *
 * Reviews don't auto-publish to the marketing site — they email the studio
 * inbox, where the best ones get hand-picked into the public Reactions
 * wall. Keeps the wall curated and the spam surface tiny.
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Send, Star, X } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import { useDialog } from '../../lib/useDialog'
import { isReviewFormReady, submitReview } from '../../lib/reviews'
import { cn } from '../../lib/utils'

const FIELD =
  'w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[12px] text-slate-100 outline-none transition focus:border-[var(--accent-ring)] placeholder:text-slate-600'

const COMMENT_MAX = 600

export function ReviewDialog(): JSX.Element {
  const open = useUiStore((s) => s.reviewDialogOpen)
  const setOpen = useUiStore((s) => s.setReviewDialogOpen)
  const pushToast = useUiStore((s) => s.pushToast)
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [name, setName] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialog(dialogRef, () => setOpen(false))

  // Reset the form every time the dialog opens so a previous draft can't
  // leak in if the user closes and reopens. We don't bother preserving
  // half-typed reviews — they're short, and stale state confuses people.
  useEffect(() => {
    if (open) {
      setRating(0)
      setHover(0)
      setName('')
      setComment('')
      setBusy(false)
    }
  }, [open])

  const close = (): void => setOpen(false)

  const submit = async (): Promise<void> => {
    if (busy || rating === 0 || !comment.trim()) return
    setBusy(true)
    try {
      await submitReview({ rating, name, comment })
      pushToast('success', 'Thanks — your review landed in the studio inbox.')
      close()
    } catch (err) {
      pushToast(
        'error',
        `Couldn't send review — ${err instanceof Error ? err.message : 'unknown error'}`
      )
      setBusy(false)
    }
  }

  // Hover-or-click rating: hovering a star previews the rating (so the
  // user sees their pick at a glance), clicking commits it. Familiar
  // pattern — matches App Store / Steam / every-review-system.
  const displayed = hover || rating

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[55] flex items-center justify-center bg-black/65 p-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Leave a review"
            className="glass w-full max-w-[360px] overflow-hidden rounded-2xl shadow-panel"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <Star size={15} className="text-[var(--accent)]" />
              <h2 className="flex-1 font-display text-[13px] font-semibold text-white">
                Leave a review
              </h2>
              <button
                type="button"
                onClick={close}
                className="text-slate-500 transition hover:text-slate-200"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>

            <div className="space-y-3 p-4">
              {!isReviewFormReady() ? (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                  Review submissions aren&apos;t configured yet — please update VoidSoul and
                  try again, or report feedback via the GitHub issues link in About.
                </p>
              ) : (
                <>
                  <div>
                    <label className="mb-1.5 block text-[9px] uppercase tracking-wider text-slate-500">
                      Rating
                    </label>
                    <div
                      className="flex gap-1"
                      role="radiogroup"
                      aria-label="Rating from 1 to 5 stars"
                      onMouseLeave={() => setHover(0)}
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          role="radio"
                          aria-checked={rating === n}
                          aria-label={`${n} star${n === 1 ? '' : 's'}`}
                          onClick={() => setRating(n)}
                          onMouseEnter={() => setHover(n)}
                          className="rounded-md p-1 transition hover:scale-110 active:scale-95"
                        >
                          <Star
                            size={26}
                            className={cn(
                              'transition-colors',
                              n <= displayed
                                ? 'fill-amber-400 text-amber-400'
                                : 'text-slate-600'
                            )}
                          />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-[9px] uppercase tracking-wider text-slate-500">
                      Name <span className="text-slate-600">(optional)</span>
                    </label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={60}
                      placeholder="Leave blank to stay anonymous"
                      className={FIELD}
                    />
                  </div>

                  <div>
                    <label className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-slate-500">
                      <span>Review</span>
                      <span className={cn(comment.length > COMMENT_MAX - 50 && 'text-amber-400')}>
                        {comment.length}/{COMMENT_MAX}
                      </span>
                    </label>
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
                      onKeyDown={(e) => {
                        // Cmd/Ctrl+Enter submits without forcing the user to mouse
                        // over to the button — keyboard-first reviewers will appreciate it.
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          void submit()
                        }
                      }}
                      rows={4}
                      placeholder="What's working, what's not, what would you change?"
                      className={cn(FIELD, 'resize-none')}
                    />
                  </div>

                  <p className="text-[10px] leading-relaxed text-slate-500">
                    Reviews are sent privately to the studio. The best ones get hand-picked
                    onto the public Reactions wall on voidsoul.app.
                  </p>
                </>
              )}
            </div>

            <div className="flex gap-2 border-t border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={close}
                className="flex-1 rounded-lg border border-white/10 py-2 text-[11px] font-medium text-slate-300 transition hover:bg-white/5"
              >
                Cancel
              </button>
              {isReviewFormReady() && (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy || rating === 0 || !comment.trim()}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] py-2 text-[11px] font-semibold text-white transition hover:brightness-110 disabled:opacity-40"
                >
                  <Send size={12} />
                  {busy ? 'Sending…' : 'Send review'}
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
