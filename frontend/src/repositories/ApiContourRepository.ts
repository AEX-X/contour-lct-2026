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
  WorkOrderAction,
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
  engineerCandidateListSchema,
  eventListSchema,
  facilityDispatcherAssignmentResponseSchema,
  facilityDispatcherListSchema,
  facilityListSchema,
  facilitySchema,
  hierarchySchema,
  layoutSchema,
  meSchema,
  notificationListSchema,
  notificationSchema,
  riskListSchema,
  riskSchema,
  sensorListSchema,
  sensorSeriesSchema,
  workOrderListSchema,
  workOrderActionResponseSchema,
  workOrderSchema,
  type ApiAuditEntry,
  type ApiEngineerCandidate,
  type ApiEvent,
  type ApiFacility,
  type ApiFacilityAssignment,
  type ApiHierarchyNode,
  type ApiLayout,
  type ApiNotification,
  type ApiRisk,
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
  'facility.read.unit': ['facility.read.unit', 'facility.technical_context.read'],
  'facility.read.temporary': ['facility.read.temporary', 'facility.technical_context.read'],
  'facility.technical_context.read': ['facility.technical_context.read'],
  'sensor.read': ['facility.technical_context.read'],
  'risk.read': ['risk.read'],
  'risk.acknowledge': ['risk.acknowledge'],
  'risk.resolve': ['risk.reject', 'risk.defer'],
  'work_order.read': ['work_order.read'],
  'work_order.create_draft': ['work_order.create'],
  'work_order.create': ['work_order.create'],
  'work_order.submit': ['work_order.submit'],
  'work_order.edit_draft': ['work_order.edit_draft'],
  'work_order.triage': ['work_order.triage'],
  'work_order.request_clarification': ['work_order.request_clarification'],
  'work_order.priority.propose': ['work_order.priority.propose'],
  'work_order.priority.finalize': ['work_order.priority.finalize'],
  'work_order.sla.finalize': ['work_order.sla.finalize'],
  'work_order.assign_engineer': ['work_order.assign_engineer'],
  'work_order.reassign_engineer': ['work_order.reassign_engineer'],
  'work_order.accept_assignment': ['work_order.accept_assignment'],
  'work_order.decline_assignment': ['work_order.decline_assignment'],
  'work_order.execute': ['work_order.execute'],
  'work_order.submit_result': ['work_order.submit_result'],
  'work_order.verify': ['work_order.verify'],
  'work_order.return_for_rework': ['work_order.return_for_rework'],
  'work_order.close': ['work_order.close'],
  'work_order.cancel': ['work_order.cancel'],
  'work_order.override': ['work_order.override'],
  'work_order.costs.read': ['work_order.costs.read'],
  'work_order.costs.write': ['work_order.costs.write'],
  'engineer_workload.read': ['engineer_workload.read'],
  'engineer_assignment.manage': ['engineer_assignment.manage'],
  'facility.dispatcher.assign': ['facility.dispatcher.assign'],
  'notification.read': ['notification.read'],
  'notification.preferences.manage': ['notification.preferences.manage'],
  'offline_package.download': ['offline_package.download'],
  'offline_mutation.sync': ['offline_mutation.sync'],
  'analytics.read.summary': ['analytics.city.read', 'analytics.facility.read', 'analytics.management.read'],
  'analytics.read.technical': ['analytics.technical.read'],
  'analytics.read.economy': ['analytics.economy.read'],
  'analytics.city.read': ['analytics.city.read'],
  'analytics.facility.read': ['analytics.facility.read'],
  'analytics.management.read': ['analytics.management.read'],
  'analytics.technical.read': ['analytics.technical.read'],
  'analytics.economy.read': ['analytics.economy.read'],
  'report.export': ['report.export'],
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
  const normalized = role
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/[\s-]+/g, '_')
  if (['manager', 'руководитель'].includes(normalized)) return 'manager'
  if (['dispatcher', 'facility_dispatcher', 'диспетчер', 'диспетчер_объекта'].includes(normalized)) {
    return 'facility_dispatcher'
  }
  if (['senior_dispatcher', 'старший_диспетчер', 'районный_диспетчер', 'диспетчер_района'].includes(normalized)) {
    return 'senior_dispatcher'
  }
  if (['maintenance_coordinator', 'координатор_ремонтов', 'координатор_ремонтных_работ'].includes(normalized)) {
    return 'maintenance_coordinator'
  }
  if (['engineer', 'инженер'].includes(normalized)) return 'engineer'
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
  const role = mapRole(me.role)
  const scopeType = me.scope.type === 'all_facilities'
    ? 'all_facilities'
    : role === 'engineer'
      ? 'work_order_grants'
      : role === 'maintenance_coordinator'
        ? 'maintenance_organization'
        : role === 'senior_dispatcher' || facilityIds.length > 1
          ? 'operational_unit'
          : 'single_facility'
  const organization = role === 'maintenance_coordinator' || role === 'engineer'
    ? {
        id: me.organization_id ?? 'org-maintenance-api',
        displayName: me.organization_name ?? 'Единая государственная ремонтная служба',
        type: 'maintenance_provider' as const,
      }
    : {
        ...apiOrganization,
        id: me.organization_id ?? apiOrganization.id,
        displayName: me.organization_name ?? apiOrganization.displayName,
      }
  return {
    id: me.user_id ?? `api-${role}`,
    displayName: me.display_name ?? (role === 'manager'
      ? 'Руководитель'
      : role === 'senior_dispatcher'
        ? 'Районный диспетчер'
        : role === 'facility_dispatcher'
          ? 'Диспетчер объекта'
          : role === 'maintenance_coordinator'
            ? 'Координатор ремонтов'
            : 'Инженер'),
    role,
    organizationId: organization.id,
    organization,
    permissions: mapPermissions(me, role),
    scope: {
      type: scopeType,
      operationalUnitIds: [],
      facilityIds,
    },
    homeRoute: homeRoute(role),
    timezone: me.timezone === 'Europe/Moscow' ? me.timezone : 'Europe/Moscow',
    locale: me.locale === 'ru-RU' ? me.locale : 'ru-RU',
    specializationCodes: me.specialization_codes,
    availability: me.availability,
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
    version: item.version ?? 1,
    name: item.display_name,
    address: item.address ?? 'Адрес не предоставлен в API',
    internalCode: item.internal_code ?? item.id,
    rostaCode: item.rosta_code ?? null,
    operationalUnitId: item.operational_unit_id ?? 'api-scope',
    status: mapFacilityStatus(item.current_state, item.data_health.freshness),
    statusReason: facilityStatusReason(item),
    position: {
      lon: item.location.coordinates[0],
      lat: item.location.coordinates[1],
    },
    responsibleDispatcherId: item.responsible_dispatcher_id ?? null,
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
  if (['facility', 'building', 'collector', 'section', 'room', 'equipment', 'sensor'].includes(value)) {
    return value as HierarchyNodeType
  }
  throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неизвестный тип узла: ${value}`)
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
  if (['offline', 'disabled'].includes(value)) return 'offline'
  if (['normal', 'ok'].includes(value)) return 'normal'
  return 'unknown'
}

function mapQuality(value: string): 'good' | 'uncertain' | 'bad' {
  if (value === 'good') return 'good'
  if (['bad', 'invalid'].includes(value)) return 'bad'
  return 'uncertain'
}

function mapSensor(
  item: ApiSensorListItem,
  series?: ApiSensorSeries,
  equipmentId: string | null = null,
): Sensor {
  const numericSeries = series?.value_type === 'numeric' ? series : null
  const warningThreshold = numericSeries?.thresholds.find((item) => item.kind === 'warning')?.value ?? null
  const alarmThreshold = numericSeries?.thresholds.find((item) => item.kind === 'alarm')?.value ?? null
  const currentReading = item.current_reading?.numeric_value === null || item.current_reading === null
    ? null
    : item.current_reading
      ? {
          at: item.current_reading.measured_at,
          value: item.current_reading.numeric_value,
          quality: item.data_health === 'fresh' ? 'good' as const : 'uncertain' as const,
        }
      : null
  return {
    id: item.id,
    version: 1,
    facilityId: item.facility_id ?? 'unassigned',
    hierarchyNodeId: item.hierarchy_node_id ?? `sensor-node-${item.id}`,
    equipmentId,
    name: item.display_name,
    kind: mapSensorKind(item.sensor_type),
    unit: item.current_reading?.unit ?? '',
    status: mapSensorStatus(item.current_state),
    lastReading: currentReading,
    lastValueText: item.current_reading?.value ?? null,
    warningThreshold,
    alarmThreshold,
    readings: numericSeries?.points.map((point) => ({
      at: point.timestamp,
      value: point.value,
      quality: mapQuality(point.quality),
    })) ?? [],
    updatedAt: item.current_reading?.measured_at ?? null,
    provenance: apiProvenance(
      'observed',
      'Backend Contour: СМВУ',
      item.current_reading?.measured_at ?? null,
      item.current_reading ? undefined : 'Последнее показание отсутствует в источнике',
    ),
  }
}

function mapRiskSeverity(value: string): RiskSeverity {
  if (['low', 'medium', 'high', 'critical'].includes(value)) return value as RiskSeverity
  throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неизвестный уровень риска: ${value}`)
}

function mapRiskStatus(value: string): RiskForecast['status'] {
  if (value === 'open') return 'new'
  if (value === 'acknowledged') return 'acknowledged'
  if (value === 'confirmed') return 'confirmed'
  if (value === 'rejected') return 'rejected'
  if (value === 'deferred') return 'deferred'
  if (value === 'resolved') return 'resolved'
  throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неизвестный статус риска: ${value}`)
}

function mapTargetType(value: string): WorkOrderTarget['type'] {
  if (value === 'hierarchy_node') return 'section'
  if (['facility', 'building', 'collector', 'section', 'equipment', 'sensor'].includes(value)) {
    return value as WorkOrderTarget['type']
  }
  throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неизвестный тип цели: ${value}`)
}

function mapTargetTypeToApi(value: WorkOrderTarget['type']) {
  return value
}

function mapCategoryToWorkType(value: string) {
  const mapping: Record<string, 'inspection' | 'repair' | 'replacement' | 'maintenance'> = {
    inspection: 'inspection',
    repair: 'repair',
    replacement: 'replacement',
    maintenance: 'maintenance',
    manual_inspection: 'inspection',
    predictive_inspection: 'inspection',
    equipment_fault: 'repair',
    sensor_failure: 'replacement',
    predictive_maintenance: 'maintenance',
  }
  const mapped = mapping[value]
  if (!mapped) {
    throw new RepositoryError('VALIDATION_ERROR', `Неизвестная категория заявки: ${value}`)
  }
  return mapped
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
    modelAsOf: item.as_of,
    demoClock: item.demo_clock
      ? {
          requestedAsOfUtc: item.demo_clock.requested_as_of_utc,
          anchorUtc: item.demo_clock.anchor_utc,
        }
      : null,
    dataHealth: item.data_health,
    createdAt: item.created_at,
    expiresAt: item.prediction_window.end,
    decidedAt: status === 'new' ? null : item.updated_at,
    decidedBy: null,
    provenance: apiProvenance(
      'model_output',
      `ML через backend: ${item.model}`,
      item.as_of,
      item.demo_clock
        ? `Исторический ML-демо: backend запросил ${item.demo_clock.requested_as_of_utc}, модель рассчитала срез ${item.as_of}. Числовые SHAP-вклады не опубликованы`
        : `Состояние данных: ${item.data_health}. Backend передаёт названия факторов без числовых SHAP-вкладов`,
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
  if (value === 'low') return 'P4'
  throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неизвестный приоритет: ${value}`)
}

function mapWorkOrderStatus(value: string): WorkOrderStatus {
  const normalized = value.trim().toLowerCase()
  const currentStatuses: WorkOrderStatus[] = [
    'draft',
    'submitted',
    'triage',
    'needs_clarification',
    'assigned',
    'accepted',
    'en_route',
    'in_progress',
    'waiting_access',
    'waiting_parts',
    'completed_by_engineer',
    'verification',
    'rework',
    'closed',
    'cancelled',
  ]
  if (currentStatuses.includes(normalized as WorkOrderStatus)) return normalized as WorkOrderStatus
  if (normalized === 'ready') return 'triage'
  if (normalized === 'completed') return 'completed_by_engineer'
  if (normalized === 'integration_error') return 'cancelled'
  throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неизвестный статус заявки: ${value}`)
}

const workOrderActions = new Set<WorkOrderAction>([
  'edit',
  'submit',
  'start_triage',
  'request_clarification',
  'resubmit_clarification',
  'finalize_priority',
  'assign',
  'reassign',
  'accept',
  'decline',
  'mark_en_route',
  'start_work',
  'wait_access',
  'wait_parts',
  'resume_work',
  'submit_result',
  'start_verification',
  'return_for_rework',
  'close',
  'cancel',
  'override',
])

function mapAllowedActions(values: string[] | undefined): WorkOrderAction[] {
  return (values ?? []).filter((value): value is WorkOrderAction => workOrderActions.has(value as WorkOrderAction))
}

function mapApiUserRef(item: { id: string; display_name: string } | null | undefined) {
  return item ? { id: item.id, displayName: item.display_name } : null
}

function mapApiAssignment(item: ApiWorkOrder['active_assignment']) {
  if (!item) return null
  return {
    id: item.id,
    workOrderId: item.work_order_id,
    engineerId: item.engineer_id,
    assignedBy: { id: item.assigned_by.id, displayName: item.assigned_by.display_name },
    assignedAt: item.assigned_at,
    acceptedAt: item.accepted_at,
    declinedAt: item.declined_at,
    declineReason: item.decline_reason,
    completedAt: item.completed_at,
    status: item.status,
    version: item.version,
  }
}

function mapApiAccessGrant(item: ApiWorkOrder['access_grant']) {
  if (!item) return null
  return {
    id: item.id,
    workOrderId: item.work_order_id,
    facilityId: item.facility_id,
    userId: item.user_id,
    accessLevel: item.access_level,
    startsAt: item.starts_at,
    expiresAt: item.expires_at,
    revokedAt: item.revoked_at,
    status: item.status,
    offlineCacheExpiresAt: item.offline_cache_expires_at,
    version: item.version,
  }
}

function mapApiRepairResult(item: ApiWorkOrder['repair_result']) {
  if (!item) return null
  return {
    failureConfirmed: item.failure_confirmed,
    rootCauseCode: item.root_cause_code,
    diagnosis: item.diagnosis,
    actions: item.actions,
    parts: item.parts.map((part) => ({
      partCode: part.part_code,
      name: part.name,
      quantity: part.quantity,
      unit: part.unit,
    })),
    laborMinutes: item.labor_minutes,
    equipmentRestored: item.equipment_restored,
    controlCheckResult: item.control_check_result,
    residualRisk: item.residual_risk,
    recommendations: item.recommendations,
    requiresFollowUp: item.requires_follow_up,
    completedAt: item.completed_at,
    author: mapApiUserRef(item.author),
  }
}

function mapWorkOrder(item: ApiWorkOrder, facility?: Facility): WorkOrder {
  const now = new Date().toISOString()
  const status = mapWorkOrderStatus(item.status)
  const dueTimestamp = Date.parse(item.due_at)
  const terminal = ['closed', 'cancelled'].includes(status)
  const slaCompleted = ['completed_by_engineer', 'verification', 'closed'].includes(status)
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
    symptoms: item.symptoms,
    description: item.description,
    systemRecommendation: null,
    preliminaryPriority: mapPriority(item.priority),
    finalPriority: item.sla_policy_id || !['draft', 'submitted', 'triage', 'needs_clarification'].includes(status)
      ? mapPriority(item.priority)
      : null,
    prioritySource: item.sla_policy_id ? 'coordinator' : 'system',
    sla: item.sla ? {
      policyId: item.sla.policy_id,
      startedAt: item.sla.started_at,
      acceptanceDueAt: item.sla.acceptance_due_at,
      arrivalDueAt: item.sla.arrival_due_at,
      resolutionDueAt: item.sla.resolution_due_at,
      currentStage: item.sla.current_stage,
      state: item.sla.state,
      pausedAt: item.sla.paused_at,
      pauseReason: item.sla.pause_reason,
      breachStage: item.sla.breach_stage,
      remainingSeconds: item.sla.remaining_seconds,
      serverTime: item.sla.server_time,
    } : {
      policyId: item.sla_policy_id ?? 'backend-due-at',
      startedAt: item.submitted_at ?? item.created_at,
      acceptanceDueAt: null,
      arrivalDueAt: null,
      resolutionDueAt: item.due_at,
      currentStage: slaCompleted ? 'completed' : 'resolution',
      state: status === 'cancelled'
        ? 'not_applicable'
        : slaCompleted
          ? 'completed'
          : dueTimestamp < Date.now()
            ? 'breached'
            : 'on_track',
      pausedAt: null,
      pauseReason: null,
      breachStage: !terminal && !slaCompleted && dueTimestamp < Date.now() ? 'resolution' : null,
      remainingSeconds: slaCompleted ? 0 : Math.max(0, Math.round((dueTimestamp - Date.now()) / 1000)),
      serverTime: now,
    },
    creator: mapApiUserRef(item.creator) ?? { id: item.created_by, displayName: item.created_by },
    responsibleDispatcher: mapApiUserRef(item.responsible_dispatcher),
    coordinator: mapApiUserRef(item.coordinator) ?? (item.coordinator_id
      ? { id: item.coordinator_id, displayName: 'Координатор ремонтных работ' }
      : null),
    maintenanceOrganizationId: 'org-maintenance-api',
    currentAssignment: mapApiAssignment(item.active_assignment),
    accessGrant: mapApiAccessGrant(item.access_grant),
    repairResult: mapApiRepairResult(item.repair_result),
    estimatedCost: item.estimated_cost_minor === undefined || item.estimated_cost_minor === null
      ? null
      : { amountMinor: item.estimated_cost_minor, currency: 'RUB' },
    actualCost: item.actual_cost_minor === undefined || item.actual_cost_minor === null
      ? null
      : { amountMinor: item.actual_cost_minor, currency: 'RUB' },
    duplicateOfWorkOrderId: null,
    recurrenceOfWorkOrderId: null,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    closedAt: item.closed_at ?? (status === 'closed' ? item.updated_at : null),
    provenance: apiProvenance(
      'manual',
      'Backend Contour: заявки',
      item.updated_at,
      'Статус, назначения, доступ и разрешённые действия предоставлены backend',
    ),
    allowedActions: mapAllowedActions(item.allowed_actions),
  }
}

function mapEngineerCandidate(item: ApiEngineerCandidate): EngineerCandidate {
  return {
    user: {
      id: item.user.id,
      displayName: item.user.display_name,
      availability: item.user.availability,
      specializationCodes: item.user.specialization_codes,
    },
    activeWorkOrderCount: item.active_work_order_count,
    eligible: item.eligible,
    eligibilityReason: item.eligibility_reason,
  }
}

function mapNotification(item: ApiNotification, role?: DemoRole): Notification {
  const deepLink = role === 'engineer' && item.entity_type === 'work_order'
    ? `/my-work/${encodeURIComponent(item.entity_id)}`
    : item.deep_link
  return {
    id: item.id,
    userId: item.user_id,
    type: item.type,
    priority: item.priority,
    title: item.title,
    body: item.body,
    entityType: item.entity_type,
    entityId: item.entity_id,
    deepLink,
    createdAt: item.created_at,
    readAt: item.read_at,
    groupKey: item.group_key,
    provenance: apiProvenance('observed', 'Backend Contour: уведомления', item.created_at),
  }
}

function mapFacilityAssignment(item: ApiFacilityAssignment) {
  return {
    id: item.id,
    facilityId: item.facility_id,
    dispatcherId: item.dispatcher_id,
    startsAt: item.starts_at,
    endsAt: item.ends_at,
    status: item.status,
    assignedBy: { id: item.assigned_by.id, displayName: item.assigned_by.display_name },
    version: item.version,
  }
}

function mapAuditEntry(item: ApiAuditEntry): AuditEvent {
  const beforeVersion = typeof item.details?.before_version === 'number'
    ? item.details.before_version
    : null
  const afterVersion = typeof item.details?.after_version === 'number'
    ? item.details.after_version
    : null
  return {
    id: String(item.id),
    entityType: item.target_type ?? 'request',
    entityId: item.target_id ?? item.trace_id,
    action: item.action,
    actor: {
      id: item.user_id ?? 'anonymous',
      displayName: item.username ?? 'Неавторизованный пользователь',
    },
    actorRole: null,
    occurredAt: item.occurred_at,
    reason: item.result === 'success' ? null : item.result,
    beforeVersion,
    afterVersion,
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
      supportsOfflineSimulation: true,
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
    try {
      await this.client.logout()
    } finally {
      this.currentUser = null
      this.clearCache()
    }
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
      const [items, hierarchy] = await Promise.all([
        this.listAll((cursor) => this.client.get('/sensors', sensorListSchema, {
          facility_id: facilityId,
          cursor,
          limit: 200,
        })),
        this.getFacilityHierarchy(facilityId),
      ])
      const hierarchyById = new Map(hierarchy.map((node) => [node.id, node]))
      const equipmentIdFor = (item: ApiSensorListItem) => {
        const sensorNode = item.hierarchy_node_id ? hierarchyById.get(item.hierarchy_node_id) : undefined
        const parentNode = sensorNode?.parentId ? hierarchyById.get(sensorNode.parentId) : undefined
        return parentNode?.entityType === 'equipment'
          ? parentNode.entityId ?? parentNode.id
          : null
      }
      const seriesLimit = 12
      const seriesCandidates = items
        .filter((item) => item.value_type === 'numeric' && item.current_reading)
        .slice(0, seriesLimit)
      const loadedSeries = await mapWithConcurrency(seriesCandidates, 6, async (item) => {
        let series: ApiSensorSeries | null = null
        if (item.current_reading) {
          const measuredAt = new Date(item.current_reading.measured_at)
          const from = new Date(measuredAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
          try {
            series = await this.client.get(`/sensors/${encodeURIComponent(item.id)}/series`, sensorSeriesSchema, {
              from,
              to: item.current_reading.measured_at,
              granularity: '1h',
            })
          } catch (error) {
            if (error instanceof RepositoryError && ['AUTH_REQUIRED', 'FORBIDDEN'].includes(error.code)) {
              throw error
            }
          }
        }
        return [item.id, series] as const
      })
      const seriesBySensorId = new Map(loadedSeries)
      return items.map((item) => mapSensor(
        item,
        seriesBySensorId.get(item.id) ?? undefined,
        equipmentIdFor(item),
      ))
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
        is_confirmed_incident: 'true',
        cursor,
        limit: 200,
      }))
      return events.map(mapIncident)
    })
  }

  async listWorkOrders(params: WorkOrderListParams = {}) {
    const [items, facilities] = await Promise.all([
      this.cached(`work-orders:${params.facilityId ?? 'all'}:${params.assignedToCurrentUser ? 'mine' : 'scope'}`, () => this.listAll((cursor) => this.client.get('/work-orders', workOrderListSchema, {
        facility_id: params.facilityId,
        assigned_to_current_user: params.assignedToCurrentUser ? 'true' : undefined,
        cursor,
        limit: 200,
      }))),
      this.listFacilities().catch(() => []),
    ])
    const facilityById = new Map(facilities.map((facility) => [facility.id, facility]))
    const orders = items.map((item) => mapWorkOrder(item, item.facility_id ? facilityById.get(item.facility_id) : undefined))
    const statuses = params.status
      ? new Set(Array.isArray(params.status) ? params.status : [params.status])
      : null
    return orders.filter((order) => !statuses || statuses.has(order.status))
  }

  async getWorkOrder(workOrderId: string) {
    const item = await this.client.get(`/work-orders/${encodeURIComponent(workOrderId)}`, workOrderSchema)
    const facility = item.facility_id
      ? await this.getFacility(item.facility_id).catch(() => undefined)
      : undefined
    return mapWorkOrder(item, facility)
  }

  async createWorkOrder(input: CreateWorkOrderInput, meta: MutationMeta) {
    const priority = input.preliminaryPriority ?? 'P3'
    const dueHours = { P1: 0.25, P2: 1, P3: 4, P4: 24 }[priority]
    const occurredAt = Date.parse(meta.clientOccurredAt)
    if (!Number.isFinite(occurredAt)) {
      throw new RepositoryError('VALIDATION_ERROR', 'Некорректное время создания заявки')
    }
    const created = await this.client.post('/work-orders', workOrderSchema, {
      mode: 'draft',
      source_risk_id: input.source.type === 'risk' ? input.source.id : null,
      facility_id: input.target.facilityId,
      target_entity_type: mapTargetTypeToApi(input.target.type),
      target_entity_id: input.target.id,
      work_type: mapCategoryToWorkType(input.categoryCode),
      priority: mapPriorityToApi(priority),
      due_at: new Date(occurredAt + dueHours * 60 * 60 * 1000).toISOString(),
      description: input.description,
      symptoms: input.symptoms,
      comment: null,
      idempotency_key: meta.idempotencyKey,
      client_occurred_at: meta.clientOccurredAt,
    })
    this.clearCache('work-orders:')
    const facility = await this.getFacility(input.target.facilityId).catch(() => undefined)
    return mapWorkOrder(created, facility)
  }

  async performWorkOrderAction(
    workOrderId: string,
    command: WorkOrderActionCommand,
  ): Promise<WorkOrderActionResponse> {
    const response = await this.client.post(
      `/work-orders/${encodeURIComponent(workOrderId)}/actions`,
      workOrderActionResponseSchema,
      {
        action: command.action,
        expected_version: command.expectedVersion,
        idempotency_key: command.idempotencyKey,
        client_occurred_at: command.clientOccurredAt,
        payload: command.payload ?? {},
      },
    )
    this.clearCache('work-orders:')
    this.clearCache('notifications:')
    this.clearCache('audit:')
    const facility = response.work_order.facility_id
      ? await this.getFacility(response.work_order.facility_id).catch(() => undefined)
      : undefined
    const appliedAction = mapAllowedActions([response.applied_action])[0]
    if (!appliedAction) {
      throw new RepositoryError('SOURCE_UNAVAILABLE', `Backend вернул неизвестное действие заявки: ${response.applied_action}`)
    }
    return {
      workOrder: mapWorkOrder(response.work_order, facility),
      appliedAction,
      auditEventId: response.audit_event_id,
    }
  }

  async listEngineerCandidates(workOrderId: string): Promise<EngineerCandidate[]> {
    const response = await this.client.get(
      `/work-orders/${encodeURIComponent(workOrderId)}/engineer-candidates`,
      engineerCandidateListSchema,
    )
    return response.data.map(mapEngineerCandidate)
  }

  async listMaintenanceEngineers(): Promise<EngineerCandidate[]> {
    const response = await this.client.get('/engineers', engineerCandidateListSchema)
    return response.data.map(mapEngineerCandidate)
  }

  async listFacilityDispatchers(): Promise<Array<Pick<User, 'id' | 'displayName'>>> {
    const response = await this.client.get('/facility-dispatchers', facilityDispatcherListSchema)
    return response.data.map((dispatcher) => ({
      id: dispatcher.id,
      displayName: dispatcher.display_name,
    }))
  }

  async assignFacilityDispatcher(command: AssignFacilityDispatcherCommand): Promise<AssignFacilityDispatcherResponse> {
    const response = await this.client.post(
      `/facilities/${encodeURIComponent(command.facilityId)}/dispatcher-assignment`,
      facilityDispatcherAssignmentResponseSchema,
      {
        dispatcher_id: command.dispatcherId,
        starts_at: command.startsAt,
        ends_at: command.endsAt,
        expected_version: command.expectedVersion,
        idempotency_key: command.idempotencyKey,
        client_occurred_at: command.clientOccurredAt,
      },
    )
    this.clearCache('facilities:')
    this.clearCache(`facility:${command.facilityId}`)
    this.clearCache('notifications:')
    this.clearCache('audit:')
    return {
      assignment: mapFacilityAssignment(response.assignment),
      facility: await this.getFacility(response.facility_id),
      auditEventId: response.audit_event_id,
    }
  }

  async listNotifications(): Promise<Notification[]> {
    const response = await this.cached('notifications:all', () => this.client.get('/notifications', notificationListSchema))
    return response.data.map((item) => mapNotification(item, this.currentUser?.role))
  }

  async markNotificationRead(notificationId: string): Promise<Notification> {
    const item = await this.client.post(
      `/notifications/${encodeURIComponent(notificationId)}/read`,
      notificationSchema,
      {},
    )
    this.clearCache('notifications:')
    return mapNotification(item, this.currentUser?.role)
  }

  async getAuditTimeline(entityType: string, entityId: string) {
    const entries = await this.cached(`audit:${entityType}:${entityId}`, () => this.listAll((cursor) => this.client.get('/audit', auditListSchema, {
      target_type: entityType,
      target_id: entityId,
      cursor,
      limit: 200,
    })))
    return entries.map(mapAuditEntry)
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
        value: orders.filter((item) => !['closed', 'cancelled'].includes(item.status)).length,
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
