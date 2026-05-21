/**
 * A collapsible Settings section. The header carries an accent tick, the
 * title and an optional hover hint; the body expands/collapses smoothly.
 * Sections start collapsed so Settings opens as a clean, scannable list.
 */
import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { SectionHint } from '../common/ui'
import { cn } from '../../lib/utils'

export function CollapsibleSection({
  title,
  hint,
  children,
  defaultOpen = false
}: {
  title: string
  hint?: string
  children: ReactNode
  defaultOpen?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="border-b border-white/5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-2.5"
      >
        <span className="h-3 w-[3px] shrink-0 rounded-full bg-[var(--accent)]" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-300">
          {title}
        </span>
        {hint && <SectionHint text={hint} />}
        <ChevronDown
          size={14}
          className={cn(
            'ml-auto text-slate-500 transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
