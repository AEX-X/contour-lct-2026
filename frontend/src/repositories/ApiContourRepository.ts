import type { z } from 'zod'
import type {
  AuditEvent,
  Capability,
  CreateWorkOrderInput,
  CurrentUser,
  DashboardMetric,
  DataProvenance,
  DemoRole,
  Equipment,
  Facility,
  FacilityStatus,
  HierarchyNode,
  HierarchyNodeType,
  Incident,
  MutationMeta,
  Notification,
  RepositorySnapshot,
  RiskDecisionCommand,
  RiskForecast,
  RiskSeverity,
  Sensor,
  SensorKind,
  SensorStatus,
  User,
  WorkOrder,
  WorkOrderActionCommand,
  WorkOrderActionResponse,
  WorkOrderPriority,
  WorkOrderStatus,
  WorkOrderTarget,
} from '../domain'
import { RepositoryError } from '../domain'
import { ContourApiClient, type FetchLike } from '../api/ContourApiClient'
import {
  auditListSchema,
  eventListSchema,
  facilityListSchema,
  facilitySchema,
  hierarchySchema,
  layoutSchema,
  meSchema,
  riskListSchema,
  riskSchema,
  sensorDetailSchema,
  sensorListSchema,
  sensorSeriesSchema,
  workOrderListSchema,
  workOrderSchema,
  type ApiAuditEntry,
  type ApiEvent,
  type ApiFacility,
  type ApiHierarchyNode,
  type ApiLayout,
  type ApiRisk,
  type ApiSensorDetail,
  type ApiSensorListItem,
  type ApiSensorSeries,
  type ApiWorkOrder,
} from '../api/schemas'
import type {
  AssignFacilityDispatcherCommand,
  AssignFacilityDispatcherResponse,
} from '../domain'
import type {
  ContourRepository,
  EngineerCandidate,
  FacilityListParams,
  RepositoryAuthCredentials,
  RepositoryChange,
  RiskListParams,
  StorageLike,
  WorkOrderListParams,
} from './ContourRepository'

type ApiMe = z.infer<typeof meSchema>

const apiOrganization = {
  id: 'org-moscollector-api',
  displayName: 'АО «Москоллектор»',
  type: 'moscollector' as const,
}

const riskTypeLabels: Record<string, string> = {
  sensor_failure: 'Риск отказа датчика или оборудования',
  fire: 'Риск пожара или задымления',
  flooding: 'Риск подтопления',
  unauthorized_access: 'Риск несанкционированного доступа',
}

const capabilityMap: Record<string, Capability[]> = {
  'facility.read.all': ['facility.read.all', 'facility.technical_context.read'],
  'facility.read.assigned': ['facility.read.assigned', 'facility.technical_context.read'],
  'sensor.read': ['facility.technical_context.read'],
  'risk.read': ['risk.read'],
  'risk.acknowledge': ['risk.acknowledge'],
  'risk.resolve': ['risk.reject', 'risk.defer'],
  'work_order.read': ['work_order.read'],
  'work_order.create_draft': ['work_order.create'],
  'audit.read': ['audit.read'],
}

function apiProvenance(
  origin: DataProvenance['origin'],
  sourceLabel: string,
  asOf: string | null,
  note?: string,
): DataProvenance {
  return {
    origin,
    environment: 'synthetic_demo',
    sourceLabel,
    asOf,
    note,
  }
}

function mapRole(role: string): DemoRole {
  if (role === 'manager') return 'manager'
  if (role === 'dispatcher') return 'facility_dispatcher'
  if (role === 'senior_dispatcher') return 'senior_dispatcher'
  if (role === 'maintenance_coordinator') return 'maintenance_coordinator'
  if (role === 'engineer') return 'engineer'
  throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неподдерживаемую роль: ${role}`)
}

function homeRoute(role: DemoRole) {
  if (role === 'manager') return '/city'
  if (role === 'senior_dispatcher') return '/operations'
  if (role === 'facility_dispatcher') return '/my-facility'
  if (role === 'maintenance_coordinator') return '/maintenance/queue'
  return '/my-work'
}

function mapPermissions(me: ApiMe, role: DemoRole): Capability[] {
  const capabilities = new Set<Capability>()
  me.permissions.forEach((permission) => {
    capabilityMap[permission]?.forEach((capability) => capabilities.add(capability))
  })

  if (role === 'manager') {
    ;[
      'city.read',
      'operations.read',
      'facility.read.all',
      'facility.technical_context.read',
      'incident.read',
      'analytics.city.read',
      'analytics.facility.read',
      'analytics.management.read',
      'analytics.technical.read',
      'report.export',
    ].forEach((capability) => capabilities.add(capability as Capability))
  }
  if (role === 'senior_dispatcher') {
    capabilities.add('operations.read')
    capabilities.add('facility.read.unit')
    capabilities.add('incident.read')
    capabilities.add('analytics.facility.read')
  }
  if (role === 'facility_dispatcher') {
    capabilities.add('facility.read.assigned')
    capabilities.add('facility.technical_context.read')
    capabilities.add('incident.read')
    capabilities.add('analytics.facility.read')
  }
  return [...capabilities]
}

function mapCurrentUser(me: ApiMe): CurrentUser {
  const facilityIds = me.scope.facility_ids ?? []
  const backendRole = mapRole(me.role)
  const role = backendRole === 'facility_dispatcher' && facilityIds.length > 1
    ? 'senior_dispatcher'
    : backendRole
  const scopeType = me.scope.type === 'all_facilities'
    ? 'all_facilities'
    : facilityIds.length <= 1
      ? 'single_facility'
      : 'operational_unit'
  return {
    id: `api-${me.role}`,
    displayName: role === 'manager'
      ? 'Руководитель'
      : role === 'senior_dispatcher'
        ? 'Районный диспетчер'
        : role === 'facility_dispatcher'
          ? 'Диспетчер объекта'
          : role === 'maintenance_coordinator'
            ? 'Координатор ремонтов'
            : 'Инженер',
    role,
    organizationId: apiOrganization.id,
    organization: apiOrganization,
    permissions: mapPermissions(me, role),
    scope: {
      type: scopeType,
      operationalUnitIds: [],
      facilityIds,
    },
    homeRoute: homeRoute(role),
    timezone: me.timezone === 'Europe/Moscow' ? me.timezone : 'Europe/Moscow',
    locale: me.locale === 'ru-RU' ? me.locale : 'ru-RU',
    activeAccessGrants: [],
  }
}

function mapFacilityStatus(value: string, freshness: string): FacilityStatus {
  if (freshness === 'unavailable') return 'no_data'
  if (['critical', 'alarm', 'emergency'].includes(value)) return 'critical'
  if (['attention', 'warning', 'fault'].includes(value)) return 'attention'
  if (['normal', 'ok'].includes(value)) return 'normal'
  return 'no_data'
}

function facilityStatusReason(item: ApiFacility) {
  if (item.forecast.active_count > 0 && ['high', 'critical'].includes(item.forecast.risk_level)) {
    return `${item.forecast.active_count} активных прогнозов, максимальный риск ${Math.round(item.forecast.max_probability * 100)}%`
  }
  if (item.data_health.freshness !== 'fresh') {
    return `Состояние данных: ${item.data_health.freshness}`
  }
  if (item.current_state === 'unknown') return 'Текущее состояние не рассчитано backend'
  return `Состояние backend: ${item.current_state}`
}

function mapFacility(item: ApiFacility): Facility {
  return {
    id: item.id,
    version: 1,
    name: item.display_name,
    address: 'Адрес не предоставлен в API',
    internalCode: item.id,
    rostaCode: null,
    operationalUnitId: 'api-scope',
    status: mapFacilityStatus(item.current_state, item.data_health.freshness),
    statusReason: facilityStatusReason(item),
    position: {
      lon: item.location.coordinates[0],
      lat: item.location.coordinates[1],
    },
    responsibleDispatcherId: null,
    sensorAvailability: Number.isFinite(item.data_health.coverage)
      ? Math.max(0, Math.min(1, item.data_health.coverage))
      : null,
    updatedAt: item.updated_at,
    provenance: apiProvenance(
      'observed',
      'Backend Contour: реестр объектов',
      item.updated_at,
      item.location.is_demo
        ? 'Показатели получены через API, координаты являются демонстрационными'
        : undefined,
    ),
  }
}

function mapHierarchyType(value: string): HierarchyNodeType {
  if (['building', 'collector', 'section', 'room', 'equipment', 'sensor'].includes(value)) {
    return value as HierarchyNodeType
  }
  if (value === 'facility') return 'building'
  return 'section'
}

function normalizeLayout(layout: ApiLayout) {
  const coordinates = layout.features.map((feature) => feature.geometry.coordinates)
  const maxX = Math.max(1, ...coordinates.map(([x]) => x))
  const maxY = Math.max(1, ...coordinates.map(([, y]) => y))
  return new Map(layout.features.map((feature) => {
    const [x, y] = feature.geometry.coordinates
    return [feature.properties.id, {
      x: 10 + (x / maxX) * 80,
      y: 15 + (y / maxY) * 70,
    }]
  }))
}

function mapHierarchyNode(
  item: ApiHierarchyNode,
  facilityId: string,
  positions: Map<string, { x: number; y: number }>,
): HierarchyNode {
  const position = positions.get(item.id)
  return {
    id: item.id,
    facilityId,
    parentId: item.parent_id,
    entityType: mapHierarchyType(item.entity_type),
    entityId: item.entity_id || null,
    displayName: item.display_name,
    path: item.path,
    planPosition: position ? {
      planId: `api-layout-${facilityId}`,
      x: position.x,
      y: position.y,
      level: item.path.length ? String(item.path.length - 1) : null,
    } : null,
    provenance: apiProvenance(
      'derived',
      'Backend Contour: демонстрационная схема',
      null,
      'Координаты схемы созданы backend и не являются реальной топологией коллектора',
    ),
  }
}

function mapSensorKind(sensorType: string): SensorKind {
  if (sensorType === 'temperature_sensor') return 'temperature'
  if (sensorType === 'smoke_detector' || sensorType === 'heat_detector') return 'smoke'
  if (sensorType === 'gas_sensor') return 'gas'
  if (sensorType === 'flood_sensor') return 'water_level'
  if (['motion_detector', 'security_state', 'glass_break_sensor'].includes(sensorType)) return 'volume'
  return 'contact'
}

function mapSensorStatus(value: string): SensorStatus {
  if (value === 'alarm') return 'alarm'
  if (['warning', 'fault', 'maintenance'].includes(value)) return 'attention'
  if (['offline', 'disabled', 'unknown'].includes(value)) return 'offline'
  return 'normal'
}

function mapQuality(value: string): 'good' | 'uncertain' | 'bad' {
  if (value === 'good') return 'good'
  if (['bad', 'invalid'].includes(value)) return 'bad'
  return 'uncertain'
}

function mapSensor(
  item: ApiSensorListItem,
  detail?: ApiSensorDetail,
  series?: ApiSensorSeries,
): Sensor {
  const numericSeries = series?.value_type === 'numeric' ? series : null
  const warningThreshold = numericSeries?.thresholds.find((item) => item.kind === 'warning')?.value ?? null
  const alarmThreshold = numericSeries?.thresholds.find((item) => item.kind === 'alarm')?.value ?? null
  const currentReading = detail?.current_reading?.numeric_value === null || detail?.current_reading === null
    ? null
    : detail?.current_reading
      ? {
          at: detail.current_reading.measured_at,
          value: detail.current_reading.numeric_value,
          quality: detail.data_health === 'fresh' ? 'good' as const : 'uncertain' as const,
        }
      : null
  return {
    id: item.id,
    version: 1,
    facilityId: item.facility_id ?? 'unassigned',
    hierarchyNodeId: item.hierarchy_node_id ?? `sensor-node-${item.id}`,
    equipmentId: null,
    name: item.display_name,
    kind: mapSensorKind(item.sensor_type),
    unit: detail?.current_reading?.unit ?? '',
    status: mapSensorStatus(detail?.current_state ?? 'unknown'),
    lastReading: currentReading,
    warningThreshold,
    alarmThreshold,
    readings: numericSeries?.points.map((point) => ({
      at: point.timestamp,
      value: point.value,
      quality: mapQuality(point.quality),
    })) ?? [],
    updatedAt: detail?.current_reading?.measured_at ?? new Date(0).toISOString(),
    provenance: apiProvenance(
      'observed',
      'Backend Contour: СМВУ',
      detail?.current_reading?.measured_at ?? null,
      detail ? undefined : 'Карточка датчика не была загружена, показано состояние без телеметрии',
    ),
  }
}

function mapRiskSeverity(value: string): RiskSeverity {
  if (['low', 'medium', 'high', 'critical'].includes(value)) return value as RiskSeverity
  return 'medium'
}

function mapRiskStatus(value: string): RiskForecast['status'] {
  if (value === 'acknowledged') return 'acknowledged'
  if (value === 'rejected') return 'rejected'
  if (value === 'deferred') return 'deferred'
  if (value === 'resolved') return 'resolved'
  return 'new'
}

function mapTargetType(value: string): WorkOrderTarget['type'] {
  if (value === 'hierarchy_node') return 'section'
  if (['facility', 'building', 'collector', 'section', 'equipment', 'sensor'].includes(value)) {
    return value as WorkOrderTarget['type']
  }
  return 'facility'
}

function mapTargetTypeToApi(value: WorkOrderTarget['type']) {
  if (value === 'facility' || value === 'sensor') return value
  return 'hierarchy_node'
}

function mapPriorityToApi(value: WorkOrderPriority) {
  return {
    P1: 'critical',
    P2: 'high',
    P3: 'medium',
    P4: 'low',
  }[value]
}

function mapRisk(item: ApiRisk): RiskForecast {
  const facilityId = item.target.facility_id ?? (item.target.type === 'facility' ? item.target.id : 'unassigned')
  const status = mapRiskStatus(item.decision_status)
  return {
    id: item.id,
    version: item.version,
    facilityId,
    target: {
      type: mapTargetType(item.target.type),
      id: item.target.id,
      facilityId,
      displayName: item.target.type === 'facility' ? 'Объект' : `Канал ${item.target.id}`,
      hierarchyPath: [],
      locationSnapshot: { text: null, geo: null, planPosition: null },
    },
    predictedEvent: riskTypeLabels[item.risk_type] ?? item.risk_type,
    probability: item.probability,
    severity: mapRiskSeverity(item.risk_level),
    horizonHours: item.horizon_hours,
    status,
    topFactors: item.top_factors.map((label) => ({
      label,
      contribution: null,
      direction: 'up' as const,
    })),
    recommendation: item.recommendation,
    createdAt: item.created_at,
    expiresAt: item.prediction_window.end,
    decidedAt: status === 'new' ? null : item.updated_at,
    decidedBy: null,
    provenance: apiProvenance(
      'model_output',
      `ML через backend: ${item.model}`,
      item.as_of,
      'Backend передаёт названия факторов без числовых SHAP-вкладов',
    ),
  }
}

function mapIncident(item: ApiEvent): Incident {
  const state = item.state.toLowerCase()
  const severity: RiskSeverity = state.includes('alarm')
    ? 'critical'
    : state.includes('warning') || state.includes('fault')
      ? 'high'
      : 'medium'
  const facilityId = item.facility_id ?? 'unassigned'
  return {
    id: item.id,
    version: 1,
    facilityId,
    target: {
      type: 'sensor',
      id: item.sensor_id,
      facilityId,
      displayName: `Канал ${item.sensor_id}`,
      hierarchyPath: [],
      locationSnapshot: { text: null, geo: null, planPosition: null },
    },
    sourceRiskId: item.related_risk_id,
    title: `Подтверждённое событие: ${item.event_type}`,
    description: `${item.state}: ${item.value}`,
    severity,
    status: item.resolved_at ? 'resolved' : 'open',
    confirmedAt: item.occurred_at,
    confirmedBy: { id: 'backend-system', displayName: 'Журнал ОДС' },
    resolvedAt: item.resolved_at,
    failureEpisodeId: null,
    provenance: apiProvenance('observed', `Backend Contour: ${item.source}`, item.ingested_at),
  }
}

function mapPriority(value: string): WorkOrderPriority {
  const normalized = value.toUpperCase()
  if (['P1', 'P2', 'P3', 'P4'].includes(normalized)) return normalized as WorkOrderPriority
  if (value === 'critical') return 'P1'
  if (value === 'high') return 'P2'
  if (value === 'medium') return 'P3'
  return 'P4'
}

function mapWorkOrderStatus(value: string): WorkOrderStatus {
  if (value === 'ready') return 'triage'
  if (value === 'assigned') return 'assigned'
  if (value === 'in_progress') return 'in_progress'
  if (value === 'completed') return 'completed_by_engineer'
  if (value === 'cancelled' || value === 'integration_error') return 'cancelled'
  return 'draft'
}

function mapWorkOrder(item: ApiWorkOrder, facility?: Facility): WorkOrder {
  const now = new Date().toISOString()
  const status = mapWorkOrderStatus(item.status)
  const dueTimestamp = Date.parse(item.due_at)
  const closed = ['completed_by_engineer', 'closed', 'cancelled'].includes(status)
  const targetType = mapTargetType(item.target_entity_type)
  const target: WorkOrderTarget = {
    type: targetType,
    id: item.target_entity_id,
    facilityId: item.facility_id ?? 'unassigned',
    displayName: targetType === 'facility' && facility
      ? facility.name
      : `${item.target_entity_type}: ${item.target_entity_id}`,
    hierarchyPath: [],
    locationSnapshot: {
      text: facility?.address ?? null,
      geo: facility?.position ?? null,
      planPosition: null,
    },
  }
  return {
    id: item.id,
    number: item.display_number,
    version: item.version,
    status,
    source: item.source_risk_id
      ? { type: 'risk', id: item.source_risk_id }
      : { type: 'manual', id: null },
    target,
    affectedTargets: [],
    snapshot: {
      capturedAt: item.created_at,
      facilityName: facility?.name ?? item.facility_id ?? 'Объект не указан',
      sensorReadings: [],
      note: 'Снимок телеметрии не входит в текущий контракт backend заявки',
    },
    categoryCode: item.work_type,
    symptoms: item.comment ? [item.comment] : [],
    description: item.description,
    systemRecommendation: null,
    preliminaryPriority: mapPriority(item.priority),
    finalPriority: mapPriority(item.priority),
    prioritySource: 'system',
    sla: {
      policyId: 'backend-due-at',
      startedAt: item.created_at,
      acceptanceDueAt: null,
      arrivalDueAt: null,
      resolutionDueAt: item.due_at,
      currentStage: closed ? 'completed' : 'resolution',
      state: closed ? 'completed' : dueTimestamp < Date.now() ? 'breached' : 'on_track',
      pausedAt: null,
      pauseReason: null,
      breachStage: !closed && dueTimestamp < Date.now() ? 'resolution' : null,
      remainingSeconds: closed ? 0 : Math.max(0, Math.round((dueTimestamp - Date.now()) / 1000)),
      serverTime: now,
    },
    creator: { id: item.created_by, displayName: item.created_by },
    responsibleDispatcher: null,
    coordinator: null,
    maintenanceOrganizationId: 'not-provided',
    currentAssignment: null,
    accessGrant: null,
    repairResult: null,
    estimatedCost: null,
    actualCost: null,
    duplicateOfWorkOrderId: null,
    recurrenceOfWorkOrderId: null,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    closedAt: item.status === 'completed' ? item.updated_at : null,
    provenance: apiProvenance(
      'manual',
      'Backend Contour: заявки',
      item.updated_at,
      'Текущий backend автоматически меняет статус заявки по времени',
    ),
    allowedActions: [],
  }
}

function mapAuditEntry(item: ApiAuditEntry, role: DemoRole): AuditEvent {
  return {
    id: String(item.id),
    entityType: item.target_type ?? 'request',
    entityId: item.target_id ?? item.trace_id,
    action: item.action,
    actor: {
      id: item.user_id ?? 'anonymous',
      displayName: item.username ?? 'Неавторизованный пользователь',
    },
    actorRole: role,
    occurredAt: item.occurred_at,
    reason: item.result === 'success' ? null : item.result,
    beforeVersion: null,
    afterVersion: null,
    metadata: {
      statusCode: item.status_code,
      traceId: item.trace_id,
      ...(item.details ?? {}),
    },
    provenance: apiProvenance('observed', 'Backend Contour: append-only аудит', item.occurred_at),
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

export interface ApiContourRepositoryOptions {
  baseUrl: string
  fetcher?: FetchLike
  storage?: StorageLike
}

export class ApiContourRepository implements ContourRepository {
  private readonly client: ContourApiClient
  private currentUser: CurrentUser | null = null
  private snapshot: RepositorySnapshot = {
    scenarioId: 'backend-api',
    revision: 1,
    activeUserId: 'anonymous',
    demoClockIso: new Date().toISOString(),
  }
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>()

  constructor(options: ApiContourRepositoryOptions) {
    this.client = new ContourApiClient(options)
  }

  getRuntimeInfo() {
    return {
      mode: 'api' as const,
      label: 'Интеграционный контур',
      description: 'Данные мониторинга загружаются из FastAPI backend',
      apiBaseUrl: this.client.baseUrl,
      supportsDemoRoleSwitch: false,
      supportsDemoReset: false,
      supportsOfflineSimulation: false,
    }
  }

  getSnapshot() {
    return { ...this.snapshot, demoClockIso: new Date().toISOString() }
  }

  subscribe(_listener: (change: RepositoryChange) => void) {
    return () => undefined
  }

  async login(credentials: RepositoryAuthCredentials) {
    await this.client.login(credentials)
    this.clearCache()
    return this.getCurrentUser()
  }

  async logout() {
    await this.client.logout()
    this.currentUser = null
    this.clearCache()
  }

  async getCurrentUser() {
    const me = await this.client.get('/me', meSchema)
    this.currentUser = mapCurrentUser(me)
    this.snapshot = {
      ...this.snapshot,
      activeUserId: this.currentUser.id,
      revision: this.snapshot.revision + 1,
      demoClockIso: new Date().toISOString(),
    }
    return this.currentUser
  }

  async listDemoProfiles(): Promise<User[]> {
    const user = this.currentUser ?? await this.getCurrentUser()
    return [user]
  }

  async switchDemoUser(_userId: string): Promise<CurrentUser> {
    throw new RepositoryError('FORBIDDEN', 'В API-режиме роль определяется backend-сессией')
  }

  async reset(): Promise<RepositorySnapshot> {
    throw new RepositoryError('FORBIDDEN', 'Сброс сценария доступен только в автономном демо-режиме')
  }

  async advanceDemoClock(_minutes: number): Promise<RepositorySnapshot> {
    throw new RepositoryError('FORBIDDEN', 'Управление временем недоступно в API-режиме')
  }

  async listFacilities(params: FacilityListParams = {}) {
    const cacheKey = `facilities:${params.query ?? ''}`
    const facilities = await this.cached(cacheKey, async () => {
      const items = await this.listAll((cursor) => this.client.get('/facilities', facilityListSchema, {
        query: params.query,
        cursor,
        limit: 200,
      }))
      return items.map(mapFacility)
    })
    return facilities.filter((facility) => {
      if (params.status && params.status !== 'all' && facility.status !== params.status) return false
      if (params.operationalUnitId && facility.operationalUnitId !== params.operationalUnitId) return false
      return true
    })
  }

  async getFacility(facilityId: string) {
    return this.cached(`facility:${facilityId}`, async () => mapFacility(
      await this.client.get(`/facilities/${encodeURIComponent(facilityId)}`, facilitySchema),
    ))
  }

  async getFacilityHierarchy(facilityId: string) {
    return this.cached(`hierarchy:${facilityId}`, async () => {
      const [nodes, layout] = await Promise.all([
        this.client.get(`/facilities/${encodeURIComponent(facilityId)}/hierarchy`, hierarchySchema),
        this.client.get(`/facilities/${encodeURIComponent(facilityId)}/layout`, layoutSchema),
      ])
      const positions = normalizeLayout(layout)
      return nodes.map((node) => mapHierarchyNode(node, facilityId, positions))
    })
  }

  async listEquipment(facilityId: string): Promise<Equipment[]> {
    const hierarchy = await this.getFacilityHierarchy(facilityId)
    return hierarchy
      .filter((node) => node.entityType === 'equipment')
      .map((node) => ({
        id: node.entityId ?? node.id,
        version: 1,
        facilityId,
        hierarchyNodeId: node.id,
        name: node.displayName,
        categoryCode: 'equipment',
        model: null,
        serialNumber: null,
        commissionedAt: null,
        status: 'unknown',
        lastMaintenanceAt: null,
        provenance: apiProvenance(
          'derived',
          'Backend Contour: иерархия объекта',
          null,
          'Подробный реестр оборудования не опубликован отдельным API endpoint',
        ),
      }))
  }

  async listSensors(facilityId: string) {
    return this.cached(`sensors:${facilityId}`, async () => {
      const items = await this.listAll((cursor) => this.client.get('/sensors', sensorListSchema, {
        facility_id: facilityId,
        cursor,
        limit: 200,
      }))
      const hydratedLimit = Math.min(items.length, 48)
      const hydrated = await mapWithConcurrency(items.slice(0, hydratedLimit), 6, async (item) => {
        const detail = await this.client.get(`/sensors/${encodeURIComponent(item.id)}`, sensorDetailSchema)
        let series: ApiSensorSeries | undefined
        if (detail.value_type === 'numeric' && detail.current_reading) {
          const measuredAt = new Date(detail.current_reading.measured_at)
          const from = new Date(measuredAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
          series = await this.client.get(`/sensors/${encodeURIComponent(item.id)}/series`, sensorSeriesSchema, {
            from,
            to: detail.current_reading.measured_at,
            granularity: '1h',
          })
        }
        return mapSensor(item, detail, series)
      })
      return [
        ...hydrated,
        ...items.slice(hydratedLimit).map((item) => mapSensor(item)),
      ]
    }, 30_000)
  }

  async listRisks(params: RiskListParams = {}) {
    const risks = await this.cached(`risks:${params.facilityId ?? 'all'}`, async () => {
      const items = await this.listAll((cursor) => this.client.get('/risks', riskListSchema, {
        facility_id: params.facilityId,
        cursor,
        limit: 200,
      }))
      return items.map(mapRisk)
    })
    const severities = params.severity
      ? new Set(Array.isArray(params.severity) ? params.severity : [params.severity])
      : null
    const statuses = params.status
      ? new Set(Array.isArray(params.status) ? params.status : [params.status])
      : null
    return risks.filter((risk) => (!severities || severities.has(risk.severity)) && (!statuses || statuses.has(risk.status)))
  }

  async getRisk(riskId: string) {
    return mapRisk(await this.client.get(`/risks/${encodeURIComponent(riskId)}`, riskSchema))
  }

  async acknowledgeRisk(riskId: string, command: RiskDecisionCommand) {
    const updated = await this.client.post(
      `/risks/${encodeURIComponent(riskId)}/acknowledge`,
      riskSchema,
      { expected_version: command.expectedVersion },
    )
    this.clearCache('risks:')
    return mapRisk(updated)
  }

  async confirmRisk(
    _riskId: string,
    _command: RiskDecisionCommand,
  ): Promise<{ risk: RiskForecast; incident: Incident; auditEventId: string }> {
    throw new RepositoryError(
      'SOURCE_UNAVAILABLE',
      'Backend умеет принять прогноз в работу, но не регистрирует подтверждённый инцидент. Нужен отдельный согласованный endpoint',
    )
  }

  async listIncidents(facilityId?: string) {
    return this.cached(`incidents:${facilityId ?? 'all'}`, async () => {
      const events = await this.listAll((cursor) => this.client.get('/events', eventListSchema, {
        facility_id: facilityId,
        cursor,
        limit: 200,
      }))
      return events.filter((event) => event.is_confirmed_incident).map(mapIncident)
    })
  }

  async listWorkOrders(params: WorkOrderListParams = {}) {
    if (params.assignedToCurrentUser) return []
    const [items, facilities] = await Promise.all([
      this.cached(`work-orders:${params.facilityId ?? 'all'}`, () => this.listAll((cursor) => this.client.get('/work-orders', workOrderListSchema, {
        facility_id: params.facilityId,
        cursor,
        limit: 200,
      }))),
      this.listFacilities(),
    ])
    const facilityById = new Map(facilities.map((facility) => [facility.id, facility]))
    const orders = items.map((item) => mapWorkOrder(item, item.facility_id ? facilityById.get(item.facility_id) : undefined))
    const statuses = params.status
      ? new Set(Array.isArray(params.status) ? params.status : [params.status])
      : null
    return orders.filter((order) => !statuses || statuses.has(order.status))
  }

  async getWorkOrder(workOrderId: string) {
    const order = (await this.listWorkOrders()).find((item) => item.id === workOrderId)
    if (!order) throw new RepositoryError('NOT_FOUND', 'Заявка не найдена')
    return order
  }

  async createWorkOrder(input: CreateWorkOrderInput, _meta: MutationMeta) {
    const priority = input.preliminaryPriority ?? 'P3'
    const dueHours = { P1: 0.25, P2: 1, P3: 4, P4: 24 }[priority]
    const created = await this.client.post('/work-orders', workOrderSchema, {
      mode: 'draft',
      source_risk_id: input.source.type === 'risk' ? input.source.id : null,
      facility_id: input.target.facilityId,
      target_entity_type: mapTargetTypeToApi(input.target.type),
      target_entity_id: input.target.id,
      work_type: ['inspection', 'repair', 'replacement', 'maintenance'].includes(input.categoryCode)
        ? input.categoryCode
        : 'inspection',
      priority: mapPriorityToApi(priority),
      due_at: new Date(Date.now() + dueHours * 60 * 60 * 1000).toISOString(),
      description: input.description,
      comment: input.symptoms.length ? input.symptoms.join(', ') : null,
    })
    this.clearCache('work-orders:')
    const facility = await this.getFacility(input.target.facilityId).catch(() => undefined)
    return mapWorkOrder(created, facility)
  }

  async performWorkOrderAction(
    _workOrderId: string,
    _command: WorkOrderActionCommand,
  ): Promise<WorkOrderActionResponse> {
    throw new RepositoryError(
      'SOURCE_UNAVAILABLE',
      'Текущий backend не предоставляет ручные переходы заявки. Карточка доступна только для просмотра',
    )
  }

  async listEngineerCandidates(_workOrderId: string): Promise<EngineerCandidate[]> {
    return []
  }

  async listMaintenanceEngineers(): Promise<EngineerCandidate[]> {
    return []
  }

  async listFacilityDispatchers(): Promise<Array<Pick<User, 'id' | 'displayName'>>> {
    return []
  }

  async assignFacilityDispatcher(_command: AssignFacilityDispatcherCommand): Promise<AssignFacilityDispatcherResponse> {
    throw new RepositoryError('SOURCE_UNAVAILABLE', 'Backend не предоставляет управление назначениями диспетчеров')
  }

  async listNotifications(): Promise<Notification[]> {
    return []
  }

  async markNotificationRead(_notificationId: string): Promise<Notification> {
    throw new RepositoryError('NOT_FOUND', 'Backend не предоставляет центр уведомлений')
  }

  async getAuditTimeline(entityType: string, entityId: string) {
    const entries = await this.cached('audit:all', () => this.listAll((cursor) => this.client.get('/audit', auditListSchema, {
      cursor,
      limit: 200,
    })))
    const role = this.currentUser?.role ?? 'manager'
    return entries
      .filter((entry) => entry.target_type === entityType && entry.target_id === entityId)
      .map((entry) => mapAuditEntry(entry, role))
  }

  async getDashboardMetrics(): Promise<DashboardMetric[]> {
    const [facilities, risks, incidents, orders] = await Promise.all([
      this.listFacilities(),
      this.listRisks(),
      this.listIncidents(),
      this.listWorkOrders(),
    ])
    const now = new Date().toISOString()
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const orderRiskIds = new Set(orders.map((order) => order.source.id).filter(Boolean))
    const values = [
      {
        code: 'critical_incidents_now',
        label: 'Критические объекты',
        value: new Set(incidents.filter((item) => item.severity === 'critical' && item.status !== 'resolved').map((item) => item.facilityId)).size,
        definition: 'Объекты с открытыми подтверждёнными критическими событиями backend',
        route: '/city/list',
      },
      {
        code: 'high_risks_without_action',
        label: 'Высокий риск без заявки',
        value: new Set(risks.filter((item) => ['high', 'critical'].includes(item.severity) && ['new', 'acknowledged'].includes(item.status) && !orderRiskIds.has(item.id)).map((item) => item.facilityId)).size,
        definition: 'Объекты с высоким прогнозным риском без связанной заявки',
        route: '/city/list',
      },
      {
        code: 'overdue_work_orders',
        label: 'Просроченные заявки',
        value: orders.filter((item) => item.sla?.state === 'breached' && !['closed', 'cancelled'].includes(item.status)).length,
        definition: 'Заявки backend с истёкшим due_at',
        route: '/work-orders',
      },
      {
        code: 'open_work_orders',
        label: 'Открытые заявки',
        value: orders.filter((item) => !['closed', 'cancelled', 'completed_by_engineer'].includes(item.status)).length,
        definition: 'Незавершённые заявки backend',
        route: '/work-orders',
      },
      {
        code: 'closed_work_orders_24h',
        label: 'Завершено за 24 часа',
        value: orders.filter((item) => item.closedAt && Date.parse(item.closedAt) >= Date.parse(from)).length,
        definition: 'Заявки со статусом completed, обновлённые за последние 24 часа',
        route: '/work-orders',
      },
    ]
    return values.map((item) => ({
      code: item.code,
      label: item.label,
      value: item.value,
      unit: 'шт.',
      period: { from, to: now },
      comparison: null,
      definition: item.definition,
      updatedAt: now,
      dataState: facilities.length ? 'actual' : 'unavailable',
      provenance: apiProvenance('derived', 'Расчёт Contour по данным backend', now),
      drilldown: { route: item.route, filters: {} },
    }))
  }

  private async listAll<T>(
    loadPage: (cursor?: string) => Promise<{ data: T[]; meta: { next_cursor: string | null } }>,
  ) {
    const result: T[] = []
    let cursor: string | undefined
    let pageCount = 0
    do {
      const page = await loadPage(cursor)
      result.push(...page.data)
      cursor = page.meta.next_cursor ?? undefined
      pageCount += 1
      if (pageCount > 100) {
        throw new RepositoryError('SOURCE_UNAVAILABLE', 'Backend вернул некорректную последовательность страниц')
      }
    } while (cursor)
    return result
  }

  private async cached<T>(key: string, loader: () => Promise<T>, ttlMs = 10_000): Promise<T> {
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value as Promise<T>
    const value = loader()
    this.cache.set(key, { expiresAt: Date.now() + ttlMs, value })
    try {
      return await value
    } catch (error) {
      this.cache.delete(key)
      throw error
    }
  }

  private clearCache(prefix?: string) {
    if (!prefix) {
      this.cache.clear()
      return
    }
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }
}

export function createApiContourRepository(options: ApiContourRepositoryOptions) {
  return new ApiContourRepository(options)
}
