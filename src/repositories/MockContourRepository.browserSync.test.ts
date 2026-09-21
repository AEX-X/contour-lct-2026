import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContourRepository } from './MockContourRepository'

const storageKey = 'contour:demo-state:v4'

describe('MockContourRepository browser synchronization', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('distinguishes local commits from external storage updates', async () => {
    const observingRepository = createMockContourRepository()
    const writingRepository = createMockContourRepository()
    const listener = vi.fn()
    const unsubscribe = observingRepository.subscribe(listener)

    await observingRepository.advanceDemoClock(1)

    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'local' }))
    listener.mockClear()

    await writingRepository.advanceDemoClock(1)
    const externalRevision = writingRepository.getSnapshot().revision
    const serializedState = window.localStorage.getItem(storageKey)
    window.dispatchEvent(new StorageEvent('storage', {
      key: storageKey,
      newValue: serializedState,
      storageArea: window.localStorage,
    }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      source: 'external',
      snapshot: expect.objectContaining({ revision: externalRevision }),
    }))

    unsubscribe()
  })
})
