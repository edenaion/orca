import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  placeholderCells,
  PNG,
  render,
  TrackedBitmap,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('Kitty virtual placement lifecycle', () => {
  it('keeps alternate-buffer prototypes across ordinary image placement and releases them on exit', async () => {
    const h = createPlaceholderTerminal()
    try {
      await write(h.terminal, '\x1b[?1049h')
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, `${placeholderCells(7)}\r\n`)
      const virtual = h.bitmaps[0]
      await writeKitty(h.terminal, 'a=T,f=100,i=8', PNG)
      expect(render(h).filter((call) => call[0] === virtual)).toHaveLength(2)
      await write(h.terminal, '\x1b[?1049l')
      expect(h.storage._images.size).toBe(0)
      expect(h.kitty._virtualPlacements.size).toBe(0)
      expect(virtual.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  it('retransmitting an image ID releases all old virtual placements', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=p,U=1,i=7,p=11,c=1,r=1')
      const previous = [...h.bitmaps]
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=12,c=2,r=2', PNG)
      expect(h.storage._images.size).toBe(1)
      for (const bitmap of previous) {
        expect(bitmap.close).toHaveBeenCalledOnce()
      }
      await write(h.terminal, `${placeholderCells(7, 10)}\r\n${placeholderCells(7, 12)}`)
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it('can create a prototype from an encoded image after its physical bitmap is evicted', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,C=1', PNG)
      h.storage._pixelLimit = 200
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      expect(h.kitty.getImage(7)).toBeDefined()
      await writeKitty(h.terminal, 'a=p,U=1,i=7,c=2,r=2')
      await write(h.terminal, placeholderCells(7))
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it('deletes physical placements while preserving a prototype of the same image on d=A', async () => {
    const h = createPlaceholderTerminal()
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await writeKitty(h.terminal, 'a=p,i=7,C=1')
      expect(h.kitty.kittyIdToStorageId.size).toBe(1)
      await writeKitty(h.terminal, 'a=d,d=A,q=2')
      expect(h.kitty.kittyIdToStorageId.size).toBe(0)
      expect(h.storage._images.size).toBe(1)
      expect(h.bitmaps[1].close).toHaveBeenCalledOnce()
      await write(h.terminal, placeholderCells(7))
      expect(render(h)).toHaveLength(2)
    } finally {
      h.terminal.dispose()
    }
  })

  it.each(['reset', 'dispose'])('discards a virtual decode completing after %s', async (action) => {
    const h = createPlaceholderTerminal()
    try {
      let finishDecode
      h.addon._handlers.get('kitty')._createBitmap = () =>
        new Promise((resolve) => {
          finishDecode = resolve
        })
      const decoding = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await vi.waitFor(() => expect(finishDecode).toBeTypeOf('function'))
      h.addon[action]()
      const bitmap = new TrackedBitmap()
      finishDecode(bitmap)
      await decoding
      expect(h.storage._images.size).toBe(0)
      expect(h.kitty._virtualPlacements.size).toBe(0)
      expect(bitmap.close).toHaveBeenCalledOnce()
    } finally {
      h.terminal.dispose()
    }
  })

  describe('retransmitting an image ID under Unicode placeholders', () => {
    // Decodes complete only when the test releases them, in the order they were requested.
    function deferDecodes(h) {
      const pending = []
      h.addon._handlers.get('kitty')._createBitmap = () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject })
        })
      return pending
    }

    async function showFirstFrame(h) {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      expect(render(h)).toHaveLength(2)
      return h.bitmaps[0]
    }

    it('keeps drawing the old picture until the replacement is added, then swaps once', async () => {
      const h = createPlaceholderTerminal()
      try {
        const first = await showFirstFrame(h)
        const pending = deferDecodes(h)
        const sampled = []
        const add = h.kitty.addVirtualPlacement.bind(h.kitty)
        h.kitty.addVirtualPlacement = (...args) => {
          sampled.push(render(h).length)
          add(...args)
          sampled.push(render(h).length)
        }
        const second = new TrackedBitmap()
        const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
        await vi.waitFor(() => expect(pending).toHaveLength(1))
        expect(h.kitty.getImage(7)).toBeDefined()
        expect(render(h).map((call) => call[0])).toEqual([first, first])
        expect(first.close).not.toHaveBeenCalled()
        pending[0].resolve(second)
        await writing
        expect(sampled).toEqual([2, 2])
        expect(render(h).map((call) => call[0])).toEqual([second, second])
        expect(first.close).toHaveBeenCalledOnce()
        expect(second.close).not.toHaveBeenCalled()
        expect(h.storage._images.size).toBe(1)
        expect(h.kitty._virtualPlacements.get(7).size).toBe(1)
      } finally {
        h.terminal.dispose()
      }
    })

    it('removes the old picture when the replacement fails to decode', async () => {
      const h = createPlaceholderTerminal()
      try {
        const first = await showFirstFrame(h)
        const pending = deferDecodes(h)
        const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
        await vi.waitFor(() => expect(pending).toHaveLength(1))
        expect(render(h)).toHaveLength(2)
        pending[0].reject(new Error('decode failed'))
        await writing
        expect(render(h)).toHaveLength(0)
        expect(h.kitty._virtualPlacements.size).toBe(0)
        expect(h.storage._images.size).toBe(0)
        expect(first.close).toHaveBeenCalledOnce()
        expect([...h.storage.getHiddenGlyphColumns(0)]).toEqual([0, 1])
      } finally {
        h.terminal.dispose()
      }
    })

    it('keeps the old picture when a newer command supersedes the decode', async () => {
      const h = createPlaceholderTerminal()
      try {
        const first = await showFirstFrame(h)
        const pending = deferDecodes(h)
        const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
        await vi.waitFor(() => expect(pending).toHaveLength(1))
        h.addon._handlers.get('kitty')._generation++
        const stale = new TrackedBitmap()
        pending[0].resolve(stale)
        await writing
        expect(render(h).map((call) => call[0])).toEqual([first, first])
        expect(stale.close).toHaveBeenCalledOnce()
        expect(first.close).not.toHaveBeenCalled()
      } finally {
        h.terminal.dispose()
      }
    })

    it('stays resolvable while frames arrive faster than they decode and ends on the newest', async () => {
      const h = createPlaceholderTerminal()
      try {
        const first = await showFirstFrame(h)
        const pending = deferDecodes(h)
        const frames = [new TrackedBitmap(), new TrackedBitmap(), new TrackedBitmap()]
        const writes = frames.map(() => writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG))
        let shown = first
        for (const [index, frame] of frames.entries()) {
          await vi.waitFor(() => expect(pending).toHaveLength(index + 1))
          expect(render(h).map((call) => call[0])).toEqual([shown, shown])
          pending[index].resolve(frame)
          await writes[index]
          shown = frame
          expect(render(h).map((call) => call[0])).toEqual([shown, shown])
        }
        for (const bitmap of [first, ...frames.slice(0, -1)]) {
          expect(bitmap.close).toHaveBeenCalledOnce()
        }
        expect(frames[2].close).not.toHaveBeenCalled()
        expect(h.storage._images.size).toBe(1)
      } finally {
        h.terminal.dispose()
      }
    })

    it('drops placements with other placement IDs once the replacement is added', async () => {
      const h = createPlaceholderTerminal()
      try {
        await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=10,c=2,r=2', PNG)
        await writeKitty(h.terminal, 'a=p,U=1,i=7,p=11,c=1,r=1')
        const previous = [...h.bitmaps]
        const pending = deferDecodes(h)
        const writing = writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,p=12,c=2,r=2', PNG)
        await vi.waitFor(() => expect(pending).toHaveLength(1))
        expect(h.kitty._virtualPlacements.get(7).size).toBe(2)
        pending[0].resolve(new TrackedBitmap())
        await writing
        expect([...h.kitty._virtualPlacements.get(7).keys()]).toEqual([12])
        for (const bitmap of previous) {
          expect(bitmap.close).toHaveBeenCalledOnce()
        }
      } finally {
        h.terminal.dispose()
      }
    })

    it('still drops old placements on a plain transmit and leaves the cells blank until placed', async () => {
      const h = createPlaceholderTerminal()
      try {
        const first = await showFirstFrame(h)
        await writeKitty(h.terminal, 'a=t,f=100,i=7', PNG)
        expect(h.kitty._virtualPlacements.size).toBe(0)
        expect(first.close).toHaveBeenCalledOnce()
        expect([...h.storage.getHiddenGlyphColumns(0)]).toEqual([0, 1])
        await writeKitty(h.terminal, 'a=p,U=1,i=7,c=2,r=2')
        expect(render(h)).toHaveLength(2)
      } finally {
        h.terminal.dispose()
      }
    })
  })
})
