import {
  createStore,
  clear as idbClear,
  del as idbDelete,
  get as idbGet,
  set as idbSet,
  type UseStore,
} from 'idb-keyval'

import type { OfflineStorage } from './types'

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value
  }

  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as T
}

export class MemoryOfflineStorage implements OfflineStorage {
  private readonly data = new Map<string, unknown>()

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key)
    return value === undefined ? undefined : cloneValue(value as T)
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, cloneValue(value))
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }

  clear(): void {
    this.data.clear()
  }
}

export class IndexedDbOfflineStorage implements OfflineStorage {
  private readonly store: UseStore

  constructor(
    databaseName = 'contour-offline',
    storeName = 'offline-state-v1',
  ) {
    this.store = createStore(databaseName, storeName)
  }

  async get<T>(key: string): Promise<T | undefined> {
    return idbGet<T>(key, this.store)
  }

  async set<T>(key: string, value: T): Promise<void> {
    await idbSet(key, value, this.store)
  }

  async delete(key: string): Promise<void> {
    await idbDelete(key, this.store)
  }
}

export function createDefaultOfflineStorage(): OfflineStorage {
  if (typeof indexedDB === 'undefined') {
    return new MemoryOfflineStorage()
  }

  return new IndexedDbOfflineStorage()
}

export async function clearDefaultOfflineStorage(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await idbClear(createStore('contour-offline', 'offline-state-v1'))
}
