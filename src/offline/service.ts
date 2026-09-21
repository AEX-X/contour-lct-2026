import { createDefaultOfflineStorage } from './storage'
import {
  OFFLINE_SCHEMA_VERSION,
  type EnqueueOfflineMutationInput,
  type OfflineMutation,
  type OfflineMutationFilter,
  type OfflineMutationStatus,
  type OfflineSnapshot,
  type OfflineStorage,
  type OfflineSyncOptions,
  type OfflineSyncResult,
  type OfflineSyncSummary,
  type OfflineSyncTransport,
  type OfflineWorkPackage,
  type PrepareOfflinePackageInput,
  type RequeueMutationPatch,
} from './types'

const DEFAULT_STORAGE_KEY = 'contour:offline:snapshot:v3'
const SYNC_LEASE_MS = 2 * 60 * 1000
const sharedOperationTails = new Map<string, Promise<void>>()

const MUTATION_STATUSES: readonly OfflineMutationStatus[] = [
  'pending',
  'syncing',
  'synced',
  'conflict',
  'access_expired',
  'failed',
]

function createEmptySnapshot(): OfflineSnapshot {
  return {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    nextSequence: 1,
    packages: {},
    mutations: {},
    idempotencyIndex: {},
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined) {
    return value
  }

  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as T
}

function defaultCreateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function compareMutations(
  left: OfflineMutation,
  right: OfflineMutation,
): number {
  return (
    left.sequence - right.sequence ||
    left.mutationId.localeCompare(right.mutationId)
  )
}

function countStatuses(
  mutations: readonly OfflineMutation[],
): Record<OfflineMutationStatus, number> {
  const counts = Object.fromEntries(
    MUTATION_STATUSES.map((status) => [status, 0]),
  ) as Record<OfflineMutationStatus, number>

  for (const mutation of mutations) {
    counts[mutation.status] += 1
  }

  return counts
}

function isExpired(isoDate: string, now: Date): boolean {
  const timestamp = Date.parse(isoDate)
  return !Number.isFinite(timestamp) || timestamp <= now.getTime()
}

function isSyncClaimExpired(mutation: OfflineMutation, now: Date): boolean {
  return (
    mutation.status === 'syncing' &&
    (!mutation.syncLeaseExpiresAt || isExpired(mutation.syncLeaseExpiresAt, now))
  )
}

export interface OfflineServiceOptions {
  storage?: OfflineStorage
  storageKey?: string
  now?: () => Date
  createId?: () => string
}

export class OfflineEngineerService {
  private readonly storage: OfflineStorage
  private readonly storageKey: string
  private readonly now: () => Date
  private readonly createId: () => string

  constructor(options: OfflineServiceOptions = {}) {
    this.storage = options.storage ?? createDefaultOfflineStorage()
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? defaultCreateId
  }

  async initialize(): Promise<void> {
    await this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      let changed = false
      const now = this.now()
      const recoveredAt = now.toISOString()

      for (const workPackage of Object.values(snapshot.packages)) {
        if (isExpired(workPackage.accessExpiresAt, now)) {
          this.revokePackageAccess(
            snapshot,
            workPackage.workOrderId,
            recoveredAt,
          )
          changed = true
        }
      }

      for (const mutation of Object.values(snapshot.mutations)) {
        if (isSyncClaimExpired(mutation, now)) {
          mutation.status = 'pending'
          mutation.updatedAt = recoveredAt
          mutation.lastError = {
            code: 'SYNC_INTERRUPTED',
            message: 'Предыдущая синхронизация была прервана',
            retryable: true,
          }
          delete mutation.syncClaimId
          delete mutation.syncLeaseExpiresAt
          changed = true
        }
      }

      if (changed) {
        await this.writeSnapshot(snapshot)
      }
    })
  }

  async getDraft<TDraft>(workOrderId: string): Promise<TDraft | undefined> {
    return this.withLock(async () => {
      const draft = await this.storage.get<TDraft>(this.draftStorageKey(workOrderId))
      return draft === undefined ? undefined : cloneValue(draft)
    })
  }

  async saveDraft<TDraft>(workOrderId: string, draft: TDraft): Promise<void> {
    await this.withLock(async () => {
      await this.storage.set(this.draftStorageKey(workOrderId), cloneValue(draft))
    })
  }

  async removeDraft(workOrderId: string): Promise<void> {
    await this.withLock(async () => {
      await this.storage.delete(this.draftStorageKey(workOrderId))
    })
  }

  async preparePackage<TContext>(
    input: PrepareOfflinePackageInput<TContext>,
  ): Promise<OfflineWorkPackage<TContext>> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const preparedAt = input.preparedAt ?? this.now().toISOString()
      const workPackage: OfflineWorkPackage<TContext> = {
        schemaVersion: OFFLINE_SCHEMA_VERSION,
        packageId: input.packageId ?? this.createId(),
        workOrderId: input.workOrderId,
        engineerId: input.engineerId,
        grantId: input.grantId,
        expectedVersion: input.expectedVersion,
        preparedAt,
        accessExpiresAt: input.accessExpiresAt,
        context: cloneValue(input.context),
        ...(input.checksum ? { checksum: input.checksum } : {}),
      }

      snapshot.packages[input.workOrderId] = workPackage
      await this.writeSnapshot(snapshot)
      return cloneValue(workPackage)
    })
  }

  private draftStorageKey(workOrderId: string): string {
    return `${this.storageKey}:draft:${workOrderId}`
  }

  async getPackage<TContext = unknown>(
    workOrderId: string,
  ): Promise<OfflineWorkPackage<TContext> | undefined> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const workPackage = snapshot.packages[workOrderId]
      const now = this.now()
      if (
        workPackage &&
        isExpired(workPackage.accessExpiresAt, now)
      ) {
        this.revokePackageAccess(
          snapshot,
          workOrderId,
          now.toISOString(),
        )
        await this.writeSnapshot(snapshot)
        return undefined
      }

      return workPackage
        ? (cloneValue(workPackage) as OfflineWorkPackage<TContext>)
        : undefined
    })
  }

  async listPackages<TContext = unknown>(): Promise<
    OfflineWorkPackage<TContext>[]
  > {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const now = this.now()
      let changed = false

      for (const workPackage of Object.values(snapshot.packages)) {
        if (isExpired(workPackage.accessExpiresAt, now)) {
          this.revokePackageAccess(
            snapshot,
            workPackage.workOrderId,
            now.toISOString(),
          )
          changed = true
        }
      }

      if (changed) {
        await this.writeSnapshot(snapshot)
      }

      return Object.values(snapshot.packages)
        .sort(
          (left, right) =>
            Date.parse(left.preparedAt) - Date.parse(right.preparedAt) ||
            left.workOrderId.localeCompare(right.workOrderId),
        )
        .map((workPackage) =>
          cloneValue(workPackage as OfflineWorkPackage<TContext>),
        )
    })
  }

  async removePackage(workOrderId: string): Promise<boolean> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      if (!snapshot.packages[workOrderId]) {
        return false
      }

      this.revokePackageAccess(
        snapshot,
        workOrderId,
        this.now().toISOString(),
      )
      await this.writeSnapshot(snapshot)
      return true
    })
  }

  async enqueue<TPayload>(
    input: EnqueueOfflineMutationInput<TPayload>,
  ): Promise<OfflineMutation<TPayload>> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const duplicateId = snapshot.idempotencyIndex[input.idempotencyKey]

      if (duplicateId) {
        const duplicate = snapshot.mutations[duplicateId]
        if (duplicate) {
          const sameContext =
            duplicate.kind === input.kind &&
            duplicate.workOrderId === input.workOrderId &&
            duplicate.engineerId === input.engineerId &&
            duplicate.grantId === input.grantId &&
            duplicate.expectedVersion === input.expectedVersion &&
            JSON.stringify(duplicate.payload) === JSON.stringify(input.payload)
          if (!sameContext) {
            throw new Error('Offline idempotency key is already used for another mutation')
          }
          return cloneValue(duplicate as OfflineMutation<TPayload>)
        }
      }

      const createdAt = input.createdAt ?? this.now().toISOString()
      const workPackage = snapshot.packages[input.workOrderId]
      const accessExpired =
        !workPackage ||
        workPackage.grantId !== input.grantId ||
        isExpired(workPackage.accessExpiresAt, new Date(createdAt))

      const mutationId = input.mutationId ?? this.createId()
      if (snapshot.mutations[mutationId]) {
        throw new Error(`Offline mutation id already exists: ${mutationId}`)
      }

      const mutation: OfflineMutation<TPayload> = {
        mutationId,
        idempotencyKey: input.idempotencyKey,
        sequence: snapshot.nextSequence,
        kind: input.kind,
        workOrderId: input.workOrderId,
        engineerId: input.engineerId,
        grantId: input.grantId,
        expectedVersion: input.expectedVersion,
        payload: cloneValue(input.payload),
        status: accessExpired ? 'access_expired' : 'pending',
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        ...(accessExpired
          ? {
              lastError: {
                code: workPackage ? 'GRANT_EXPIRED' : 'PACKAGE_NOT_FOUND',
                message: workPackage
                  ? 'Временный доступ к заявке истёк'
                  : 'Офлайн-пакет для заявки не найден',
                retryable: false,
              },
            }
          : {}),
      }

      snapshot.nextSequence += 1
      snapshot.mutations[mutation.mutationId] = mutation
      snapshot.idempotencyIndex[mutation.idempotencyKey] = mutation.mutationId
      await this.writeSnapshot(snapshot)
      return cloneValue(mutation)
    })
  }

  async getMutation<TPayload = unknown>(
    mutationId: string,
  ): Promise<OfflineMutation<TPayload> | undefined> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const mutation = snapshot.mutations[mutationId]
      return mutation
        ? (cloneValue(mutation) as OfflineMutation<TPayload>)
        : undefined
    })
  }

  async listMutations<TPayload = unknown>(
    filter: OfflineMutationFilter = {},
  ): Promise<OfflineMutation<TPayload>[]> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const statuses = filter.statuses

      return Object.values(snapshot.mutations)
        .filter(
          (mutation) =>
            (!filter.workOrderId ||
              mutation.workOrderId === filter.workOrderId) &&
            (!statuses || statuses.includes(mutation.status)),
        )
        .sort(compareMutations)
        .map((mutation) => cloneValue(mutation as OfflineMutation<TPayload>))
    })
  }

  async requeue<TPayload>(
    mutationId: string,
    patch: RequeueMutationPatch<TPayload> = {},
  ): Promise<OfflineMutation<TPayload>> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const mutation = snapshot.mutations[mutationId]

      if (!mutation) {
        throw new Error(`Offline mutation not found: ${mutationId}`)
      }

      if (mutation.status === 'synced') {
        throw new Error('Synced mutation cannot be requeued')
      }

      const updatedAt = this.now().toISOString()
      if (patch.idempotencyKey && patch.idempotencyKey !== mutation.idempotencyKey) {
        const duplicateId = snapshot.idempotencyIndex[patch.idempotencyKey]
        if (duplicateId && duplicateId !== mutation.mutationId) {
          throw new Error('Offline idempotency key is already in use')
        }
        if (snapshot.idempotencyIndex[mutation.idempotencyKey] === mutation.mutationId) {
          delete snapshot.idempotencyIndex[mutation.idempotencyKey]
        }
        mutation.idempotencyKey = patch.idempotencyKey
        snapshot.idempotencyIndex[patch.idempotencyKey] = mutation.mutationId
      }
      mutation.status = 'pending'
      mutation.updatedAt = updatedAt
      mutation.payload = cloneValue(
        patch.payload === undefined ? mutation.payload : patch.payload,
      )
      mutation.expectedVersion =
        patch.expectedVersion ?? mutation.expectedVersion
      mutation.grantId = patch.grantId ?? mutation.grantId
      delete mutation.conflict
      delete mutation.lastError
      delete mutation.syncedAt
      delete mutation.remoteVersion
      delete mutation.receipt
      delete mutation.syncClaimId
      delete mutation.syncLeaseExpiresAt

      await this.writeSnapshot(snapshot)
      return cloneValue(mutation as OfflineMutation<TPayload>)
    })
  }

  async sync<TPayload = unknown, TContext = unknown, TServerState = unknown>(
    transport: OfflineSyncTransport<TPayload, TContext, TServerState>,
    options: OfflineSyncOptions = {},
  ): Promise<OfflineSyncSummary> {
    type SyncClaim =
      | {
          kind: 'transport'
          mutationId: string
          workOrderId: string
          claimId: string
          request: {
            mutation: OfflineMutation<TPayload>
            workPackage: OfflineWorkPackage<TContext>
          }
        }
      | { kind: 'processed'; mutationId: string; workOrderId: string }
      | { kind: 'done' }

    const retryFailed = options.retryFailed ?? true
    const processedMutationIds = new Set<string>()
    const skippedMutationIds = new Set<string>()
    const visitedMutationIds = new Set<string>()
    const blockedWorkOrders = new Set<string>()

    while (true) {
      const claim = await this.withLock(async (): Promise<SyncClaim> => {
        const snapshot = await this.readSnapshot()
        const now = this.now()
        const timestamp = now.toISOString()
        let changed = false

        for (const mutation of Object.values(snapshot.mutations)) {
          if (isSyncClaimExpired(mutation, now)) {
            mutation.status = 'pending'
            mutation.updatedAt = timestamp
            mutation.lastError = {
              code: 'SYNC_INTERRUPTED',
              message: 'Предыдущая синхронизация была прервана',
              retryable: true,
            }
            delete mutation.syncClaimId
            delete mutation.syncLeaseExpiresAt
            changed = true
          }
        }

        const ordered = Object.values(snapshot.mutations)
          .filter((mutation) => !options.workOrderId || mutation.workOrderId === options.workOrderId)
          .sort(compareMutations)

        for (const mutation of ordered) {
          if (mutation.status === 'synced' || visitedMutationIds.has(mutation.mutationId)) continue

          if (blockedWorkOrders.has(mutation.workOrderId)) {
            skippedMutationIds.add(mutation.mutationId)
            visitedMutationIds.add(mutation.mutationId)
            continue
          }

          if (
            mutation.status === 'conflict' ||
            mutation.status === 'access_expired' ||
            mutation.status === 'syncing' ||
            (mutation.status === 'failed' &&
              (!retryFailed || mutation.lastError?.retryable === false))
          ) {
            blockedWorkOrders.add(mutation.workOrderId)
            skippedMutationIds.add(mutation.mutationId)
            visitedMutationIds.add(mutation.mutationId)
            continue
          }

          const workPackage = snapshot.packages[mutation.workOrderId]
          if (
            !workPackage ||
            workPackage.grantId !== mutation.grantId ||
            workPackage.engineerId !== mutation.engineerId ||
            isExpired(workPackage.accessExpiresAt, now)
          ) {
            if (workPackage && isExpired(workPackage.accessExpiresAt, now)) {
              this.revokePackageAccess(snapshot, mutation.workOrderId, timestamp)
            } else {
              mutation.status = 'access_expired'
              mutation.updatedAt = timestamp
              mutation.lastError = {
                code: workPackage ? 'GRANT_EXPIRED' : 'PACKAGE_NOT_FOUND',
                message: workPackage
                  ? 'Временный доступ к заявке истёк'
                  : 'Офлайн-пакет для заявки не найден',
                retryable: false,
              }
              delete mutation.syncClaimId
              delete mutation.syncLeaseExpiresAt
            }
            await this.writeSnapshot(snapshot)
            return {
              kind: 'processed',
              mutationId: mutation.mutationId,
              workOrderId: mutation.workOrderId,
            }
          }

          const claimId = `${mutation.mutationId}:claim:${mutation.attempts + 1}:${now.getTime()}`
          mutation.status = 'syncing'
          mutation.attempts += 1
          mutation.lastAttemptAt = timestamp
          mutation.updatedAt = timestamp
          mutation.syncClaimId = claimId
          mutation.syncLeaseExpiresAt = new Date(now.getTime() + SYNC_LEASE_MS).toISOString()
          delete mutation.lastError
          await this.writeSnapshot(snapshot)
          return {
            kind: 'transport',
            mutationId: mutation.mutationId,
            workOrderId: mutation.workOrderId,
            claimId,
            request: {
              mutation: cloneValue(mutation) as OfflineMutation<TPayload>,
              workPackage: cloneValue(workPackage) as OfflineWorkPackage<TContext>,
            },
          }
        }

        if (changed) await this.writeSnapshot(snapshot)
        return { kind: 'done' }
      })

      if (claim.kind === 'done') break

      visitedMutationIds.add(claim.mutationId)
      if (claim.kind === 'processed') {
        processedMutationIds.add(claim.mutationId)
        blockedWorkOrders.add(claim.workOrderId)
        continue
      }

      let result: OfflineSyncResult<TServerState>
      try {
        result = await transport(claim.request)
      } catch (error) {
        result = {
          status: 'failed',
          code: 'NETWORK_ERROR',
          message:
            error instanceof Error
              ? error.message
              : 'Не удалось синхронизировать изменение',
          retryable: true,
        }
      }

      const finalized = await this.withLock(async () => {
        const snapshot = await this.readSnapshot()
        const mutation = snapshot.mutations[claim.mutationId]
        if (
          !mutation ||
          mutation.status !== 'syncing' ||
          mutation.syncClaimId !== claim.claimId
        ) {
          return { applied: false, status: mutation?.status }
        }

        const completedAt = this.now()
        this.applySyncResult(mutation, result, completedAt)
        if (result.status === 'access_expired') {
          this.revokePackageAccess(snapshot, mutation.workOrderId, completedAt.toISOString())
        }
        await this.writeSnapshot(snapshot)
        return { applied: true, status: mutation.status }
      })

      if (finalized.applied) processedMutationIds.add(claim.mutationId)
      else skippedMutationIds.add(claim.mutationId)
      if (finalized.status !== 'synced') blockedWorkOrders.add(claim.workOrderId)
    }

    const attemptedMutationIds = new Set([
      ...processedMutationIds,
      ...skippedMutationIds,
    ])
    const finalMutations = await this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      return Object.values(snapshot.mutations).filter((mutation) =>
        attemptedMutationIds.has(mutation.mutationId),
      )
    })
    return {
      processedMutationIds: [...processedMutationIds],
      skippedMutationIds: [...skippedMutationIds],
      counts: countStatuses(finalMutations),
    }
  }

  async markGrantExpired(grantId: string): Promise<number> {
    return this.withLock(async () => {
      const snapshot = await this.readSnapshot()
      const updatedAt = this.now().toISOString()
      let changed = 0
      let removedPackages = 0

      for (const workPackage of Object.values(snapshot.packages)) {
        if (workPackage.grantId === grantId) {
          delete snapshot.packages[workPackage.workOrderId]
          removedPackages += 1
        }
      }

      for (const mutation of Object.values(snapshot.mutations)) {
        if (mutation.grantId === grantId && mutation.status !== 'synced') {
          mutation.status = 'access_expired'
          mutation.updatedAt = updatedAt
          mutation.lastError = {
            code: 'GRANT_EXPIRED',
            message: 'Временный доступ к заявке истёк',
            retryable: false,
          }
          delete mutation.syncClaimId
          delete mutation.syncLeaseExpiresAt
          changed += 1
        }
      }

      if (changed > 0 || removedPackages > 0) {
        await this.writeSnapshot(snapshot)
      }

      return changed
    })
  }

  async clear(): Promise<void> {
    await this.withLock(() => this.storage.delete(this.storageKey))
  }

  private applySyncResult(
    mutation: OfflineMutation,
    result: OfflineSyncResult,
    completedAt: Date,
  ): void {
    const timestamp = completedAt.toISOString()
    mutation.updatedAt = timestamp
    delete mutation.syncClaimId
    delete mutation.syncLeaseExpiresAt

    switch (result.status) {
      case 'synced':
        mutation.status = 'synced'
        mutation.syncedAt = timestamp
        mutation.remoteVersion = result.remoteVersion
        mutation.receipt = cloneValue(result.receipt)
        delete mutation.lastError
        delete mutation.conflict
        break
      case 'conflict':
        mutation.status = 'conflict'
        mutation.conflict = {
          message: result.message,
          serverVersion: result.serverVersion,
          serverState: cloneValue(result.serverState),
          detectedAt: timestamp,
        }
        mutation.lastError = {
          code: 'VERSION_CONFLICT',
          message: result.message,
          retryable: false,
        }
        break
      case 'access_expired':
        mutation.status = 'access_expired'
        mutation.lastError = {
          code: 'GRANT_EXPIRED',
          message: result.message,
          retryable: false,
        }
        break
      case 'failed':
        mutation.status = 'failed'
        mutation.lastError = {
          code: result.code ?? 'SYNC_FAILED',
          message: result.message,
          retryable: result.retryable ?? true,
        }
        break
    }
  }

  private async readSnapshot(): Promise<OfflineSnapshot> {
    const snapshot = await this.storage.get<OfflineSnapshot>(this.storageKey)
    if (
      !snapshot ||
      snapshot.schemaVersion !== OFFLINE_SCHEMA_VERSION ||
      typeof snapshot.nextSequence !== 'number' ||
      !snapshot.packages || typeof snapshot.packages !== 'object' || Array.isArray(snapshot.packages) ||
      !snapshot.mutations || typeof snapshot.mutations !== 'object' || Array.isArray(snapshot.mutations) ||
      !snapshot.idempotencyIndex || typeof snapshot.idempotencyIndex !== 'object' || Array.isArray(snapshot.idempotencyIndex)
    ) {
      return createEmptySnapshot()
    }

    return snapshot
  }

  private async writeSnapshot(snapshot: OfflineSnapshot): Promise<void> {
    await this.storage.set(this.storageKey, snapshot)
  }

  private revokePackageAccess(
    snapshot: OfflineSnapshot,
    workOrderId: string,
    updatedAt: string,
  ): void {
    delete snapshot.packages[workOrderId]

    for (const mutation of Object.values(snapshot.mutations)) {
      if (
        mutation.workOrderId === workOrderId &&
        mutation.status !== 'synced'
      ) {
        mutation.status = 'access_expired'
        mutation.updatedAt = updatedAt
        mutation.lastError = {
          code: 'GRANT_EXPIRED',
          message: 'Временный доступ к заявке истёк',
          retryable: false,
        }
        delete mutation.syncClaimId
        delete mutation.syncLeaseExpiresAt
      }
    }
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockName = `contour-offline:${this.storageKey}`
    const execute = () => {
      const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
      return locks ? locks.request(lockName, operation) : operation()
    }
    const previous = sharedOperationTails.get(lockName) ?? Promise.resolve()
    const run = previous.then(execute, execute)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    sharedOperationTails.set(lockName, tail)
    void tail.finally(() => {
      if (sharedOperationTails.get(lockName) === tail) sharedOperationTails.delete(lockName)
    })
    return run
  }
}
