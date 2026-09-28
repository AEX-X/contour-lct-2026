import { describe, expect, it, vi } from 'vitest'

import { OfflineEngineerService } from './service'
import { MemoryOfflineStorage } from './storage'
import type { EngineerResultPayload } from './types'

const FIXED_NOW = new Date('2026-06-10T09:00:00.000Z')

function createHarness() {
  let id = 0
  let now = new Date(FIXED_NOW)
  const storage = new MemoryOfflineStorage()
  const service = new OfflineEngineerService({
    storage,
    now: () => new Date(now),
    createId: () => `generated-${++id}`,
  })

  return {
    service,
    storage,
    setNow(value: string) {
      now = new Date(value)
    },
  }
}

async function prepareActivePackage(
  service: OfflineEngineerService,
  workOrderId = 'wo-1',
  grantId = 'grant-1',
) {
  return service.preparePackage({
    packageId: `package-${workOrderId}`,
    workOrderId,
    engineerId: 'engineer-1',
    grantId,
    expectedVersion: 4,
    accessExpiresAt: '2026-06-10T18:00:00.000Z',
    context: {
      facility: { id: 'facility-1', name: 'Коллектор Тверской' },
      equipment: [{ id: 'sensor-1', name: 'Датчик температуры' }],
    },
  })
}

function reportPayload(summary: string): EngineerResultPayload {
  return {
    report: {
      summary,
      workPerformed: 'Заменён контактный модуль',
      clientDraftId: `draft-${summary}`,
      updatedAt: FIXED_NOW.toISOString(),
    },
  }
}

describe('OfflineEngineerService', () => {
  it('persists, restores and removes an in-progress result draft', async () => {
    const { service } = createHarness()
    const draft = {
      schemaVersion: 1 as const,
      workOrderId: 'wo-1',
      step: 1,
      updatedAt: FIXED_NOW.toISOString(),
      form: { diagnosis: 'Промежуточный результат' },
    }

    await service.saveDraft('wo-1', draft)
    expect(await service.getDraft('wo-1')).toEqual(draft)

    await service.removeDraft('wo-1')
    expect(await service.getDraft('wo-1')).toBeUndefined()
  })

  it('stores a complete offline package independently from domain modules', async () => {
    const { service } = createHarness()
    const saved = await prepareActivePackage(service)

    expect(saved.schemaVersion).toBe(1)
    expect(saved.context).toEqual({
      facility: { id: 'facility-1', name: 'Коллектор Тверской' },
      equipment: [{ id: 'sensor-1', name: 'Датчик температуры' }],
    })
    expect(await service.getPackage('wo-1')).toEqual(saved)
  })

  it('assigns deterministic sequence numbers and deduplicates by idempotency key', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)

    const firstInput = {
      idempotencyKey: 'engineer-1:wo-1:result:draft-a',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Первый отчёт'),
    }
    const first = await service.enqueue(firstInput)
    const duplicate = await service.enqueue(firstInput)
    const second = await service.enqueue({
      ...firstInput,
      idempotencyKey: 'engineer-1:wo-1:result:draft-b',
      payload: reportPayload('Второй отчёт'),
    })

    expect(duplicate).toEqual(first)
    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(await service.listMutations()).toHaveLength(2)
  })

  it('rejects reuse of an idempotency key for a different payload', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    const input = {
      idempotencyKey: 'same-key',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Исходный отчёт'),
    }
    await service.enqueue(input)

    await expect(service.enqueue({
      ...input,
      payload: reportPayload('Подменённый отчёт'),
    })).rejects.toThrow('idempotency key is already used')
    expect(await service.listMutations()).toHaveLength(1)
  })

  it('syncs once in sequence order and remains idempotent on repeated sync', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    const first = await service.enqueue({
      idempotencyKey: 'key-1',
      kind: 'record_arrival',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: { arrivedAt: FIXED_NOW.toISOString() },
    })
    const second = await service.enqueue({
      idempotencyKey: 'key-2',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 5,
      payload: reportPayload('Работы завершены'),
    })
    const calls: string[] = []
    const transport = vi.fn(async ({ mutation }) => {
      calls.push(mutation.mutationId)
      return {
        status: 'synced' as const,
        remoteVersion: mutation.expectedVersion + 1,
      }
    })

    const firstSync = await service.sync(transport)
    const secondSync = await service.sync(transport)

    expect(calls).toEqual([first.mutationId, second.mutationId])
    expect(firstSync.processedMutationIds).toEqual([
      first.mutationId,
      second.mutationId,
    ])
    expect(firstSync.counts.synced).toBe(2)
    expect(secondSync.processedMutationIds).toEqual([])
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('syncs only the explicitly selected work order', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service, 'wo-1', 'grant-1')
    await prepareActivePackage(service, 'wo-2', 'grant-2')
    await service.enqueue({
      idempotencyKey: 'selected-order-key',
      kind: 'record_arrival',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: { at: FIXED_NOW.toISOString() },
    })
    const untouched = await service.enqueue({
      idempotencyKey: 'other-order-key',
      kind: 'record_arrival',
      workOrderId: 'wo-2',
      engineerId: 'engineer-1',
      grantId: 'grant-2',
      expectedVersion: 4,
      payload: { at: FIXED_NOW.toISOString() },
    })
    const syncedWorkOrderIds: string[] = []
    const transport = vi.fn(async ({ mutation }: { mutation: { workOrderId: string } }) => {
      syncedWorkOrderIds.push(mutation.workOrderId)
      return { status: 'synced' as const }
    })

    await service.sync(transport, { workOrderId: 'wo-1' })

    expect(transport).toHaveBeenCalledTimes(1)
    expect(syncedWorkOrderIds).toEqual(['wo-1'])
    expect((await service.getMutation(untouched.mutationId))?.status).toBe('pending')
  })

  it('preserves a report on conflict and blocks only later changes for the same order', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service, 'wo-1', 'grant-1')
    await prepareActivePackage(service, 'wo-2', 'grant-2')

    const conflicting = await service.enqueue({
      idempotencyKey: 'conflict-key',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Нельзя потерять этот текст'),
    })
    const blocked = await service.enqueue({
      idempotencyKey: 'blocked-key',
      kind: 'update_work_log',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 5,
      payload: { note: 'Последующее изменение' },
    })
    const independent = await service.enqueue({
      idempotencyKey: 'independent-key',
      kind: 'record_arrival',
      workOrderId: 'wo-2',
      engineerId: 'engineer-1',
      grantId: 'grant-2',
      expectedVersion: 1,
      payload: { note: 'Другая заявка' },
    })

    const summary = await service.sync(async ({ mutation }) =>
      mutation.mutationId === conflicting.mutationId
        ? {
            status: 'conflict',
            message: 'Версия заявки изменилась',
            serverVersion: 7,
            serverState: { status: 'rework' },
          }
        : { status: 'synced', remoteVersion: 2 },
    )

    const storedConflict = await service.getMutation<EngineerResultPayload>(
      conflicting.mutationId,
    )
    const storedBlocked = await service.getMutation(blocked.mutationId)
    const storedIndependent = await service.getMutation(independent.mutationId)

    expect(storedConflict?.status).toBe('conflict')
    expect(storedConflict?.payload.report.summary).toBe(
      'Нельзя потерять этот текст',
    )
    expect(storedConflict?.conflict?.serverVersion).toBe(7)
    expect(storedBlocked?.status).toBe('pending')
    expect(storedIndependent?.status).toBe('synced')
    expect(summary.skippedMutationIds).toContain(blocked.mutationId)
  })

  it('keeps the report after grant expiry and syncs it after explicit renewal', async () => {
    const { service, setNow } = createHarness()
    await prepareActivePackage(service)
    const queued = await service.enqueue({
      idempotencyKey: 'expiry-key',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Отчёт, созданный без сети'),
    })
    const transport = vi.fn(async () => ({ status: 'synced' as const }))

    setNow('2026-06-10T19:00:00.000Z')
    await service.sync(transport)

    const expired = await service.getMutation<EngineerResultPayload>(
      queued.mutationId,
    )
    expect(expired?.status).toBe('access_expired')
    expect(expired?.payload.report.summary).toBe(
      'Отчёт, созданный без сети',
    )
    expect(await service.getPackage('wo-1')).toBeUndefined()
    expect(transport).not.toHaveBeenCalled()

    await service.preparePackage({
      packageId: 'package-renewed',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-renewed',
      expectedVersion: 5,
      preparedAt: '2026-06-10T19:01:00.000Z',
      accessExpiresAt: '2026-06-11T18:00:00.000Z',
      context: { renewed: true },
    })
    await service.requeue(queued.mutationId, {
      grantId: 'grant-renewed',
      expectedVersion: 5,
    })
    await service.sync(transport)

    const synced = await service.getMutation<EngineerResultPayload>(
      queued.mutationId,
    )
    expect(synced?.status).toBe('synced')
    expect(synced?.payload.report.summary).toBe(
      'Отчёт, созданный без сети',
    )
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('retries a transient failure without duplicating the queued mutation', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    const queued = await service.enqueue({
      idempotencyKey: 'network-key',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Повторная отправка'),
    })
    let attempt = 0
    const transport = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        throw new Error('Сеть недоступна')
      }
      return { status: 'synced' as const, remoteVersion: 5 }
    })

    await service.sync(transport)
    expect((await service.getMutation(queued.mutationId))?.status).toBe(
      'failed',
    )

    await service.sync(transport)
    const synced = await service.getMutation(queued.mutationId)
    expect(synced?.status).toBe('synced')
    expect(synced?.attempts).toBe(2)
    expect(await service.listMutations()).toHaveLength(1)
  })

  it('serializes concurrent sync calls so the transport sees each mutation once', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    await service.enqueue({
      idempotencyKey: 'concurrent-key',
      kind: 'record_arrival',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: { at: FIXED_NOW.toISOString() },
    })
    const transport = vi.fn(async () => {
      await Promise.resolve()
      return { status: 'synced' as const }
    })

    await Promise.all([service.sync(transport), service.sync(transport)])

    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('does not block a new offline write while network transport is pending', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    await service.enqueue({
      idempotencyKey: 'slow-sync-first',
      kind: 'record_arrival',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: { note: 'Первая запись' },
    })
    let releaseTransport!: () => void
    let transportStarted!: () => void
    const started = new Promise<void>((resolve) => { transportStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseTransport = resolve })
    const syncPromise = service.sync(async () => {
      transportStarted()
      await release
      return { status: 'synced' as const }
    })

    await started
    const second = await service.enqueue({
      idempotencyKey: 'write-during-transport',
      kind: 'update_work_log',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 5,
      payload: { note: 'Сохранено во время сети' },
    })
    expect(second.status).toBe('pending')

    releaseTransport()
    await syncPromise
    expect((await service.listMutations()).map((item) => item.mutationId)).toContain(second.mutationId)
  })

  it('keeps a revoked grant authoritative over a late successful response', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    const queued = await service.enqueue({
      idempotencyKey: 'revoked-during-transport',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Отчёт в момент отзыва'),
    })
    let releaseTransport!: () => void
    let transportStarted!: () => void
    const started = new Promise<void>((resolve) => { transportStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseTransport = resolve })
    const syncPromise = service.sync(async () => {
      transportStarted()
      await release
      return { status: 'synced' as const }
    })

    await started
    await service.markGrantExpired('grant-1')
    releaseTransport()
    await syncPromise

    expect(await service.getPackage('wo-1')).toBeUndefined()
    expect((await service.getMutation(queued.mutationId))?.status).toBe('access_expired')
  })

  it('does not recover an active sync lease from another service instance', async () => {
    const { service, storage } = createHarness()
    await prepareActivePackage(service)
    const queued = await service.enqueue({
      idempotencyKey: 'active-lease',
      kind: 'record_arrival',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: { note: 'Активная отправка' },
    })
    let releaseTransport!: () => void
    let transportStarted!: () => void
    const started = new Promise<void>((resolve) => { transportStarted = resolve })
    const release = new Promise<void>((resolve) => { releaseTransport = resolve })
    const syncPromise = service.sync(async () => {
      transportStarted()
      await release
      return { status: 'synced' as const }
    })

    await started
    const second = new OfflineEngineerService({
      storage,
      now: () => new Date(FIXED_NOW),
    })
    await second.initialize()
    expect((await second.getMutation(queued.mutationId))?.status).toBe('syncing')

    releaseTransport()
    await syncPromise
    expect((await second.getMutation(queued.mutationId))?.status).toBe('synced')
  })

  it('serializes concurrent writes from service instances that share storage', async () => {
    const storage = new MemoryOfflineStorage()
    const first = new OfflineEngineerService({
      storage,
      now: () => new Date(FIXED_NOW),
      createId: () => 'first-generated',
    })
    const second = new OfflineEngineerService({
      storage,
      now: () => new Date(FIXED_NOW),
      createId: () => 'second-generated',
    })
    await prepareActivePackage(first)

    await Promise.all([
      first.enqueue({
        mutationId: 'mutation-first',
        idempotencyKey: 'instance-key-1',
        kind: 'record_arrival',
        workOrderId: 'wo-1',
        engineerId: 'engineer-1',
        grantId: 'grant-1',
        expectedVersion: 4,
        payload: { note: 'Первая запись' },
      }),
      second.enqueue({
        mutationId: 'mutation-second',
        idempotencyKey: 'instance-key-2',
        kind: 'update_work_log',
        workOrderId: 'wo-1',
        engineerId: 'engineer-1',
        grantId: 'grant-1',
        expectedVersion: 5,
        payload: { note: 'Вторая запись' },
      }),
    ])

    const mutations = await first.listMutations()
    expect(mutations.map((item) => item.sequence)).toEqual([1, 2])
    expect(mutations.map((item) => item.mutationId)).toEqual([
      'mutation-first',
      'mutation-second',
    ])
  })

  it('recovers a persisted syncing mutation after an interrupted app session', async () => {
    const { service, storage } = createHarness()
    await prepareActivePackage(service)
    const queued = await service.enqueue({
      idempotencyKey: 'interrupted-key',
      kind: 'record_arrival',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: { at: FIXED_NOW.toISOString() },
    })
    const storageKey = 'contour:offline:snapshot:v3'
    const snapshot = await storage.get<{
      mutations: Record<string, { status: string }>
    }>(storageKey)
    if (!snapshot) {
      throw new Error('Expected persisted offline snapshot')
    }
    snapshot.mutations[queued.mutationId]!.status = 'syncing'
    await storage.set(storageKey, snapshot)

    const resumedService = new OfflineEngineerService({
      storage,
      now: () => new Date(FIXED_NOW),
      createId: () => 'unused-id',
    })
    const transport = vi.fn(async () => ({ status: 'synced' as const }))

    await resumedService.sync(transport)

    expect(transport).toHaveBeenCalledTimes(1)
    expect(
      (await resumedService.getMutation(queued.mutationId))?.status,
    ).toBe('synced')
  })

  it('removes protected package context when a grant is revoked but retains the report', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    const queued = await service.enqueue({
      idempotencyKey: 'revoked-key',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Черновик после отзыва доступа'),
    })

    expect(await service.markGrantExpired('grant-1')).toBe(1)

    expect(await service.getPackage('wo-1')).toBeUndefined()
    const retained = await service.getMutation<EngineerResultPayload>(
      queued.mutationId,
    )
    expect(retained?.status).toBe('access_expired')
    expect(retained?.payload.report.summary).toBe(
      'Черновик после отзыва доступа',
    )
  })

  it('purges the package when the server reports expired access and retains the report', async () => {
    const { service } = createHarness()
    await prepareActivePackage(service)
    const queued = await service.enqueue({
      idempotencyKey: 'server-expired-key',
      kind: 'submit_engineer_result',
      workOrderId: 'wo-1',
      engineerId: 'engineer-1',
      grantId: 'grant-1',
      expectedVersion: 4,
      payload: reportPayload('Отчёт при серверном отзыве'),
    })

    await service.sync(async () => ({
      status: 'access_expired',
      message: 'Доступ отозван координатором',
    }))

    expect(await service.getPackage('wo-1')).toBeUndefined()
    const retained = await service.getMutation<EngineerResultPayload>(queued.mutationId)
    expect(retained?.status).toBe('access_expired')
    expect(retained?.payload.report.summary).toBe('Отчёт при серверном отзыве')
  })

  it('ignores a malformed persisted snapshot instead of crashing', async () => {
    const storage = new MemoryOfflineStorage()
    await storage.set('contour:offline:snapshot:v3', {
      schemaVersion: 1,
      nextSequence: 'broken',
      packages: [],
      mutations: null,
      idempotencyIndex: {},
    })
    const service = new OfflineEngineerService({ storage })

    await expect(service.initialize()).resolves.toBeUndefined()
    await expect(service.listMutations()).resolves.toEqual([])
    await expect(service.listPackages()).resolves.toEqual([])
  })
})
