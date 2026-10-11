import type { RuntimeTerminalCreate, RuntimeTerminalPresentation } from '../../shared/runtime-types'
import { createTerminalRevealWarning } from './orca-runtime-core'
import type { RuntimeNotifier } from './runtime-notifier-contract'

type RevealTerminalSession = NonNullable<RuntimeNotifier['revealTerminalSession']>

/** Reveals a background-created terminal in the renderer and reports the surface it landed on. */
export async function revealCreatedTerminal(args: {
  notifier: RuntimeNotifier | null
  presentation: RuntimeTerminalPresentation
  worktreeId: string
  handle: string
  ptyId: string
  reveal: Parameters<RevealTerminalSession>[1]
}): Promise<{ surface: RuntimeTerminalCreate['surface']; warning?: string }> {
  const { notifier, presentation, worktreeId, handle, ptyId } = args
  if (presentation === 'background') {
    return { surface: 'background' }
  }
  if (!notifier?.revealTerminalSession) {
    return { surface: 'background', warning: createTerminalRevealWarning(handle) }
  }
  try {
    await notifier.revealTerminalSession(worktreeId, args.reveal)
    return { surface: 'visible' }
  } catch (err) {
    console.warn(`[terminal-create] failed to create inactive tab for ${ptyId}:`, err)
    return { surface: 'background', warning: createTerminalRevealWarning(handle, err) }
  }
}
