import {
  canAccessFacility,
  canAccessWorkOrder,
  computeAllowedActions,
  hasCapability,
  materializeCurrentUser,
  RepositoryError,
  selectDashboardMetrics,
  type AccessGrant,
  type AssignFacilityDispatcherCommand,
  type AssignFacilityDispatcherResponse,
  type AuditEvent,
  type CreateWorkOrderInput,
  type CurrentUser,
  type DemoState,
  type Equipment,
  type Facility,
  type FacilityAssignment,
  type HierarchyNode,
  type Incident,
  type MutationMeta,
  type Notification,
  type RepairResult,
  type RepositorySnapshot,
  type RiskDecisionCommand,
  type RiskForecast,
  type Sensor,
  type User,
  type UserRef,
  type WorkOrder,
  type WorkOrderActionCommand,
  type WorkOrderActionResponse,
  type WorkOrderAssignment,
  type WorkOrderPriority,
} from '../domain'
import {
  createDemoSeed,
  DEMO_PROFILE_IDS,
  DEMO_SCHEMA_VERSION,
  DEMO_SEED_VERSION,
  syntheticProvenance,
} from '../mocks'
import type {
  ContourRepository,
  EngineerCandidate,
  FacilityListParams,
  RiskListParams,
  RepositoryChange,
  StorageLike,
  WorkOrderListParams,
} from './ContourRepository'
import { createMemoryStorage } from './memoryStorage'

const STORAGE_KEY = 'contour:demo-state:v4'
const SESSION_USER_KEY = 'contour:demo-user:v1'
const sharedRepositoryMutationTails = new Map<string, Promise<void>>()

export interface MockContourRepositoryOptions {
  storage?: StorageLike | null
  initialState?: DemoState
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createResetScenarioId(baseScenarioId: string): string {
  const generation = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${baseScenarioId}:generation:${generation}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isPersistedDemoState(value: unknown): value is DemoState {
  if (!isRecord(value)) return false
  const mapKeys = [
    'organizations', 'users', 'operationalUnits', 'facilityAssignments', 'facilities',
    'hierarchyNodes', 'equipment', 'sensors', 'risks', 'incidents', 'failureEpisodes',
    'workOrders', 'assignments', 'accessGrants', 'notifications', 'auditEvents',
    'processedIdempotencyKeys',
  ]
  return (
    value.schemaVersion === DEMO_SCHEMA_VERSION &&
    value.seedVersion === DEMO_SEED_VERSION &&
    typeof value.activeUserId === 'string' &&
    typeof value.scenarioId === 'string' &&
    typeof value.revision === 'number' &&
    typeof value.demoClockIso === 'string' &&
    Number.isFinite(Date.parse(value.demoClockIso)) &&
    mapKeys.every((key) => isRecord(value[key])) &&
    isRecord(value.counters) &&
    typeof value.counters.nextWorkOrderNumber === 'number' &&
    typeof value.counters.nextEntitySequence === 'number' &&
    Boolean((value.users as Record<string, unknown>)[value.activeUserId])
  )
}

function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([first], [second]) => first.localeCompare(second))
          .map(([key, entry]) => [key, normalize(entry)]),
      )
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

function requiredSpecializations(state: DemoState, order: WorkOrder): string[] {
  if (order.target.type === 'sensor') return ['sensors']

  const equipmentCategory = order.target.type === 'equipment'
    ? state.equipment[order.target.id]?.categoryCode
    : null
  const category = (equipmentCategory ?? order.categoryCode).toLocaleLowerCase('ru-RU')
  const categoryMap: Record<string, string[]> = {
    ventilation: ['ventilation'],
    pumps: ['pumps'],
    gas: ['gas'],
    electrical: ['electrical'],
    mechanical: ['mechanical'],
    inspection: ['sensors'],
    predictive_inspection: ['sensors'],
    predictive_maintenance: ['sensors'],
    manual_inspection: ['sensors'],
  }

  return categoryMap[category] ?? ['__unsupported_category__']
}

function engineerMatchesOrder(state: DemoState, engineer: User, order: WorkOrder): boolean {
  const required = requiredSpecializations(state, order)
  return required.every((code) => engineer.specializationCodes?.includes(code))
}

async function requestFingerprint(value: unknown): Promise<string> {
  const content = new TextEncoder().encode(stableStringify(value))
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', content)
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }

  // Fallback for restricted test runtimes. Browsers use SHA-256 above.
  let hash = 0x811c9dc5
  for (const byte of content) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString()
}

function addHours(iso: string, hours: number): string {
  return addMinutes(iso, hours * 60)
}

function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString()
}

function slaDueAt(sla: NonNullable<WorkOrder['sla']>): string | null {
  if (sla.currentStage === 'acceptance') return sla.acceptanceDueAt
  if (sla.currentStage === 'arrival') return sla.arrivalDueAt
  if (sla.currentStage === 'resolution') return sla.resolutionDueAt
  return null
}

function refreshSlaClock(sla: NonNullable<WorkOrder['sla']>, now: string): void {
  sla.serverTime = now
  if (sla.state === 'paused' || sla.currentStage === 'completed') return
  const dueAt = slaDueAt(sla)
  if (!dueAt) {
    sla.remainingSeconds = null
    return
  }
  const remainingSeconds = Math.floor((Date.parse(dueAt) - Date.parse(now)) / 1000)
  const atRiskThreshold = {
    acceptance: 15 * 60,
    arrival: 30 * 60,
    resolution: 60 * 60,
  }[sla.currentStage]
  sla.remainingSeconds = remainingSeconds
  if (remainingSeconds < 0 && !sla.breachStage) sla.breachStage = sla.currentStage
  sla.state = sla.breachStage
    ? 'breached'
    : remainingSeconds < atRiskThreshold
      ? 'at_risk'
      : 'on_track'
}

function resumeSlaClock(sla: NonNullable<WorkOrder['sla']>, now: string): void {
  if (sla.pausedAt) {
    const pauseDuration = Math.max(0, Date.parse(now) - Date.parse(sla.pausedAt))
    if (sla.currentStage === 'acceptance' && sla.acceptanceDueAt) {
      sla.acceptanceDueAt = addMilliseconds(sla.acceptanceDueAt, pauseDuration)
    } else if (sla.currentStage === 'arrival' && sla.arrivalDueAt) {
      sla.arrivalDueAt = addMilliseconds(sla.arrivalDueAt, pauseDuration)
    } else if (sla.currentStage === 'resolution' && sla.resolutionDueAt) {
      sla.resolutionDueAt = addMilliseconds(sla.resolutionDueAt, pauseDuration)
    }
  }
  sla.pausedAt = null
  sla.pauseReason = null
  sla.state = sla.breachStage ? 'breached' : 'on_track'
  refreshSlaClock(sla, now)
}

function matchesOne<T extends string>(value: T, filter?: T | T[]): boolean {
  if (!filter) return true
  return Array.isArray(filter) ? filter.includes(value) : value === filter
}

function userRef(user: User): UserRef {
  return { id: user.id, displayName: user.displayName }
}

function isOpenWorkOrder(order: WorkOrder): boolean {
  return order.status !== 'closed' && order.status !== 'cancelled'
}

function validateRepairResult(
  result: Omit<RepairResult, 'completedAt' | 'author'>,
): Array<{ field: string; code: string; message: string }> {
  const errors: Array<{ field: string; code: string; message: string }> = []
  const add = (field: string, code: string, message: string) => {
    errors.push({ field, code, message })
  }

  if (result.failureConfirmed === null) {
    add('failureConfirmed', 'required', 'Укажи результат диагностики неисправности')
  }
  if (result.diagnosis.trim().length < 5) {
    add('diagnosis', 'too_short', 'Опиши результат диагностики минимум 5 символами')
  }
  if (result.actions.length === 0 || result.actions.some((action) => action.trim().length === 0)) {
    add('actions', 'required', 'Добавь хотя бы одно выполненное действие')
  }
  if (!Number.isInteger(result.laborMinutes) || (result.laborMinutes ?? 0) <= 0) {
    add('laborMinutes', 'invalid', 'Трудозатраты должны быть целым числом минут больше нуля')
  }
  result.parts.forEach((part, index) => {
    if (!part.name.trim() || !part.unit.trim() || !Number.isFinite(part.quantity) || part.quantity <= 0) {
      add(`parts.${index}`, 'invalid', 'Укажи название, единицу и положительное количество запчасти')
    }
  })
  if (result.equipmentRestored === null) {
    add('equipmentRestored', 'required', 'Укажи, восстановлена ли работоспособность')
  }
  if (!result.controlCheckResult || result.controlCheckResult.trim().length < 3) {
    add('controlCheckResult', 'too_short', 'Зафиксируй результат контрольной проверки')
  }
  if (!result.residualRisk) {
    add('residualRisk', 'required', 'Оцени остаточный риск')
  }

  return errors
}

function targetExists(state: DemoState, target: CreateWorkOrderInput['target']): boolean {
  if (target.type === 'facility') return target.id === target.facilityId && Boolean(state.facilities[target.id])
  if (target.type === 'equipment') return state.equipment[target.id]?.facilityId === target.facilityId
  if (target.type === 'sensor') return state.sensors[target.id]?.facilityId === target.facilityId
  return Object.values(state.hierarchyNodes).some(
    (node) =>
      node.facilityId === target.facilityId &&
      node.entityType === target.type &&
      (node.id === target.id || node.entityId === target.id),
  )
}

function canonicalTarget(state: DemoState, requested: WorkOrder['target']): WorkOrder['target'] | null {
  const facility = state.facilities[requested.facilityId]
  if (!facility) return null
  if (requested.type === 'facility') {
    if (requested.id !== facility.id) return null
    return {
      type: 'facility',
      id: facility.id,
      facilityId: facility.id,
      displayName: facility.name,
      hierarchyPath: [{ type: 'facility', id: facility.id, displayName: facility.name }],
      locationSnapshot: { text: facility.address, geo: facility.position, planPosition: null },
    }
  }

  const entity = requested.type === 'equipment'
    ? state.equipment[requested.id]
    : requested.type === 'sensor'
      ? state.sensors[requested.id]
      : null
  const node = entity
    ? state.hierarchyNodes[entity.hierarchyNodeId]
    : Object.values(state.hierarchyNodes).find(
        (candidate) =>
          candidate.facilityId === facility.id &&
          candidate.entityType === requested.type &&
          (candidate.id === requested.id || candidate.entityId === requested.id),
      )
  if (!node || node.facilityId !== facility.id) return null
  const displayName = entity?.name ?? node.displayName
  return {
    type: requested.type,
    id: requested.id,
    facilityId: facility.id,
    displayName,
    hierarchyPath: node.path.map((item, index) => ({
      type: index === node.path.length - 1 ? requested.type : 'path',
      id: `${node.id}-${index}`,
      displayName: item,
    })),
    locationSnapshot: {
      text: facility.address,
      geo: facility.position,
      planPosition: node.planPosition,
    },
  }
}

export class MockContourRepository implements ContourRepository {
  private state: DemoState
  private readonly storage: StorageLike
  private readonly listeners = new Set<(change: RepositoryChange) => void>()
  private snapshot: RepositorySnapshot
  private readonly reloadBeforeMutation: boolean
  private readonly usesBrowserSession: boolean
  private sessionUserId: string

  constructor(options: MockContourRepositoryOptions = {}) {
    this.storage = options.storage ?? browserStorage() ?? createMemoryStorage()
    this.reloadBeforeMutation = !options.initialState
    this.usesBrowserSession = options.storage === undefined && typeof window !== 'undefined'
    this.state = options.initialState ? clone(options.initialState) : this.loadState()
    let storedSessionUserId: string | null = null
    if (this.usesBrowserSession) {
      try {
        storedSessionUserId = window.sessionStorage.getItem(SESSION_USER_KEY)
      } catch {
        storedSessionUserId = null
      }
    }
    this.sessionUserId = options.initialState?.activeUserId
      ?? (storedSessionUserId && this.state.users[storedSessionUserId] ? storedSessionUserId : null)
      ?? DEMO_PROFILE_IDS[0]
      ?? this.state.activeUserId
    this.snapshot = this.makeSnapshot()
    if (!options.storage && typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== STORAGE_KEY) return
        this.state = this.loadState()
        this.snapshot = this.makeSnapshot()
        this.notify('external')
      })
    }
  }

  private loadState(): DemoState {
    const serialized = this.storage.getItem(STORAGE_KEY)
    if (!serialized) return createDemoSeed()

    try {
      const candidate: unknown = JSON.parse(serialized)
      return isPersistedDemoState(candidate) ? candidate : createDemoSeed()
    } catch {
      return createDemoSeed()
    }
  }

  private makeSnapshot(): RepositorySnapshot {
    return {
      scenarioId: this.state.scenarioId,
      revision: this.state.revision,
      activeUserId: this.sessionUserId,
      demoClockIso: this.state.demoClockIso,
    }
  }

  private saveSessionUser(userId: string | null): void {
    if (!this.usesBrowserSession) return
    try {
      if (userId) window.sessionStorage.setItem(SESSION_USER_KEY, userId)
      else window.sessionStorage.removeItem(SESSION_USER_KEY)
    } catch {
      // The selected demo profile remains valid for the current in-memory session.
    }
  }

  private persist(state: DemoState): void {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (error) {
      throw new RepositoryError(
        'PERSISTENCE_FAILED',
        'Не удалось сохранить изменение на устройстве. Освободи место и повтори действие',
        { correlationId: error instanceof Error ? error.name : undefined },
      )
    }
  }

  private commit(next: DemoState): void {
    next.revision = this.state.revision + 1
    this.persist(next)
    this.state = next
    this.snapshot = this.makeSnapshot()
    this.notify('local')
  }

  private notify(source: RepositoryChange['source']): void {
    const change: RepositoryChange = {
      source,
      snapshot: this.snapshot,
    }
    this.listeners.forEach((listener) => listener(change))
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async () => {
      if (this.reloadBeforeMutation) {
        this.state = this.loadState()
        this.snapshot = this.makeSnapshot()
      }
      return operation()
    }
    const runWithPlatformLock = () => {
      const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
      return locks ? locks.request(STORAGE_KEY, execute) : execute()
    }
    const previous = sharedRepositoryMutationTails.get(STORAGE_KEY) ?? Promise.resolve()
    const run = previous.then(runWithPlatformLock, runWithPlatformLock)
    const tail = run.then(() => undefined, () => undefined)
    sharedRepositoryMutationTails.set(STORAGE_KEY, tail)
    void tail.finally(() => {
      if (sharedRepositoryMutationTails.get(STORAGE_KEY) === tail) sharedRepositoryMutationTails.delete(STORAGE_KEY)
    })
    return run
  }

  private actor(state = this.state): User {
    const actor = state.users[this.sessionUserId]
    if (!actor) throw new RepositoryError('FORBIDDEN', 'Текущий demo-пользователь не найден')
    return actor
  }

  private requireCapability(user: User, capability: Parameters<typeof hasCapability>[1]): void {
    if (!hasCapability(user, capability)) {
      throw new RepositoryError('FORBIDDEN', 'Недостаточно прав для выполнения действия')
    }
  }

  private requireFacilityAccess(state: DemoState, user: User, facilityId: string): Facility {
    const facility = state.facilities[facilityId]
    if (!facility) throw new RepositoryError('NOT_FOUND', 'Объект не найден')
    if (!canAccessFacility(state, user, facilityId)) {
      throw new RepositoryError('FORBIDDEN', 'Объект недоступен в текущей области ответственности')
    }
    return facility
  }

  private materializeWorkOrder(state: DemoState, order: WorkOrder, actor = this.actor(state)): WorkOrder {
    const result = clone(order)
    result.currentAssignment = order.currentAssignment
      ? clone(state.assignments[order.currentAssignment.id] ?? order.currentAssignment)
      : null
    result.accessGrant = order.accessGrant
      ? clone(state.accessGrants[order.accessGrant.id] ?? order.accessGrant)
      : null
    result.allowedActions = computeAllowedActions(state, actor, result)
    return result
  }

  private refreshFacilityOperationalStatus(state: DemoState, facilityId: string): void {
    const facility = state.facilities[facilityId]
    if (!facility) return

    const openIncidents = Object.values(state.incidents)
      .filter((incident) => incident.facilityId === facilityId && incident.status !== 'resolved')
      .sort((left, right) => {
        const severityWeight = { critical: 0, high: 1, medium: 2, low: 3 }
        return severityWeight[left.severity] - severityWeight[right.severity]
      })
    const leadingIncident = openIncidents[0]
    const leadingRisk = Object.values(state.risks)
      .filter(
        (risk) =>
          risk.facilityId === facilityId &&
          ['new', 'acknowledged'].includes(risk.status) &&
          ['high', 'critical'].includes(risk.severity) &&
          Date.parse(risk.expiresAt) >= Date.parse(state.demoClockIso),
      )
      .sort((left, right) => right.probability - left.probability)[0]
    const breachedOrder = Object.values(state.workOrders).find(
      (order) =>
        order.target.facilityId === facilityId &&
        isOpenWorkOrder(order) &&
        order.sla?.state === 'breached',
    )
    const alarmSensor = Object.values(state.sensors).find(
      (sensor) => sensor.facilityId === facilityId && sensor.status === 'alarm',
    )
    const faultEquipment = Object.values(state.equipment).find(
      (item) => item.facilityId === facilityId && item.status === 'fault',
    )
    const attentionSensor = Object.values(state.sensors).find(
      (sensor) =>
        sensor.facilityId === facilityId &&
        ['attention', 'offline'].includes(sensor.status),
    )
    const attentionEquipment = Object.values(state.equipment).find(
      (item) => item.facilityId === facilityId && item.status === 'attention',
    )

    let nextStatus: Facility['status'] = 'normal'
    let nextReason = 'Отклонений не обнаружено'

    if (leadingIncident) {
      nextStatus = leadingIncident.severity === 'critical' ? 'critical' : 'attention'
      nextReason = leadingIncident.title
    } else if (alarmSensor) {
      nextStatus = 'critical'
      nextReason = `Тревога датчика: ${alarmSensor.name}`
    } else if (faultEquipment) {
      nextStatus = 'critical'
      nextReason = `Неисправность оборудования: ${faultEquipment.name}`
    } else if (leadingRisk) {
      nextStatus = 'attention'
      nextReason = leadingRisk.predictedEvent
    } else if (breachedOrder) {
      nextStatus = 'attention'
      nextReason = `Нарушен SLA заявки ${breachedOrder.number}`
    } else if (attentionSensor) {
      nextStatus = 'attention'
      nextReason = attentionSensor.status === 'offline'
        ? `Нет связи с датчиком: ${attentionSensor.name}`
        : `Датчик требует внимания: ${attentionSensor.name}`
    } else if (attentionEquipment) {
      nextStatus = 'attention'
      nextReason = `Оборудование требует внимания: ${attentionEquipment.name}`
    } else if (facility.sensorAvailability === null) {
      nextStatus = 'no_data'
      nextReason = 'Источник телеметрии временно недоступен'
    }

    if (facility.status !== nextStatus || facility.statusReason !== nextReason) {
      facility.status = nextStatus
      facility.statusReason = nextReason
      facility.updatedAt = state.demoClockIso
      facility.version += 1
    }
  }

  private nextId(state: DemoState, prefix: string): string {
    const sequence = state.counters.nextEntitySequence++
    return `${prefix}-${String(sequence).padStart(4, '0')}`
  }

  private createAudit(
    state: DemoState,
    entityType: string,
    entityId: string,
    action: string,
    actor: User,
    beforeVersion: number | null,
    afterVersion: number | null,
    reason: string | null,
    metadata: Record<string, unknown> = {},
  ): AuditEvent {
    const id = this.nextId(state, 'audit')
    const event: AuditEvent = {
      id,
      entityType,
      entityId,
      action,
      actor: userRef(actor),
      actorRole: actor.role,
      occurredAt: state.demoClockIso,
      reason,
      beforeVersion,
      afterVersion,
      metadata,
      provenance: syntheticProvenance(
        'manual',
        'Локальный синтетический журнал Contour',
        state.demoClockIso,
      ),
    }
    state.auditEvents[id] = event
    return event
  }

  private createNotification(
    state: DemoState,
    userId: string,
    values: Omit<Notification, 'id' | 'userId' | 'createdAt' | 'readAt' | 'provenance'>,
  ): Notification {
    const id = this.nextId(state, 'notification')
    const notification: Notification = {
      ...values,
      id,
      userId,
      createdAt: state.demoClockIso,
      readAt: null,
      provenance: syntheticProvenance(
        'derived',
        'Демонстрационный центр уведомлений Contour',
        state.demoClockIso,
      ),
    }
    state.notifications[id] = notification
    return notification
  }

  private getIdempotent<T>(
    state: DemoState,
    idempotencyKey: string,
    kind: DemoState['processedIdempotencyKeys'][string]['kind'],
    context: { actorId: string; resourceId: string; operation: string; fingerprint: string },
  ): T | null {
    const record = state.processedIdempotencyKeys[idempotencyKey]
    if (!record) return null
    if (
      record.kind !== kind ||
      record.actorId !== context.actorId ||
      record.resourceId !== context.resourceId ||
      record.operation !== context.operation ||
      record.fingerprint !== context.fingerprint
    ) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        'Ключ идемпотентности уже использован для другого действия',
      )
    }
    return clone(record.result as T)
  }

  private saveIdempotent(
    state: DemoState,
    idempotencyKey: string,
    kind: DemoState['processedIdempotencyKeys'][string]['kind'],
    context: { actorId: string; resourceId: string; operation: string; fingerprint: string },
    result: unknown,
  ): void {
    state.processedIdempotencyKeys[idempotencyKey] = {
      kind,
      ...context,
      createdAt: state.demoClockIso,
      result: clone(result),
    }
    const keys = Object.keys(state.processedIdempotencyKeys)
    if (keys.length > 500) {
      keys.slice(0, keys.length - 500).forEach((key) => delete state.processedIdempotencyKeys[key])
    }
  }

  private assertActorUnchanged(actorId: string): void {
    if (this.sessionUserId !== actorId) {
      throw new RepositoryError('VERSION_CONFLICT', 'Профиль изменился во время выполнения команды. Повтори действие')
    }
  }

  getSnapshot(): RepositorySnapshot {
    return this.snapshot
  }

  subscribe(listener: (change: RepositoryChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getCurrentUser(): Promise<CurrentUser> {
    return clone(materializeCurrentUser(this.state, this.actor()))
  }

  async listDemoProfiles(): Promise<User[]> {
    return DEMO_PROFILE_IDS.map((id) => clone(this.state.users[id]!))
  }

  async switchDemoUser(userId: string): Promise<CurrentUser> {
    return this.withMutationLock(() => this.switchDemoUserUnlocked(userId))
  }

  private async switchDemoUserUnlocked(userId: string): Promise<CurrentUser> {
    const user = this.state.users[userId]
    if (!user) throw new RepositoryError('NOT_FOUND', 'Demo-профиль не найден')
    this.sessionUserId = userId
    this.saveSessionUser(userId)
    this.snapshot = this.makeSnapshot()
    this.notify('local')
    return this.getCurrentUser()
  }

  async reset(): Promise<RepositorySnapshot> {
    return this.withMutationLock(() => this.resetUnlocked())
  }

  private async resetUnlocked(): Promise<RepositorySnapshot> {
    const seed = createDemoSeed()
    seed.scenarioId = createResetScenarioId(seed.scenarioId)
    this.sessionUserId = seed.activeUserId
    this.saveSessionUser(null)
    this.commit(seed)
    return this.getSnapshot()
  }

  async advanceDemoClock(minutes: number): Promise<RepositorySnapshot> {
    return this.withMutationLock(() => this.advanceDemoClockUnlocked(minutes))
  }

  private async advanceDemoClockUnlocked(minutes: number): Promise<RepositorySnapshot> {
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new RepositoryError('VALIDATION_ERROR', 'Интервал demo clock должен быть неотрицательным')
    }
    const next = clone(this.state)
    next.demoClockIso = addMinutes(next.demoClockIso, minutes)
    Object.values(next.workOrders).forEach((order) => {
      if (order.sla && isOpenWorkOrder(order)) refreshSlaClock(order.sla, next.demoClockIso)
    })
    Object.values(next.accessGrants).forEach((grant) => {
      if (
        ['scheduled', 'active'].includes(grant.status) &&
        grant.expiresAt &&
        Date.parse(grant.expiresAt) <= Date.parse(next.demoClockIso)
      ) {
        grant.status = 'expired'
        grant.version += 1
        const order = next.workOrders[grant.workOrderId]
        if (order?.accessGrant?.id === grant.id) order.accessGrant = clone(grant)
      }
    })
    Object.values(next.facilityAssignments).forEach((assignment) => {
      if (assignment.status === 'cancelled') return
      const now = Date.parse(next.demoClockIso)
      const nextStatus = now < Date.parse(assignment.startsAt)
        ? 'scheduled'
        : now < Date.parse(assignment.endsAt)
          ? 'active'
          : 'completed'
      if (assignment.status !== nextStatus) {
        assignment.status = nextStatus
        assignment.version += 1
      }
    })
    Object.values(next.facilities).forEach((facility) => {
      const activeAssignment = Object.values(next.facilityAssignments).find(
        (assignment) => assignment.facilityId === facility.id && assignment.status === 'active',
      )
      const responsibleDispatcherId = activeAssignment?.dispatcherId ?? null
      if (facility.responsibleDispatcherId !== responsibleDispatcherId) {
        facility.responsibleDispatcherId = responsibleDispatcherId
        facility.updatedAt = next.demoClockIso
        facility.version += 1
      }
      if (activeAssignment) {
        const dispatcher = next.users[activeAssignment.dispatcherId]
        if (dispatcher) dispatcher.homeRoute = `/facilities/${facility.id}`
      }
      this.refreshFacilityOperationalStatus(next, facility.id)
    })
    Object.values(next.users)
      .filter((user) => user.role === 'facility_dispatcher')
      .forEach((dispatcher) => {
        const activeAssignment = Object.values(next.facilityAssignments).find(
          (assignment) =>
            assignment.dispatcherId === dispatcher.id &&
            assignment.status === 'active',
        )
        if (!activeAssignment) {
          dispatcher.scope.facilityIds = []
          dispatcher.scope.operationalUnitIds = []
          dispatcher.homeRoute = '/my-facility'
          return
        }
        const facility = next.facilities[activeAssignment.facilityId]
        dispatcher.scope.facilityIds = [activeAssignment.facilityId]
        dispatcher.scope.operationalUnitIds = facility ? [facility.operationalUnitId] : []
        dispatcher.homeRoute = `/facilities/${activeAssignment.facilityId}`
      })
    this.commit(next)
    return this.getSnapshot()
  }

  async listFacilities(params: FacilityListParams = {}): Promise<Facility[]> {
    const actor = this.actor()
    const normalizedQuery = params.query?.trim().toLocaleLowerCase('ru-RU')
    return Object.values(this.state.facilities)
      .filter((facility) => canAccessFacility(this.state, actor, facility.id))
      .filter((facility) => !params.operationalUnitId || facility.operationalUnitId === params.operationalUnitId)
      .filter((facility) => !params.status || params.status === 'all' || facility.status === params.status)
      .filter((facility) => {
        if (!normalizedQuery) return true
        return [facility.name, facility.address, facility.internalCode, facility.rostaCode ?? '']
          .join(' ')
          .toLocaleLowerCase('ru-RU')
          .includes(normalizedQuery)
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'))
      .map(clone)
  }

  async getFacility(facilityId: string): Promise<Facility> {
    return clone(this.requireFacilityAccess(this.state, this.actor(), facilityId))
  }

  async getFacilityHierarchy(facilityId: string): Promise<HierarchyNode[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'facility.technical_context.read')
    this.requireFacilityAccess(this.state, actor, facilityId)
    return Object.values(this.state.hierarchyNodes)
      .filter((node) => node.facilityId === facilityId)
      .sort((a, b) => a.path.length - b.path.length || a.displayName.localeCompare(b.displayName, 'ru-RU'))
      .map(clone)
  }

  async listEquipment(facilityId: string): Promise<Equipment[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'facility.technical_context.read')
    this.requireFacilityAccess(this.state, actor, facilityId)
    return Object.values(this.state.equipment)
      .filter((item) => item.facilityId === facilityId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'))
      .map(clone)
  }

  async listSensors(facilityId: string): Promise<Sensor[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'facility.technical_context.read')
    this.requireFacilityAccess(this.state, actor, facilityId)
    return Object.values(this.state.sensors)
      .filter((item) => item.facilityId === facilityId)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'))
      .map(clone)
  }

  async listRisks(params: RiskListParams = {}): Promise<RiskForecast[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'risk.read')
    return Object.values(this.state.risks)
      .filter((risk) => canAccessFacility(this.state, actor, risk.facilityId))
      .filter((risk) => !params.facilityId || risk.facilityId === params.facilityId)
      .filter((risk) => matchesOne(risk.severity, params.severity))
      .filter((risk) => matchesOne(risk.status, params.status))
      .sort((a, b) => b.probability - a.probability)
      .map(clone)
  }

  async getRisk(riskId: string): Promise<RiskForecast> {
    const actor = this.actor()
    this.requireCapability(actor, 'risk.read')
    const risk = this.state.risks[riskId]
    if (!risk) throw new RepositoryError('NOT_FOUND', 'Прогноз риска не найден')
    this.requireFacilityAccess(this.state, actor, risk.facilityId)
    return clone(risk)
  }

  async confirmRisk(
    riskId: string,
    command: RiskDecisionCommand,
  ): Promise<{ risk: RiskForecast; incident: Incident; auditEventId: string }> {
    return this.withMutationLock(() => this.confirmRiskUnlocked(riskId, command))
  }

  private async confirmRiskUnlocked(
    riskId: string,
    command: RiskDecisionCommand,
  ): Promise<{ risk: RiskForecast; incident: Incident; auditEventId: string }> {
    const currentActor = this.actor()
    this.requireCapability(currentActor, 'risk.confirm')
    const currentRisk = this.state.risks[riskId]
    if (!currentRisk) throw new RepositoryError('NOT_FOUND', 'Прогноз риска не найден')
    this.requireFacilityAccess(this.state, currentActor, currentRisk.facilityId)
    const idempotencyContext = {
      actorId: currentActor.id,
      resourceId: riskId,
      operation: 'confirm',
      fingerprint: await requestFingerprint({ expectedVersion: command.expectedVersion, comment: command.comment }),
    }
    this.assertActorUnchanged(currentActor.id)
    const replay = this.getIdempotent<{
      risk: RiskForecast
      incident: Incident
      auditEventId: string
    }>(this.state, command.idempotencyKey, 'risk_decision', idempotencyContext)
    if (replay) return replay

    const next = clone(this.state)
    const actor = this.actor(next)
    this.requireCapability(actor, 'risk.confirm')
    const risk = next.risks[riskId]
    if (!risk) throw new RepositoryError('NOT_FOUND', 'Прогноз риска не найден')
    this.requireFacilityAccess(next, actor, risk.facilityId)
    if (risk.version !== command.expectedVersion) {
      throw new RepositoryError('VERSION_CONFLICT', 'Прогноз был изменён другим пользователем', {
        currentVersion: risk.version,
      })
    }
    if (['confirmed', 'rejected', 'resolved'].includes(risk.status)) {
      throw new RepositoryError('INVALID_TRANSITION', 'Решение по прогнозу уже принято')
    }
    if (Date.parse(risk.expiresAt) < Date.parse(next.demoClockIso)) {
      throw new RepositoryError('INVALID_TRANSITION', 'Срок действия прогноза истёк')
    }

    const beforeVersion = risk.version
    risk.status = 'confirmed'
    risk.version += 1
    risk.decidedAt = next.demoClockIso
    risk.decidedBy = userRef(actor)
    const incidentId = `incident-from-${risk.id}`
    const incident: Incident = {
      id: incidentId,
      version: 1,
      facilityId: risk.facilityId,
      target: clone(risk.target),
      sourceRiskId: risk.id,
      title: `Подтверждена необходимость проверки: ${risk.target.displayName}`,
      description: command.comment,
      severity: risk.severity,
      status: 'open',
      confirmedAt: next.demoClockIso,
      confirmedBy: userRef(actor),
      resolvedAt: null,
      failureEpisodeId: null,
      provenance: syntheticProvenance(
        'manual',
        'Решение demo-пользователя Contour',
        next.demoClockIso,
      ),
    }
    next.incidents[incidentId] = incident
    this.refreshFacilityOperationalStatus(next, risk.facilityId)
    const audit = this.createAudit(
      next,
      'risk',
      risk.id,
      'confirm',
      actor,
      beforeVersion,
      risk.version,
      command.comment,
      { incidentId },
    )
    const result = { risk: clone(risk), incident: clone(incident), auditEventId: audit.id }
    this.saveIdempotent(next, command.idempotencyKey, 'risk_decision', idempotencyContext, result)
    this.commit(next)
    return result
  }

  async listIncidents(facilityId?: string): Promise<Incident[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'incident.read')
    return Object.values(this.state.incidents)
      .filter((incident) => canAccessFacility(this.state, actor, incident.facilityId))
      .filter((incident) => !facilityId || incident.facilityId === facilityId)
      .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt))
      .map(clone)
  }

  async listWorkOrders(params: WorkOrderListParams = {}): Promise<WorkOrder[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'work_order.read')
    return Object.values(this.state.workOrders)
      .filter((order) => canAccessWorkOrder(this.state, actor, order))
      .filter((order) => !params.facilityId || order.target.facilityId === params.facilityId)
      .filter((order) => matchesOne(order.status, params.status))
      .filter(
        (order) =>
          !params.assignedToCurrentUser || order.currentAssignment?.engineerId === actor.id,
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((order) => this.materializeWorkOrder(this.state, order, actor))
  }

  async getWorkOrder(workOrderId: string): Promise<WorkOrder> {
    const actor = this.actor()
    this.requireCapability(actor, 'work_order.read')
    const order = this.state.workOrders[workOrderId]
    if (!order) throw new RepositoryError('NOT_FOUND', 'Заявка не найдена')
    if (!canAccessWorkOrder(this.state, actor, order)) {
      throw new RepositoryError('FORBIDDEN', 'Заявка недоступна в текущей области ответственности')
    }
    return this.materializeWorkOrder(this.state, order, actor)
  }

  async createWorkOrder(input: CreateWorkOrderInput, meta: MutationMeta): Promise<WorkOrder> {
    return this.withMutationLock(() => this.createWorkOrderUnlocked(input, meta))
  }

  private async createWorkOrderUnlocked(input: CreateWorkOrderInput, meta: MutationMeta): Promise<WorkOrder> {
    const currentActor = this.actor()
    this.requireCapability(currentActor, 'work_order.create')
    this.requireFacilityAccess(this.state, currentActor, input.target.facilityId)
    const idempotencyContext = {
      actorId: currentActor.id,
      resourceId: input.target.facilityId,
      operation: 'create',
      fingerprint: await requestFingerprint(input),
    }
    this.assertActorUnchanged(currentActor.id)
    const replay = this.getIdempotent<WorkOrder>(
      this.state,
      meta.idempotencyKey,
      'work_order_create',
      idempotencyContext,
    )
    if (replay) return replay

    const next = clone(this.state)
    const actor = this.actor(next)
    this.requireCapability(actor, 'work_order.create')
    const facility = this.requireFacilityAccess(next, actor, input.target.facilityId)
    const target = canonicalTarget(next, input.target)
    if (!target || !targetExists(next, target)) {
      throw new RepositoryError('VALIDATION_ERROR', 'Цель заявки не найдена на выбранном объекте')
    }
    if (input.affectedTargets?.some((target) => target.facilityId !== input.target.facilityId)) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        'Все связанные цели заявки должны находиться на одном объекте',
      )
    }
    if (input.affectedTargets?.some((target) => !targetExists(next, target))) {
      throw new RepositoryError('VALIDATION_ERROR', 'Одна из связанных целей заявки не найдена')
    }
    const affectedTargets = (input.affectedTargets ?? []).map((item) => canonicalTarget(next, item))
    if (affectedTargets.some((item) => !item)) {
      throw new RepositoryError('VALIDATION_ERROR', 'Одна из связанных целей заявки не найдена')
    }
    if (input.source.type === 'manual' && input.source.id !== null) {
      throw new RepositoryError('VALIDATION_ERROR', 'Ручной источник заявки не должен содержать идентификатор')
    }
    if (input.source.type === 'risk' && (!input.source.id || !next.risks[input.source.id])) {
      throw new RepositoryError('VALIDATION_ERROR', 'Исходный прогноз риска не найден')
    }
    if (input.source.type === 'incident' && (!input.source.id || !next.incidents[input.source.id])) {
      throw new RepositoryError('VALIDATION_ERROR', 'Исходный инцидент не найден')
    }
    if (input.source.type === 'risk' && next.risks[input.source.id!]?.status !== 'confirmed') {
      throw new RepositoryError('INVALID_TRANSITION', 'Сначала прогноз должен быть подтверждён диспетчером')
    }
    if (input.source.type === 'incident' && next.incidents[input.source.id!]?.status === 'resolved') {
      throw new RepositoryError('INVALID_TRANSITION', 'Нельзя создать заявку из закрытого инцидента')
    }
    const sourceFacilityId = input.source.type === 'risk'
      ? next.risks[input.source.id!]?.facilityId
      : input.source.type === 'incident'
        ? next.incidents[input.source.id!]?.facilityId
        : input.target.facilityId
    if (sourceFacilityId !== input.target.facilityId) {
      throw new RepositoryError('VALIDATION_ERROR', 'Источник и цель заявки должны относиться к одному объекту')
    }
    const sourceTargetId = input.source.type === 'risk'
      ? next.risks[input.source.id!]?.target.id
      : input.source.type === 'incident'
        ? next.incidents[input.source.id!]?.target.id
        : input.target.id
    if (sourceTargetId !== input.target.id) {
      throw new RepositoryError('VALIDATION_ERROR', 'Источник заявки не соответствует выбранной цели')
    }

    const id =
      ['risk-main-001', 'incident-from-risk-main-001'].includes(input.source.id ?? '') && !next.workOrders['wo-demo-main']
        ? 'wo-demo-main'
        : this.nextId(next, 'wo-demo')
    const number = `WO-2026-${next.counters.nextWorkOrderNumber++}`
    const relatedSensors = Object.values(next.sensors).filter(
      (sensor) => sensor.facilityId === input.target.facilityId,
    )
    const order: WorkOrder = {
      id,
      number,
      version: 1,
      status: 'draft',
      source: clone(input.source),
      target: clone(target),
      affectedTargets: clone(affectedTargets as WorkOrder['affectedTargets']),
      snapshot: {
        capturedAt: next.demoClockIso,
        facilityName: facility.name,
        sensorReadings: relatedSensors.map((sensor) => ({
          sensorId: sensor.id,
          value: sensor.lastReading?.value ?? null,
          unit: sensor.unit,
          at: sensor.lastReading?.at ?? null,
        })),
        note: 'Автоматический демонстрационный snapshot в момент создания заявки',
      },
      categoryCode: input.categoryCode,
      symptoms: [...input.symptoms],
      description: input.description,
      systemRecommendation:
        input.source.type === 'risk' && input.source.id
          ? next.risks[input.source.id]?.recommendation ?? null
          : null,
      preliminaryPriority: input.preliminaryPriority,
      finalPriority: null,
      prioritySource: input.preliminaryPriority ? 'dispatcher' : null,
      sla: null,
      creator: userRef(actor),
      responsibleDispatcher:
        facility.responsibleDispatcherId && next.users[facility.responsibleDispatcherId]
          ? userRef(next.users[facility.responsibleDispatcherId]!)
          : null,
      coordinator: null,
      maintenanceOrganizationId: 'org-repair',
      currentAssignment: null,
      accessGrant: null,
      repairResult: null,
      estimatedCost: null,
      actualCost: null,
      duplicateOfWorkOrderId: null,
      recurrenceOfWorkOrderId: null,
      createdAt: next.demoClockIso,
      updatedAt: next.demoClockIso,
      closedAt: null,
      provenance: syntheticProvenance(
        'manual',
        'Создано demo-пользователем Contour',
        next.demoClockIso,
      ),
      allowedActions: [],
    }
    next.workOrders[id] = order
    this.createAudit(next, 'work_order', id, 'create', actor, null, 1, null, {
      source: input.source,
      targetType: input.target.type,
    })
    const result = this.materializeWorkOrder(next, order, actor)
    this.saveIdempotent(next, meta.idempotencyKey, 'work_order_create', idempotencyContext, result)
    this.commit(next)
    return result
  }

  private createSla(state: DemoState, priority: WorkOrderPriority, policyId: string): NonNullable<WorkOrder['sla']> {
    // The mock adapter emulates a backend policy. UI code never owns these durations.
    const policyMinutes: Record<
      WorkOrderPriority,
      { acceptance: number; arrival: number; resolution: number }
    > = {
      P1: { acceptance: 15, arrival: 60, resolution: 240 },
      P2: { acceptance: 30, arrival: 120, resolution: 480 },
      P3: { acceptance: 120, arrival: 480, resolution: 1440 },
      P4: { acceptance: 480, arrival: 1440, resolution: 4320 },
    }
    const policy = policyMinutes[priority]
    return {
      policyId,
      startedAt: state.demoClockIso,
      acceptanceDueAt: addMinutes(state.demoClockIso, policy.acceptance),
      arrivalDueAt: addMinutes(state.demoClockIso, policy.arrival),
      resolutionDueAt: addMinutes(state.demoClockIso, policy.resolution),
      currentStage: 'acceptance',
      state: 'on_track',
      pausedAt: null,
      pauseReason: null,
      breachStage: null,
      remainingSeconds: policy.acceptance * 60,
      serverTime: state.demoClockIso,
    }
  }

  private revokeGrant(state: DemoState, order: WorkOrder): void {
    if (!order.accessGrant) return
    const grant = state.accessGrants[order.accessGrant.id]
    if (!grant || grant.status === 'revoked') return
    grant.status = 'revoked'
    grant.revokedAt = state.demoClockIso
    grant.version += 1
    order.accessGrant = clone(grant)
  }

  private assignEngineer(
    state: DemoState,
    order: WorkOrder,
    actor: User,
    engineerId: string,
  ): void {
    const engineer = state.users[engineerId]
    if (!engineer || engineer.role !== 'engineer' || engineer.organizationId !== order.maintenanceOrganizationId) {
      throw new RepositoryError('NO_SUITABLE_ENGINEER', 'Подходящий инженер не найден')
    }
    if (engineer.availability === 'off_shift') {
      throw new RepositoryError('NO_SUITABLE_ENGINEER', 'Инженер сейчас не на смене')
    }
    if (!engineerMatchesOrder(state, engineer, order)) {
      throw new RepositoryError('NO_SUITABLE_ENGINEER', 'Специализация инженера не подходит для этой заявки')
    }

    const assignmentId = this.nextId(state, 'assignment')
    const assignment: WorkOrderAssignment = {
      id: assignmentId,
      workOrderId: order.id,
      engineerId,
      assignedBy: userRef(actor),
      assignedAt: state.demoClockIso,
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
      completedAt: null,
      status: 'assigned',
      version: 1,
    }
    state.assignments[assignmentId] = assignment

    const grantId = this.nextId(state, 'grant')
    const grant: AccessGrant = {
      id: grantId,
      workOrderId: order.id,
      facilityId: order.target.facilityId,
      userId: engineerId,
      accessLevel: 'technical_full',
      startsAt: state.demoClockIso,
      expiresAt: addHours(state.demoClockIso, 48),
      revokedAt: null,
      status: 'scheduled',
      offlineCacheExpiresAt: addHours(state.demoClockIso, 12),
      version: 1,
    }
    state.accessGrants[grantId] = grant
    order.currentAssignment = clone(assignment)
    order.accessGrant = clone(grant)
    order.status = 'assigned'
    order.coordinator = userRef(actor)

    this.createNotification(state, engineerId, {
      type: 'work_order.assigned',
      priority: order.finalPriority === 'P1' ? 'critical' : 'warning',
      title: 'Назначена новая работа',
      body: `${order.number}: ${order.target.displayName}`,
      entityType: 'work_order',
      entityId: order.id,
      deepLink: `/my-work/${order.id}`,
      groupKey: `work-order:${order.id}`,
    })
  }

  private maintenanceCoordinatorId(state: DemoState, order: WorkOrder): string | null {
    if (order.coordinator?.id && state.users[order.coordinator.id]) return order.coordinator.id
    return Object.values(state.users).find(
      (user) =>
        user.role === 'maintenance_coordinator' &&
        user.organizationId === order.maintenanceOrganizationId,
    )?.id ?? null
  }

  async performWorkOrderAction(
    workOrderId: string,
    command: WorkOrderActionCommand,
  ): Promise<WorkOrderActionResponse> {
    return this.withMutationLock(() => this.performWorkOrderActionUnlocked(workOrderId, command))
  }

  private async performWorkOrderActionUnlocked(
    workOrderId: string,
    command: WorkOrderActionCommand,
  ): Promise<WorkOrderActionResponse> {
    const currentActor = this.actor()
    if (!Number.isFinite(Date.parse(command.clientOccurredAt))) {
      throw new RepositoryError('VALIDATION_ERROR', 'Время действия указано некорректно', {
        fieldErrors: [{ field: 'clientOccurredAt', code: 'invalid', message: 'Укажи корректную дату и время' }],
      })
    }
    const idempotencyContext = {
      actorId: currentActor.id,
      resourceId: workOrderId,
      operation: command.action,
      fingerprint: await requestFingerprint({
        action: command.action,
        expectedVersion: command.expectedVersion,
        payload: command.payload,
      }),
    }
    this.assertActorUnchanged(currentActor.id)
    const replay = this.getIdempotent<WorkOrderActionResponse>(
      this.state,
      command.idempotencyKey,
      'work_order_action',
      idempotencyContext,
    )
    if (replay) return replay

    const currentOrder = this.state.workOrders[workOrderId]
    if (!currentOrder) throw new RepositoryError('NOT_FOUND', 'Заявка не найдена')
    if (!canAccessWorkOrder(this.state, currentActor, currentOrder)) {
      throw new RepositoryError('FORBIDDEN', 'Заявка недоступна в текущей области ответственности')
    }

    const next = clone(this.state)
    const actor = this.actor(next)
    const order = next.workOrders[workOrderId]
    if (!order) throw new RepositoryError('NOT_FOUND', 'Заявка не найдена')
    if (!canAccessWorkOrder(next, actor, order)) {
      throw new RepositoryError('FORBIDDEN', 'Заявка недоступна в текущей области ответственности')
    }
    if (order.version !== command.expectedVersion) {
      throw new RepositoryError('VERSION_CONFLICT', 'Заявка была изменена другим пользователем', {
        currentVersion: order.version,
      })
    }
    const allowedActions = computeAllowedActions(next, actor, order)
    if (!allowedActions.includes(command.action)) {
      throw new RepositoryError(
        'INVALID_TRANSITION',
        'Действие недоступно для текущего статуса, роли или области ответственности',
      )
    }

    const beforeVersion = order.version
    let reason: string | null = null
    let auditMetadata: Record<string, unknown> = {}

    switch (command.action) {
      case 'edit':
        if (command.payload.description !== undefined) order.description = command.payload.description
        if (command.payload.symptoms !== undefined) order.symptoms = [...command.payload.symptoms]
        if (command.payload.categoryCode !== undefined) order.categoryCode = command.payload.categoryCode
        if (command.payload.preliminaryPriority !== undefined) order.preliminaryPriority = command.payload.preliminaryPriority
        auditMetadata = { changedFields: Object.keys(command.payload) }
        break
      case 'submit':
        order.status = 'submitted'
        reason = command.payload?.comment ?? null
        {
          const recipientId = this.maintenanceCoordinatorId(next, order)
          if (recipientId) this.createNotification(next, recipientId, {
            type: 'work_order.submitted',
            priority: order.preliminaryPriority === 'P1' ? 'critical' : 'warning',
            title: 'Новая заявка на триаж',
            body: `${order.number}: ${order.target.displayName}`,
            entityType: 'work_order',
            entityId: order.id,
            deepLink: `/work-orders/${order.id}`,
            groupKey: `work-order:${order.id}`,
          })
        }
        break
      case 'start_triage':
        order.status = 'triage'
        order.coordinator = userRef(actor)
        reason = command.payload?.comment ?? null
        break
      case 'request_clarification':
        order.status = 'needs_clarification'
        reason = command.payload.reason
        this.createNotification(
          next,
          next.facilities[order.target.facilityId]?.responsibleDispatcherId ??
            order.responsibleDispatcher?.id ??
            order.creator.id,
          {
          type: 'work_order.needs_clarification',
          priority: 'warning',
          title: 'Заявка требует уточнения',
          body: `${order.number}: ${reason}`,
          entityType: 'work_order',
          entityId: order.id,
          deepLink: `/work-orders/${order.id}`,
          groupKey: `work-order:${order.id}`,
          },
        )
        break
      case 'resubmit_clarification':
        order.status = 'submitted'
        reason = command.payload.comment
        {
          const recipientId = this.maintenanceCoordinatorId(next, order)
          if (recipientId) this.createNotification(next, recipientId, {
            type: 'work_order.clarification_resubmitted',
            priority: 'info',
            title: 'Уточнение по заявке получено',
            body: `${order.number}: ${command.payload.comment}`,
            entityType: 'work_order',
            entityId: order.id,
            deepLink: `/work-orders/${order.id}`,
            groupKey: `work-order:${order.id}`,
          })
        }
        break
      case 'finalize_priority':
        order.finalPriority = command.payload.priority
        order.prioritySource = actor.role === 'manager' ? 'manager_override' : 'coordinator'
        order.coordinator = userRef(actor)
        {
          const sla = this.createSla(next, command.payload.priority, `sla-${command.payload.priority.toLowerCase()}-default`)
          order.sla = sla
          auditMetadata = { priority: command.payload.priority, slaPolicyId: sla.policyId }
        }
        break
      case 'assign':
        this.assignEngineer(next, order, actor, command.payload.engineerId)
        reason = command.payload.comment ?? null
        auditMetadata = { engineerId: command.payload.engineerId }
        break
      case 'reassign': {
        reason = command.payload.reason
        if (order.currentAssignment) {
          const current = next.assignments[order.currentAssignment.id]
          if (current) {
            current.status = 'superseded'
            current.version += 1
          }
        }
        this.revokeGrant(next, order)
        if (order.sla?.state === 'paused') resumeSlaClock(order.sla, next.demoClockIso)
        this.assignEngineer(next, order, actor, command.payload.engineerId)
        auditMetadata = { engineerId: command.payload.engineerId }
        break
      }
      case 'accept': {
        order.status = 'accepted'
        reason = command.payload?.comment ?? null
        const assignment = order.currentAssignment
          ? next.assignments[order.currentAssignment.id]
          : null
        if (!assignment) throw new RepositoryError('ASSIGNMENT_CHANGED', 'Назначение больше не актуально')
        assignment.status = 'accepted'
        assignment.acceptedAt = next.demoClockIso
        assignment.version += 1
        order.currentAssignment = clone(assignment)
        const grant = order.accessGrant ? next.accessGrants[order.accessGrant.id] : null
        if (
          !grant ||
          grant.userId !== actor.id ||
          grant.status !== 'scheduled' ||
          grant.revokedAt ||
          (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(next.demoClockIso))
        ) {
          throw new RepositoryError('ACCESS_EXPIRED', 'Временный доступ не найден')
        }
        grant.status = 'active'
        grant.version += 1
        order.accessGrant = clone(grant)
        if (order.sla) {
          order.sla.currentStage = 'arrival'
          refreshSlaClock(order.sla, next.demoClockIso)
        }
        break
      }
      case 'decline': {
        reason = command.payload.reason
        order.status = 'triage'
        const assignment = order.currentAssignment
          ? next.assignments[order.currentAssignment.id]
          : null
        if (assignment) {
          assignment.status = 'declined'
          assignment.declinedAt = next.demoClockIso
          assignment.declineReason = reason
          assignment.version += 1
          order.currentAssignment = clone(assignment)
        }
        this.revokeGrant(next, order)
        {
          const recipientId = this.maintenanceCoordinatorId(next, order)
          if (recipientId) this.createNotification(next, recipientId, {
            type: 'assignment.declined',
            priority: 'warning',
            title: 'Инженер отказался от назначения',
            body: `${order.number}: ${reason}`,
            entityType: 'work_order',
            entityId: order.id,
            deepLink: `/work-orders/${order.id}`,
            groupKey: `work-order:${order.id}`,
          })
        }
        break
      }
      case 'mark_en_route':
        order.status = 'en_route'
        reason = command.payload?.comment ?? null
        break
      case 'start_work':
        order.status = 'in_progress'
        reason = command.payload?.comment ?? null
        if (order.sla) {
          order.sla.currentStage = 'resolution'
          refreshSlaClock(order.sla, next.demoClockIso)
        }
        break
      case 'wait_access':
      case 'wait_parts':
        order.status = command.action === 'wait_access' ? 'waiting_access' : 'waiting_parts'
        reason = command.payload.reason
        if (order.sla) {
          refreshSlaClock(order.sla, next.demoClockIso)
          order.sla.state = 'paused'
          order.sla.pausedAt = next.demoClockIso
          order.sla.pauseReason = reason
        }
        break
      case 'resume_work':
        order.status = 'in_progress'
        reason = command.payload?.comment ?? null
        if (order.sla) {
          resumeSlaClock(order.sla, next.demoClockIso)
        }
        break
      case 'submit_result': {
        const fieldErrors = validateRepairResult(command.payload.repairResult)
        if (fieldErrors.length > 0) {
          throw new RepositoryError('VALIDATION_ERROR', 'Проверь обязательные поля отчёта о ремонте', {
            fieldErrors,
          })
        }
        order.status = 'completed_by_engineer'
        order.repairResult = {
          ...clone(command.payload.repairResult),
          completedAt: command.clientOccurredAt,
          author: userRef(actor),
        }
        auditMetadata = {
          equipmentRestored: command.payload.repairResult.equipmentRestored,
          rootCauseCode: command.payload.repairResult.rootCauseCode,
          laborMinutes: command.payload.repairResult.laborMinutes,
        }
        if (order.currentAssignment) {
          const assignment = next.assignments[order.currentAssignment.id]
          if (assignment) {
            assignment.status = 'completed'
            assignment.completedAt = command.clientOccurredAt
            assignment.version += 1
            order.currentAssignment = clone(assignment)
          }
        }
        const activeDispatcher = Object.values(next.facilityAssignments).find(
          (assignment) =>
            assignment.facilityId === order.target.facilityId &&
            assignment.status === 'active' &&
            Date.parse(assignment.startsAt) <= Date.parse(next.demoClockIso) &&
            Date.parse(next.demoClockIso) < Date.parse(assignment.endsAt),
        )
        const verificationRecipientId = activeDispatcher?.dispatcherId ?? order.responsibleDispatcher?.id ?? 'user-senior'
        if (verificationRecipientId) {
          this.createNotification(next, verificationRecipientId, {
            type: 'work_order.awaiting_verification',
            priority: 'warning',
            title: 'Работа передана на проверку',
            body: `${order.number}: ${order.target.displayName}`,
            entityType: 'work_order',
            entityId: order.id,
            deepLink: `/work-orders/${order.id}`,
            groupKey: `work-order:${order.id}`,
          })
        }
        break
      }
      case 'start_verification':
        order.status = 'verification'
        reason = command.payload?.comment ?? null
        break
      case 'return_for_rework':
        order.status = 'rework'
        reason = command.payload.reason
        auditMetadata = { expectedChanges: command.payload.expectedChanges }
        if (order.currentAssignment) {
          const assignment = next.assignments[order.currentAssignment.id]
          if (assignment) {
            assignment.status = 'accepted'
            assignment.completedAt = null
            assignment.version += 1
            order.currentAssignment = clone(assignment)
          }
        }
        if (order.currentAssignment) {
          this.createNotification(next, order.currentAssignment.engineerId, {
            type: 'work_order.rework',
            priority: 'warning',
            title: 'Работа возвращена на доработку',
            body: `${order.number}: ${reason}`,
            entityType: 'work_order',
            entityId: order.id,
            deepLink: `/my-work/${order.id}`,
            groupKey: `work-order:${order.id}`,
          })
        }
        break
      case 'close':
        if (!command.payload.equipmentOperational) {
          throw new RepositoryError('VALIDATION_ERROR', 'Нельзя закрыть заявку, пока неисправность сохраняется')
        }
        if (
          order.repairResult &&
          (!order.repairResult.equipmentRestored || order.repairResult.residualRisk === 'high')
        ) {
          throw new RepositoryError('VALIDATION_ERROR', 'Результат ремонта требует доработки перед закрытием')
        }
        order.status = 'closed'
        reason = command.payload.comment ?? null
        auditMetadata = { equipmentOperational: command.payload.equipmentOperational }
        order.closedAt = next.demoClockIso
        if (order.sla) {
          order.sla.currentStage = 'completed'
          order.sla.state = 'completed'
          order.sla.remainingSeconds = null
          order.sla.serverTime = next.demoClockIso
        }
        this.revokeGrant(next, order)
        {
          const relatedIncidents = Object.values(next.incidents).filter((incident) =>
            incident.status !== 'resolved' && (
              (order.source.type === 'incident' && incident.id === order.source.id) ||
              (order.source.type === 'risk' && incident.sourceRiskId === order.source.id)
            ),
          )
          relatedIncidents.forEach((incident) => {
            const hasOtherOpenRelatedOrder = Object.values(next.workOrders).some(
              (candidate) =>
                candidate.id !== order.id &&
                isOpenWorkOrder(candidate) &&
                (
                  (candidate.source.type === 'incident' && candidate.source.id === incident.id) ||
                  (candidate.source.type === 'risk' && candidate.source.id === incident.sourceRiskId)
                ),
            )
            if (hasOtherOpenRelatedOrder) return
            const incidentBeforeVersion = incident.version
            incident.status = 'resolved'
            incident.resolvedAt = next.demoClockIso
            incident.version += 1
            if (incident.failureEpisodeId) {
              const episode = next.failureEpisodes[incident.failureEpisodeId]
              if (episode) {
                episode.resolvedAt = next.demoClockIso
                episode.rootCauseCode = order.repairResult?.rootCauseCode ?? episode.rootCauseCode
              }
            }
            this.createAudit(
              next,
              'incident',
              incident.id,
              'resolve',
              actor,
              incidentBeforeVersion,
              incident.version,
              'Связанный ремонт проверен и закрыт',
              { workOrderId: order.id },
            )
            if (incident.sourceRiskId) {
              const sourceRisk = next.risks[incident.sourceRiskId]
              if (sourceRisk?.status === 'confirmed') {
                const riskBeforeVersion = sourceRisk.version
                sourceRisk.status = 'resolved'
                sourceRisk.version += 1
                this.createAudit(
                  next,
                  'risk',
                  sourceRisk.id,
                  'resolve',
                  actor,
                  riskBeforeVersion,
                  sourceRisk.version,
                  'Связанный инцидент и ремонт закрыты',
                  { incidentId: incident.id, workOrderId: order.id },
                )
              }
            }
          })
        }
        break
      case 'cancel':
        order.status = 'cancelled'
        reason = command.payload.reason
        if (order.currentAssignment) {
          const assignment = next.assignments[order.currentAssignment.id]
          if (assignment) {
            assignment.status = 'cancelled'
            assignment.version += 1
            order.currentAssignment = clone(assignment)
          }
        }
        this.revokeGrant(next, order)
        break
      case 'override':
        reason = command.payload.reason
        auditMetadata = { note: command.payload.note, override: true }
        break
    }

    order.version += 1
    order.updatedAt = next.demoClockIso
    order.allowedActions = []
    this.refreshFacilityOperationalStatus(next, order.target.facilityId)
    const audit = this.createAudit(
      next,
      'work_order',
      order.id,
      command.action,
      actor,
      beforeVersion,
      order.version,
      reason,
      auditMetadata,
    )
    const response: WorkOrderActionResponse = {
      workOrder: this.materializeWorkOrder(next, order, actor),
      appliedAction: command.action,
      auditEventId: audit.id,
    }
    this.saveIdempotent(next, command.idempotencyKey, 'work_order_action', idempotencyContext, response)
    this.commit(next)
    return response
  }

  async listEngineerCandidates(workOrderId: string): Promise<EngineerCandidate[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'engineer_workload.read')
    const order = this.state.workOrders[workOrderId]
    if (!order) throw new RepositoryError('NOT_FOUND', 'Заявка не найдена')
    if (!canAccessWorkOrder(this.state, actor, order)) {
      throw new RepositoryError('FORBIDDEN', 'Заявка недоступна')
    }

    return this.engineerCandidatesForOrganization(order.maintenanceOrganizationId, order)
  }

  private engineerCandidatesForOrganization(organizationId: string, order?: WorkOrder): EngineerCandidate[] {
    return Object.values(this.state.users)
      .filter((user) => user.role === 'engineer' && user.organizationId === organizationId)
      .map((user) => {
        const activeWorkOrderCount = Object.values(this.state.workOrders).filter(
          (candidateOrder) =>
            candidateOrder.currentAssignment?.engineerId === user.id &&
            ['assigned', 'accepted'].includes(candidateOrder.currentAssignment.status) &&
            isOpenWorkOrder(candidateOrder),
        ).length
        const specializationMatches = !order || engineerMatchesOrder(this.state, user, order)
        const eligible = user.availability !== 'off_shift' && specializationMatches
        return {
          user: {
            id: user.id,
            displayName: user.displayName,
            availability: user.availability,
            specializationCodes: [...(user.specializationCodes ?? [])],
          },
          activeWorkOrderCount,
          eligible,
          eligibilityReason: !specializationMatches
            ? 'Не подходит специализация'
            : eligible
              ? user.availability === 'busy'
                ? 'Доступен с текущей загрузкой'
                : 'Доступен для назначения'
              : 'Инженер не на смене',
        }
      })
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.activeWorkOrderCount - b.activeWorkOrderCount)
  }

  async listMaintenanceEngineers(): Promise<EngineerCandidate[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'engineer_workload.read')
    const organizationId = actor.role === 'maintenance_coordinator' ? actor.organizationId : 'org-repair'
    return clone(this.engineerCandidatesForOrganization(organizationId))
  }

  async listFacilityDispatchers(): Promise<Array<Pick<User, 'id' | 'displayName'>>> {
    const actor = this.actor()
    this.requireCapability(actor, 'facility.dispatcher.assign')
    return Object.values(this.state.users)
      .filter((user) => user.role === 'facility_dispatcher')
      .filter((user) =>
        !Object.values(this.state.facilityAssignments).some(
          (assignment) =>
            assignment.dispatcherId === user.id &&
            assignment.status === 'active' &&
            Date.parse(assignment.startsAt) <= Date.parse(this.state.demoClockIso) &&
            Date.parse(this.state.demoClockIso) < Date.parse(assignment.endsAt),
        ),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru-RU'))
      .map(({ id, displayName }) => ({ id, displayName }))
  }

  async assignFacilityDispatcher(
    command: AssignFacilityDispatcherCommand,
  ): Promise<AssignFacilityDispatcherResponse> {
    return this.withMutationLock(() => this.assignFacilityDispatcherUnlocked(command))
  }

  private async assignFacilityDispatcherUnlocked(
    command: AssignFacilityDispatcherCommand,
  ): Promise<AssignFacilityDispatcherResponse> {
    const currentActor = this.actor()
    this.requireCapability(currentActor, 'facility.dispatcher.assign')
    this.requireFacilityAccess(this.state, currentActor, command.facilityId)
    const idempotencyContext = {
      actorId: currentActor.id,
      resourceId: command.facilityId,
      operation: 'assign_dispatcher',
      fingerprint: await requestFingerprint({
        dispatcherId: command.dispatcherId,
        startsAt: command.startsAt,
        endsAt: command.endsAt,
        expectedVersion: command.expectedVersion,
      }),
    }
    this.assertActorUnchanged(currentActor.id)
    const replay = this.getIdempotent<AssignFacilityDispatcherResponse>(
      this.state,
      command.idempotencyKey,
      'dispatcher_assignment',
      idempotencyContext,
    )
    if (replay) return replay

    const next = clone(this.state)
    const actor = this.actor(next)
    this.requireCapability(actor, 'facility.dispatcher.assign')
    const facility = this.requireFacilityAccess(next, actor, command.facilityId)
    if (facility.version !== command.expectedVersion) {
      throw new RepositoryError('VERSION_CONFLICT', 'Объект был изменён другим пользователем', {
        currentVersion: facility.version,
      })
    }
    const dispatcher = next.users[command.dispatcherId]
    if (!dispatcher || dispatcher.role !== 'facility_dispatcher') {
      throw new RepositoryError('VALIDATION_ERROR', 'Выбранный сотрудник не является диспетчером объекта')
    }
    const startsAt = Date.parse(command.startsAt)
    const endsAt = Date.parse(command.endsAt)
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
      throw new RepositoryError('VALIDATION_ERROR', 'Начало и окончание смены должны быть корректными датами')
    }
    if (endsAt <= startsAt) {
      throw new RepositoryError('VALIDATION_ERROR', 'Окончание смены должно быть позже начала')
    }
    if (endsAt < Date.parse(next.demoClockIso)) {
      throw new RepositoryError('VALIDATION_ERROR', 'Нельзя назначить уже завершившуюся смену')
    }
    const overlaps = Object.values(next.facilityAssignments).some((assignment) => {
      if (!['scheduled', 'active'].includes(assignment.status)) return false
      const timeOverlaps =
        Date.parse(assignment.startsAt) < Date.parse(command.endsAt) &&
        Date.parse(command.startsAt) < Date.parse(assignment.endsAt)
      return (
        timeOverlaps &&
        (assignment.facilityId === command.facilityId || assignment.dispatcherId === command.dispatcherId)
      )
    })
    if (overlaps) {
      throw new RepositoryError(
        'VALIDATION_ERROR',
        'На выбранное время объект или диспетчер уже имеют активное назначение',
      )
    }

    const beforeVersion = facility.version
    const assignmentId = this.nextId(next, 'dispatcher-assignment')
    const activeNow =
      Date.parse(command.startsAt) <= Date.parse(next.demoClockIso) &&
      Date.parse(next.demoClockIso) < Date.parse(command.endsAt)
    const assignment: FacilityAssignment = {
      id: assignmentId,
      facilityId: command.facilityId,
      dispatcherId: command.dispatcherId,
      startsAt: command.startsAt,
      endsAt: command.endsAt,
      status: activeNow ? 'active' : 'scheduled',
      assignedBy: userRef(actor),
      version: 1,
    }
    next.facilityAssignments[assignmentId] = assignment
    if (activeNow) facility.responsibleDispatcherId = dispatcher.id
    facility.version += 1
    facility.updatedAt = next.demoClockIso
    if (activeNow) {
      dispatcher.scope.facilityIds = [facility.id]
      dispatcher.scope.operationalUnitIds = [facility.operationalUnitId]
      dispatcher.homeRoute = `/facilities/${facility.id}`
    }

    const audit = this.createAudit(
      next,
      'facility',
      facility.id,
      'assign_dispatcher',
      actor,
      beforeVersion,
      facility.version,
      null,
      { assignmentId, dispatcherId: dispatcher.id, startsAt: command.startsAt, endsAt: command.endsAt },
    )
    const response: AssignFacilityDispatcherResponse = {
      assignment: clone(assignment),
      facility: clone(facility),
      auditEventId: audit.id,
    }
    this.saveIdempotent(next, command.idempotencyKey, 'dispatcher_assignment', idempotencyContext, response)
    this.commit(next)
    return response
  }

  async listNotifications(): Promise<Notification[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'notification.read')
    return Object.values(this.state.notifications)
      .filter((notification) => notification.userId === actor.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(clone)
  }

  async markNotificationRead(notificationId: string): Promise<Notification> {
    return this.withMutationLock(() => this.markNotificationReadUnlocked(notificationId))
  }

  private async markNotificationReadUnlocked(notificationId: string): Promise<Notification> {
    const next = clone(this.state)
    const actor = this.actor(next)
    this.requireCapability(actor, 'notification.read')
    const notification = next.notifications[notificationId]
    if (!notification) throw new RepositoryError('NOT_FOUND', 'Уведомление не найдено')
    if (notification.userId !== actor.id) {
      throw new RepositoryError('FORBIDDEN', 'Уведомление принадлежит другому пользователю')
    }
    if (!notification.readAt) {
      notification.readAt = next.demoClockIso
      this.commit(next)
    }
    return clone(notification)
  }

  async getAuditTimeline(entityType: string, entityId: string): Promise<AuditEvent[]> {
    const actor = this.actor()
    this.requireCapability(actor, 'audit.read')
    if (entityType === 'work_order') {
      const order = this.state.workOrders[entityId]
      if (!order) throw new RepositoryError('NOT_FOUND', 'Заявка не найдена')
      if (!canAccessWorkOrder(this.state, actor, order)) {
        throw new RepositoryError('FORBIDDEN', 'История недоступна')
      }
    } else if (entityType === 'facility') {
      this.requireFacilityAccess(this.state, actor, entityId)
    } else if (entityType === 'risk') {
      const risk = this.state.risks[entityId]
      if (!risk) throw new RepositoryError('NOT_FOUND', 'Прогноз риска не найден')
      this.requireFacilityAccess(this.state, actor, risk.facilityId)
    } else if (entityType === 'incident') {
      const incident = this.state.incidents[entityId]
      if (!incident) throw new RepositoryError('NOT_FOUND', 'Инцидент не найден')
      this.requireFacilityAccess(this.state, actor, incident.facilityId)
    } else if (entityType === 'sensor') {
      const sensor = this.state.sensors[entityId]
      if (!sensor) throw new RepositoryError('NOT_FOUND', 'Датчик не найден')
      this.requireFacilityAccess(this.state, actor, sensor.facilityId)
    } else if (entityType === 'equipment') {
      const equipment = this.state.equipment[entityId]
      if (!equipment) throw new RepositoryError('NOT_FOUND', 'Оборудование не найдено')
      this.requireFacilityAccess(this.state, actor, equipment.facilityId)
    } else {
      throw new RepositoryError('VALIDATION_ERROR', 'Тип сущности не поддерживается журналом аудита')
    }
    return Object.values(this.state.auditEvents)
      .filter((event) => event.entityType === entityType && event.entityId === entityId)
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
      .map(clone)
  }

  async getDashboardMetrics() {
    const actor = this.actor()
    const mayReadAnalytics =
      hasCapability(actor, 'analytics.city.read') || hasCapability(actor, 'analytics.facility.read')
    if (!mayReadAnalytics) {
      throw new RepositoryError('FORBIDDEN', 'Аналитика недоступна для текущей роли')
    }
    return clone(selectDashboardMetrics(this.state, actor))
  }
}

export function createMockContourRepository(
  options: MockContourRepositoryOptions = {},
): MockContourRepository {
  return new MockContourRepository(options)
}
