import { describe, expect, it } from 'vitest'

import type { CurrentUser } from '../domain'
import { createMemoryStorage } from '../repositories'
import {
  cacheOfflineEngineerSession,
  clearOfflineEngineerSession,
  readOfflineEngineerSession,
  shouldAttemptOfflineEngineerRestore,
} from './sessionCache'

const engineer: CurrentUser = {
  id: 'usr-engineer',
  displayName: 'Инженер',
  role: 'engineer',
  organizationId: 'org-maintenance',
  organization: {
    id: 'org-maintenance',
    displayName: 'Ремонтная служба',
    type: 'maintenance_provider',
  },
  permissions: ['work_order.read', 'offline_package.download'],
  scope: { type: 'work_order_grants', operationalUnitIds: [], facilityIds: [] },
  homeRoute: '/my-work',
  timezone: 'Europe/Moscow',
  locale: 'ru-RU',
  activeAccessGrants: [],
}

describe('offline engineer session cache', () => {
  it('restores a valid engineer identity and clears it explicitly', () => {
    const storage = createMemoryStorage()
    const now = new Date('2026-09-28T12:00:00Z')
    cacheOfflineEngineerSession(engineer, { storage, now })

    expect(readOfflineEngineerSession({ storage, now })).toEqual(engineer)
    clearOfflineEngineerSession(storage)
    expect(readOfflineEngineerSession({ storage, now })).toBeNull()
  })

  it('rejects expired and corrupted cached identities', () => {
    const storage = createMemoryStorage()
    cacheOfflineEngineerSession(engineer, {
      storage,
      now: new Date('2026-09-01T00:00:00Z'),
    })
    expect(readOfflineEngineerSession({
      storage,
      now: new Date('2026-09-28T00:00:00Z'),
    })).toBeNull()

    storage.setItem('contour.offline.engineer-session.v1', '{broken')
    expect(readOfflineEngineerSession({ storage })).toBeNull()
  })

  it('restores a tokenless identity only for an actually offline API launch', () => {
    expect(shouldAttemptOfflineEngineerRestore({
      runtimeMode: 'api',
      errorCode: 'AUTH_REQUIRED',
      browserIsOffline: true,
    })).toBe(true)
    expect(shouldAttemptOfflineEngineerRestore({
      runtimeMode: 'api',
      errorCode: 'AUTH_REQUIRED',
      browserIsOffline: false,
    })).toBe(false)
    expect(shouldAttemptOfflineEngineerRestore({
      runtimeMode: 'api',
      errorCode: 'SOURCE_UNAVAILABLE',
      browserIsOffline: false,
    })).toBe(true)
    expect(shouldAttemptOfflineEngineerRestore({
      runtimeMode: 'api',
      errorCode: 'SOURCE_UNAVAILABLE',
      browserIsOffline: true,
      hasContractErrors: true,
    })).toBe(false)
    expect(shouldAttemptOfflineEngineerRestore({
      runtimeMode: 'mock',
      errorCode: 'SOURCE_UNAVAILABLE',
      browserIsOffline: true,
    })).toBe(false)
  })
})
