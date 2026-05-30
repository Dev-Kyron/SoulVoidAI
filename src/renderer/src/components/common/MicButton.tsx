/**
 * Voice-input button. Tap to record, tap again to stop and transcribe. Pulses
 * while recording and spins while transcribing.
 */
import { motion } from 'framer-motion'
import { Mic, Square, Loader2 } from 'lucide-react'
import { useVoiceInputStore } from '../../store/useVoiceInputStore'
import { useConversationStore } from '../../store/useConversationStore'
import { cn } from '../../lib/utils'

export function MicButton({ className }: { className?: string }): JSX.Element {
  const status = useVoiceInputStore((s) => s.status)
  const toggle = useVoiceInputStore((s) => s.toggle)
  // v2.0 polish — the conversational voice mode owns the mic stream
  // exclusively while a session is active. Disabling the single-shot
  // MicButton in that window prevents a second `getUserMedia` call from
  // racing with the conversation controller's recorder; same gate the
  // wake-word path uses for the same reason.
  const conversationActive = useConversationStore((s) => s.status !== 'idle')
  const recording = status === 'recording'
  const transcribing = status === 'transcribing'
  const disabled = transcribing || conversationActive

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={disabled}
      title={
        conversationActive
          ? 'Disabled — conversation mode is using the mic'
          : recording
            ? 'Stop and transcribe'
            : 'Voice input — speak to VoidSoul'
      }
      aria-label={
        conversationActive
          ? 'Mic disabled while conversation mode is active'
          : transcribing
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
        (transcribing || conversationActive) && 'opacity-60',
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
