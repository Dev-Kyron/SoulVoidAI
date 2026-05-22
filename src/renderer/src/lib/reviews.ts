/**
 * In-app review submission → Formspree.
 *
 * Reviews don't land directly on the marketing site — they're emailed to
 * the studio inbox via Formspree, and the user hand-picks the best ones
 * into the site's `REVIEWS` array. Keeps the public Reactions wall
 * curated, blocks spam, and avoids a backend.
 *
 * --------------------------- SETUP --------------------------------
 * 1. Sign in to Formspree (same account as the launch waitlist) and
 *    create a new form named "VoidSoul Reviews". Set the notification
 *    email to your inbox.
 * 2. Copy the form endpoint URL — it looks like
 *      https://formspree.io/f/xyzabc123
 * 3. Paste it into REVIEW_FORM_ENDPOINT below.
 * 4. Mirror the same URL into web/lib/forms.ts so future site code
 *    knows where reviews flow (currently unused there, but keeps the
 *    constants discoverable for whoever audits the form config next).
 * ------------------------------------------------------------------
 */
import { vs } from './bridge'

/** Formspree endpoint for the "VoidSoul Reviews" form. */
export const REVIEW_FORM_ENDPOINT = 'https://formspree.io/f/xlgvnlaa'

/** True once a real endpoint URL has been pasted in. */
export function isReviewFormReady(): boolean {
  return (
    REVIEW_FORM_ENDPOINT.startsWith('https://formspree.io/f/') &&
    !REVIEW_FORM_ENDPOINT.includes('REPLACE_WITH')
  )
}

export interface ReviewPayload {
  /** 1-5. */
  rating: number
  /** Free-text body. */
  comment: string
  /** Optional display name. Empty string = anonymous. */
  name: string
}

/**
 * Submit a review. Auto-attaches the app version, Electron version, and
 * platform so emails carry enough context to debug version-specific
 * complaints without us having to ask the reviewer to look it up.
 *
 * Throws on network / endpoint errors so the caller can show a useful
 * toast. The dialog has its own offline guard before this is called.
 */
export async function submitReview(payload: ReviewPayload): Promise<void> {
  if (!isReviewFormReady()) {
    throw new Error('Review submissions are not configured yet — try again after the next update.')
  }

  const info = await vs.system.info().catch(() => null)
  const stars = '★'.repeat(payload.rating) + '☆'.repeat(5 - payload.rating)

  const body = {
    // Formspree picks up well-named fields and shows them prominently in
    // the email — `_subject` becomes the email subject line.
    _subject: `VoidSoul review — ${stars} (${payload.rating}/5)`,
    rating: payload.rating,
    rating_stars: stars,
    name: payload.name.trim() || 'Anonymous beta tester',
    comment: payload.comment.trim(),
    app_version: info?.version ?? 'unknown',
    electron_version: info?.electron ?? 'unknown',
    platform: info?.platform ?? 'unknown'
  }

  const response = await fetch(REVIEW_FORM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    // Formspree returns JSON errors with a `errors[].message` array on
    // validation/billing problems — surface the first one if we can read
    // it, otherwise fall back to the status code.
    let detail = `${response.status} ${response.statusText}`
    try {
      const json = (await response.json()) as { errors?: Array<{ message: string }> }
      if (json.errors?.[0]?.message) detail = json.errors[0].message
    } catch {
      /* response wasn't JSON — keep the status-line fallback */
    }
    throw new Error(detail)
  }
}
