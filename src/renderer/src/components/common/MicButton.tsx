/**
 * Voice-input button. Tap to record, tap again to stop and transcribe. Pulses
 * while recording and spins while transcribing.
 */
import { motion } from 'framer-motion'
import { Mic, Square, Loader2 } from 'lucide-react'
import { useVoiceInputStore } from '../../store/useVoiceInputStore'
import { cn } from '../../lib/utils'

export function MicButton({ className }: { className?: string }): JSX.Element {
  const status = useVoiceInputStore((s) => s.status)
  const toggle = useVoiceInputStore((s) => s.toggle)
  const recording = status === 'recording'
  const transcribing = status === 'transcribing'

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={transcribing}
      title={recording ? 'Stop and transcribe' : 'Voice input — speak to VoidSoul'}
      aria-label={
        transcribing
          ? 'Transcribing speech'
          : recording
            ? 'Stop voice input and transcribe'
            : 'Start voice input'
      }
      aria-pressed={recording}
      className={cn(
        'relative flex items-center justify-center rounded-lg transition',
        recording
          ? 'bg-rose-500/80 text-white'
          : 'text-slate-400 hover:bg-white/10 hover:text-white',
        transcribing && 'opacity-60',
        className
      )}
    >
      {recording && (
        <motion.span
          className="absolute inset-0 rounded-lg ring-2 ring-rose-400"
          animate={{ opacity: [0.7, 0, 0.7] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      {transcribing ? (
        <Loader2 size={16} className="animate-spin" />
      ) : recording ? (
        <Square size={13} className="fill-current" />
      ) : (
        <Mic size={16} />
      )}
    </button>
  )
}
