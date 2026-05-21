/**
 * Markdown renderer for assistant messages. Three feature additions on top
 * of the base react-markdown + GFM:
 *
 *  - **Math** (KaTeX): `$inline$` and `$$display$$` render via remark-math
 *    + rehype-katex. KaTeX's CSS is imported once at module top — it's the
 *    only stylesheet needed for the fraction bars, integrals, etc.
 *  - **Mermaid diagrams**: fenced ```` ```mermaid ```` blocks render the
 *    diagram inline. Mermaid is ~3 MB so it's dynamic-imported only when
 *    the first diagram on the page actually mounts — text-only chats pay
 *    nothing.
 *  - **Syntax highlighting**: highlight.js (with auto-detect when no
 *    language tag is supplied) decorates fenced code blocks. Also dynamic-
 *    imported so a chat with zero code blocks stays light.
 *
 * Code blocks keep the existing copy + open-in-Canvas affordances; the
 * highlighter just colourises the rendered text. Links still route to the
 * system browser instead of navigating the Electron renderer.
 */
import {
  memo,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { Check, Copy, Maximize2 } from 'lucide-react'
import { useUiStore } from '../../store/useUiStore'
import 'katex/dist/katex.min.css'

/** Code blocks longer than this open the Canvas dialog when expanded. */
const CANVAS_LINE_THRESHOLD = 20

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as ReactElement<{ children?: ReactNode }>).props.children)
  }
  return ''
}

/* ----------------------------- mermaid --------------------------------- */

/**
 * Lazy-imported mermaid singleton. Initialising the library is expensive
 * (`mermaid.initialize` parses a stylesheet + boots a font cache), so we
 * keep one instance and reuse it across every diagram that lands.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default)
  }
  return mermaidPromise
}

/** Resolve the active theme for mermaid's initialise call. Read fresh each
 *  render so a light/dark flip mid-session shows up on the next diagram. */
function mermaidTheme(): 'default' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'default' : 'dark'
}

/**
 * Single shared MutationObserver across every mounted diagram — a thread
 * with 10 diagrams previously spawned 10 observers all firing on the same
 * `<html data-theme>` flip and triggering 10 sets of state updates. Now
 * subscribers register a callback into a Set and the observer fires each
 * one once per flip. Observer is created lazily on the first subscribe and
 * torn down when the last subscriber unmounts.
 */
const themeSubscribers = new Set<() => void>()
let sharedThemeObserver: MutationObserver | null = null

function subscribeToThemeChange(cb: () => void): () => void {
  themeSubscribers.add(cb)
  if (!sharedThemeObserver) {
    sharedThemeObserver = new MutationObserver(() => {
      for (const sub of themeSubscribers) sub()
    })
    sharedThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  }
  return () => {
    themeSubscribers.delete(cb)
    if (themeSubscribers.size === 0 && sharedThemeObserver) {
      sharedThemeObserver.disconnect()
      sharedThemeObserver = null
    }
  }
}

let mermaidDiagramSeq = 0

function MermaidDiagram({ source }: { source: string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = useRef(`mermaid-${++mermaidDiagramSeq}`).current
  // Re-render diagrams when the theme attribute on <html> flips. Mermaid's
  // `initialize` is idempotent; calling it before each `render` reseats
  // the theme without leaking parsers.
  const [themeNonce, setThemeNonce] = useState(0)
  useEffect(() => subscribeToThemeChange(() => setThemeNonce((n) => n + 1)), [])

  useEffect(() => {
    let cancelled = false
    void loadMermaid()
      .then((mermaid) => {
        // Reseat theme + security on every render so a flipped theme is
        // honoured. `initialize` merges into mermaid's internal config; the
        // call itself is cheap (no DOM work until render).
        mermaid.initialize({
          startOnLoad: false,
          theme: mermaidTheme(),
          securityLevel: 'strict'
        })
        return mermaid.render(id, source)
      })
      .then((result) => {
        if (!cancelled) setSvg(result.svg)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Diagram failed to render')
      })
    return () => {
      cancelled = true
    }
  }, [id, source, themeNonce])

  if (error) {
    return (
      <pre className="my-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-200">
        Mermaid error: {error}
      </pre>
    )
  }
  if (!svg) {
    return (
      <div className="my-1.5 rounded-lg border border-white/10 bg-black/30 p-3 text-[10px] text-slate-500">
        Rendering diagram…
      </div>
    )
  }
  return (
    <div
      className="mermaid"
      // mermaid sanitises its own input (securityLevel: 'strict') and the
      // SVG it returns is well-formed — safe to inject as-is.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/* ------------------------- syntax highlight ---------------------------- */

let hljsPromise: Promise<typeof import('highlight.js').default> | null = null

function loadHljs(): Promise<typeof import('highlight.js').default> {
  if (!hljsPromise) {
    hljsPromise = import('highlight.js').then((mod) => mod.default)
  }
  return hljsPromise
}

interface HighlightedProps {
  language: string
  text: string
}

/** Subset of languages tried when no fence tag is supplied. Hoisted to
 *  module scope so it isn't reallocated on every render. */
const AUTO_DETECT_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'bash',
  'json',
  'yaml',
  'css',
  'html'
] as const

/**
 * Memoised so a streaming assistant message — which re-renders its parent
 * `<Markdown>` once per token — doesn't re-run hljs on stable earlier code
 * blocks. The effect's [language, text] deps still drive a real refresh
 * when the streaming block's own text grows.
 */
const HighlightedCode = memo(function HighlightedCode({
  language,
  text
}: HighlightedProps): JSX.Element {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadHljs().then((hljs) => {
      if (cancelled) return
      try {
        if (language && hljs.getLanguage(language)) {
          setHtml(hljs.highlight(text, { language, ignoreIllegals: true }).value)
        } else {
          // No tag — let highlight.js guess. Cap the search subset so an
          // ambiguous snippet doesn't burn a quarter-second of CPU.
          setHtml(hljs.highlightAuto(text, [...AUTO_DETECT_LANGUAGES]).value)
        }
      } catch {
        setHtml(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [language, text])

  // Pre-load fall-back: render plain text until the highlighter resolves so
  // the user never sees an empty block.
  if (html === null) {
    return <code className="font-mono text-[11.5px] leading-relaxed text-slate-200">{text}</code>
  }
  return (
    <code
      className="hljs font-mono text-[11.5px] leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

/* ----------------------------- code block ------------------------------ */

function CodeBlock({ children }: { children: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const codeElement = children as ReactElement<{ className?: string; children?: ReactNode }>
  const language = (codeElement?.props?.className ?? '').replace('language-', '')
  const text = extractText(codeElement?.props?.children).replace(/\n$/, '')
  const lineCount = text.split('\n').length
  const expandable = lineCount > CANVAS_LINE_THRESHOLD

  // Mermaid diagrams take over the whole block — no copy chrome, no
  // expand button. Falls through to a normal code block when mermaid
  // itself fails to render (the diagram component renders its own error).
  if (language === 'mermaid') {
    return <MermaidDiagram source={text} />
  }

  const copy = (): void => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const openCanvas = (): void => {
    useUiStore.getState().setCanvas({ code: text, language: language || 'code' })
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-white/10 bg-black/40">
      <div className="flex items-center justify-between border-b border-white/10 px-2.5 py-1">
        <span className="text-[9px] uppercase tracking-wide text-slate-400">
          {language || 'code'}
          {expandable && (
            <span className="ml-1.5 text-slate-600">· {lineCount} lines</span>
          )}
        </span>
        <div className="flex items-center gap-2.5">
          {expandable && (
            <button
              type="button"
              onClick={openCanvas}
              title="Open in canvas"
              className="flex items-center gap-1 text-[9px] text-slate-400 transition hover:text-[var(--accent)]"
            >
              <Maximize2 size={11} />
              Expand
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 text-[9px] text-slate-400 transition hover:text-white"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre className="scrollbar-void overflow-x-auto p-2.5">
        <HighlightedCode language={language} text={text} />
      </pre>
    </div>
  )
}

export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              if (href) window.open(href, '_blank')
            }}
          >
            {children}
          </a>
        )
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
