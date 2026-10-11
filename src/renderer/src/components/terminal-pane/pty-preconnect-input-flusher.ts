import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import type { PtyInputWriteQueue } from './pty-input-write-queue-contract'
import type { PtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'

/** Drains keys typed before a PTY attached into that PTY's input write queue. */
export function createPtyPreconnectInputFlusher(args: {
  buffer: PtyPreconnectInputBuffer | null
  inputWriteQueue: PtyInputWriteQueue
  isDestroyed: () => boolean
  isConnected: () => boolean
  getPtyId: () => string | null
  hasConnectionId: boolean
}): { drop: (reason: string) => void; flush: () => Promise<void> } {
  const { buffer, inputWriteQueue } = args
  const drop = (reason: string): void => {
    if (buffer?.hasPendingInput()) {
      console.warn(
        `[pty-transport] dropped keys typed while the terminal was connecting: ${reason}`
      )
    }
    buffer?.clear()
  }
  const flush = async (): Promise<void> => {
    if (!buffer?.isBuffering()) {
      return
    }
    const id = args.getPtyId()
    if (args.isDestroyed() || !args.isConnected() || !id) {
      // Why: a closed pane's keys have no owner; only a failed attach is worth reporting.
      if (args.isDestroyed()) {
        buffer.clear()
      } else {
        drop('the terminal did not attach')
      }
      return
    }
    await buffer.flush({
      isCurrent: () => !args.isDestroyed() && args.isConnected() && args.getPtyId() === id,
      sendInput: (data, inputKind) => inputWriteQueue.enqueue(id, data, inputKind),
      sendInputImmediate: (data) => inputWriteQueue.enqueueQueryReply(id, data),
      ...(args.hasConnectionId
        ? {}
        : {
            sendInputAccepted: (data: string, inputKind: TerminalInputKind) =>
              inputWriteQueue.enqueueAccepted(id, data, inputKind)
          })
    })
  }
  return { drop, flush }
}
