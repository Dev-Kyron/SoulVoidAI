/**
 * Resolves the icon names referenced by quick-action and plugin definitions to
 * concrete Lucide components.
 */
import {
  Box,
  Camera,
  Clapperboard,
  Code,
  Cpu,
  FileText,
  Folder,
  FolderCog,
  Gamepad2,
  Github,
  Globe,
  Image,
  MessageCircle,
  Music,
  Palette,
  Rocket,
  Settings,
  Sparkles,
  Star,
  Terminal,
  Video,
  Wrench,
  Zap,
  type LucideIcon
} from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  Box,
  Camera,
  Clapperboard,
  Code,
  Cpu,
  FileText,
  Folder,
  FolderCog,
  Gamepad2,
  Github,
  Globe,
  Image,
  MessageCircle,
  Music,
  Palette,
  Rocket,
  Settings,
  Sparkles,
  Star,
  Terminal,
  Video,
  Wrench,
  Zap
}

export function resolveIcon(name: string): LucideIcon {
  return ICONS[name] ?? Sparkles
}
