import type { CurrentUser, RepositoryErrorCode } from '../domain'
import type { StorageLike } from '../repositories'

const OFFLINE_SESSION_KEY = 'contour.offline.engineer-session.v1'
const OFFLINE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface OfflineSessionEnvelope {
  schemaVersion: 1
  cachedAt: string
  user: CurrentUser
}

export function shouldAttemptOfflineEngineerRestore(input: {
  runtimeMode: 'mock' | 'api'
  errorCode: RepositoryErrorCode
  browserIsOffline: boolean
  hasContractErrors?: boolean
}): boolean {
  return input.runtimeMode === 'api' && (
    (input.errorCode === 'SOURCE_UNAVAILABLE' && !input.hasContractErrors) ||
    (input.browserIsOffline && input.errorCode === 'AUTH_REQUIRED')
  )
}

function browserLocalStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    const probe = '__contour_offline_session_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}

function isOfflineEngineer(value: unknown): value is CurrentUser {
  if (!value || typeof value !== 'object') return false
  const user = value as Partial<CurrentUser>
  return user.role === 'engineer' &&
    typeof user.id === 'string' &&
    typeof user.displayName === 'string' &&
    user.homeRoute === '/my-work' &&
    Array.isArray(user.permissions) &&
    user.permissions.every((permission) => typeof permission === 'string') &&
    Boolean(user.scope && user.scope.type === 'work_order_grants') &&
    Array.isArray(user.scope?.facilityIds) &&
    Boolean(user.organization && typeof user.organization.id === 'string') &&
    Array.isArray(user.activeAccessGrants)
}

export function cacheOfflineEngineerSession(
  user: CurrentUser,
  options: { storage?: StorageLike | null; now?: Date } = {},
): void {
  const storage = options.storage === undefined ? browserLocalStorage() : options.storage
  if (!storage) return
  if (user.role !== 'engineer') {
    storage.removeItem(OFFLINE_SESSION_KEY)
    return
  }
  const envelope: OfflineSessionEnvelope = {
    schemaVersion: 1,
    cachedAt: (options.now ?? new Date()).toISOString(),
    user,
  }
  storage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(envelope))
}

export function readOfflineEngineerSession(
  options: { storage?: StorageLike | null; now?: Date } = {},
): CurrentUser | null {
  const storage = options.storage === undefined ? browserLocalStorage() : options.storage
  if (!storage) return null
  const raw = storage.getItem(OFFLINE_SESSION_KEY)
  if (!raw) return null
  try {
    const envelope = JSON.parse(raw) as Partial<OfflineSessionEnvelope>
    const cachedAt = Date.parse(envelope.cachedAt ?? '')
    const now = (options.now ?? new Date()).getTime()
    if (
      envelope.schemaVersion !== 1 ||
      !Number.isFinite(cachedAt) ||
      cachedAt > now + 5 * 60 * 1000 ||
      now - cachedAt > OFFLINE_SESSION_MAX_AGE_MS ||
      !isOfflineEngineer(envelope.user)
    ) {
      storage.removeItem(OFFLINE_SESSION_KEY)
      return null
    }
    return envelope.user
  } catch {
    storage.removeItem(OFFLINE_SESSION_KEY)
    return null
  }
}

export function clearOfflineEngineerSession(storage: StorageLike | null = browserLocalStorage()): void {
  storage?.removeItem(OFFLINE_SESSION_KEY)
}
