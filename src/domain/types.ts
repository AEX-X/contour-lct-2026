export type ISODateTime = string
export type EntityId = string

export type DemoRole =
  | 'manager'
  | 'senior_dispatcher'
  | 'facility_dispatcher'
  | 'maintenance_coordinator'
  | 'engineer'

export type Capability =
  | 'city.read'
  | 'operations.read'
  | 'facility.read.all'
  | 'facility.read.unit'
  | 'facility.read.assigned'
  | 'facility.read.temporary'
  | 'facility.technical_context.read'
  | 'facility.dispatcher.assign'
  | 'risk.read'
  | 'risk.acknowledge'
  | 'risk.confirm'
  | 'risk.reject'
  | 'risk.defer'
  | 'incident.read'
  | 'incident.confirm'
  | 'incident.resolve'
  | 'work_order.read'
  | 'work_order.create'
  | 'work_order.edit_draft'
  | 'work_order.submit'
  | 'work_order.triage'
  | 'work_order.request_clarification'
  | 'work_order.priority.propose'
  | 'work_order.priority.finalize'
  | 'work_order.sla.finalize'
  | 'work_order.assign_engineer'
  | 'work_order.reassign_engineer'
  | 'work_order.accept_assignment'
  | 'work_order.decline_assignment'
  | 'work_order.execute'
  | 'work_order.submit_result'
  | 'work_order.verify'
  | 'work_order.return_for_rework'
  | 'work_order.close'
  | 'work_order.cancel'
  | 'work_order.override'
  | 'work_order.costs.read'
  | 'work_order.costs.write'
  | 'engineer_workload.read'
  | 'engineer_assignment.manage'
  | 'analytics.city.read'
  | 'analytics.facility.read'
  | 'analytics.management.read'
  | 'analytics.technical.read'
  | 'analytics.economy.read'
  | 'offline_package.download'
  | 'offline_mutation.sync'
  | 'notification.read'
  | 'notification.preferences.manage'
  | 'audit.read'
  | 'report.export'

export type ScopeType =
  | 'all_facilities'
  | 'operational_unit'
  | 'single_facility'
  | 'maintenance_organization'
  | 'work_order_grants'

export interface UserScope {
  type: ScopeType
  operationalUnitIds: string[]
  facilityIds: string[]
}

export interface UserRef {
  id: string
  displayName: string
}

export interface Organization {
  id: string
  displayName: string
  type: 'moscollector' | 'maintenance_provider'
}

export interface User extends UserRef {
  role: DemoRole
  organizationId: string
  permissions: Capability[]
  scope: UserScope
  homeRoute: string
  timezone: 'Europe/Moscow'
  locale: 'ru-RU'
  specializationCodes?: string[]
  availability?: 'available' | 'busy' | 'off_shift'
}

export interface CurrentUser extends User {
  organization: Organization
  activeAccessGrants: AccessGrant[]
}

export type DataOrigin =
  | 'observed'
  | 'derived'
  | 'model_output'
  | 'manual'
  | 'unavailable'

export interface DataProvenance {
  origin: DataOrigin
  environment: 'real' | 'synthetic_demo'
  sourceLabel: string
  asOf: ISODateTime | null
  note?: string
}

export interface OperationalUnit {
  id: string
  name: string
  facilityIds: string[]
  provenance: DataProvenance
}

export interface FacilityAssignment {
  id: string
  facilityId: string
  dispatcherId: string
  startsAt: ISODateTime
  endsAt: ISODateTime
  status: 'scheduled' | 'active' | 'completed' | 'cancelled'
  assignedBy: UserRef
  version: number
}

export type FacilityStatus = 'normal' | 'attention' | 'critical' | 'no_data'

export interface Facility {
  id: string
  version: number
  name: string
  address: string
  internalCode: string
  rostaCode: string | null
  operationalUnitId: string
  status: FacilityStatus
  statusReason: string
  position: { lat: number; lon: number } | null
  responsibleDispatcherId: string | null
  sensorAvailability: number | null
  updatedAt: ISODateTime
  provenance: DataProvenance
}

export type HierarchyNodeType =
  | 'building'
  | 'collector'
  | 'section'
  | 'room'
  | 'equipment'
  | 'sensor'

export interface HierarchyNode {
  id: string
  facilityId: string
  parentId: string | null
  entityType: HierarchyNodeType
  entityId: string | null
  displayName: string
  path: string[]
  planPosition: {
    planId: string
    x: number
    y: number
    level: string | null
  } | null
  provenance: DataProvenance
}

export type EquipmentStatus = 'operational' | 'attention' | 'fault' | 'unknown'

export interface Equipment {
  id: string
  version: number
  facilityId: string
  hierarchyNodeId: string
  name: string
  categoryCode: string
  model: string | null
  serialNumber: string | null
  commissionedAt: ISODateTime | null
  status: EquipmentStatus
  lastMaintenanceAt: ISODateTime | null
  provenance: DataProvenance
}

export type SensorKind =
  | 'temperature'
  | 'smoke'
  | 'gas'
  | 'humidity'
  | 'water_level'
  | 'contact'
  | 'volume'

export type SensorStatus = 'normal' | 'attention' | 'alarm' | 'offline'

export interface SensorReading {
  at: ISODateTime
  value: number
  quality: 'good' | 'uncertain' | 'bad'
}

export interface Sensor {
  id: string
  version: number
  facilityId: string
  hierarchyNodeId: string
  equipmentId: string | null
  name: string
  kind: SensorKind
  unit: string
  status: SensorStatus
  lastReading: SensorReading | null
  warningThreshold: number | null
  alarmThreshold: number | null
  readings: SensorReading[]
  updatedAt: ISODateTime
  provenance: DataProvenance
}

export interface WorkOrderTargetPathItem {
  type: string
  id: string
  displayName: string
}

export type WorkOrderTargetType =
  | 'facility'
  | 'building'
  | 'collector'
  | 'section'
  | 'equipment'
  | 'sensor'

export interface WorkOrderTarget {
  type: WorkOrderTargetType
  id: string
  facilityId: string
  displayName: string
  hierarchyPath: WorkOrderTargetPathItem[]
  locationSnapshot: {
    text: string | null
    geo: { lat: number; lon: number } | null
    planPosition: {
      planId: string
      x: number
      y: number
      level: string | null
    } | null
  }
}

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical'
export type RiskStatus = 'new' | 'acknowledged' | 'confirmed' | 'rejected' | 'deferred' | 'resolved'

export interface RiskForecast {
  id: string
  version: number
  facilityId: string
  target: WorkOrderTarget
  predictedEvent: string
  probability: number
  severity: RiskSeverity
  horizonHours: number
  status: RiskStatus
  topFactors: Array<{ label: string; contribution: number | null; direction: 'up' | 'down' }>
  recommendation: string
  createdAt: ISODateTime
  expiresAt: ISODateTime
  decidedAt: ISODateTime | null
  decidedBy: UserRef | null
  provenance: DataProvenance
}

export type IncidentStatus = 'open' | 'monitoring' | 'resolved'

export interface Incident {
  id: string
  version: number
  facilityId: string
  target: WorkOrderTarget
  sourceRiskId: string | null
  title: string
  description: string
  severity: RiskSeverity
  status: IncidentStatus
  confirmedAt: ISODateTime
  confirmedBy: UserRef
  resolvedAt: ISODateTime | null
  failureEpisodeId: string | null
  provenance: DataProvenance
}

export interface FailureEpisode {
  id: string
  facilityId: string
  target: WorkOrderTarget
  incidentIds: string[]
  startedAt: ISODateTime
  resolvedAt: ISODateTime | null
  rootCauseCode: string | null
  provenance: DataProvenance
}

export type WorkOrderStatus =
  | 'draft'
  | 'submitted'
  | 'triage'
  | 'needs_clarification'
  | 'assigned'
  | 'accepted'
  | 'en_route'
  | 'in_progress'
  | 'waiting_access'
  | 'waiting_parts'
  | 'completed_by_engineer'
  | 'verification'
  | 'rework'
  | 'closed'
  | 'cancelled'

export type WorkOrderPriority = 'P1' | 'P2' | 'P3' | 'P4'

export type WorkOrderAction =
  | 'edit'
  | 'submit'
  | 'start_triage'
  | 'request_clarification'
  | 'resubmit_clarification'
  | 'finalize_priority'
  | 'assign'
  | 'reassign'
  | 'accept'
  | 'decline'
  | 'mark_en_route'
  | 'start_work'
  | 'wait_access'
  | 'wait_parts'
  | 'resume_work'
  | 'submit_result'
  | 'start_verification'
  | 'return_for_rework'
  | 'close'
  | 'cancel'
  | 'override'

export interface SlaState {
  policyId: string
  startedAt: ISODateTime | null
  acceptanceDueAt: ISODateTime | null
  arrivalDueAt: ISODateTime | null
  resolutionDueAt: ISODateTime | null
  currentStage: 'acceptance' | 'arrival' | 'resolution' | 'completed'
  state: 'on_track' | 'at_risk' | 'breached' | 'paused' | 'completed' | 'not_applicable'
  pausedAt: ISODateTime | null
  pauseReason: string | null
  breachStage: 'acceptance' | 'arrival' | 'resolution' | null
  remainingSeconds: number | null
  serverTime: ISODateTime
}

export interface PartUsage {
  partCode: string
  name: string
  quantity: number
  unit: string
}

export interface LaborEntry {
  engineerId: string
  minutes: number
  startedAt: ISODateTime
  endedAt: ISODateTime
}

export interface RepairResult {
  failureConfirmed: boolean | null
  rootCauseCode: string | null
  diagnosis: string
  actions: string[]
  parts: PartUsage[]
  laborMinutes: number | null
  equipmentRestored: boolean | null
  controlCheckResult: string | null
  residualRisk: 'none' | 'low' | 'medium' | 'high' | null
  recommendations: string
  requiresFollowUp: boolean
  completedAt: ISODateTime | null
  author: UserRef | null
}

export interface WorkOrderAssignment {
  id: string
  workOrderId: string
  engineerId: string
  assignedBy: UserRef
  assignedAt: ISODateTime
  acceptedAt: ISODateTime | null
  declinedAt: ISODateTime | null
  declineReason: string | null
  completedAt: ISODateTime | null
  status: 'assigned' | 'accepted' | 'declined' | 'completed' | 'superseded' | 'cancelled'
  version: number
}

export interface AccessGrant {
  id: string
  workOrderId: string
  facilityId: string
  userId: string
  accessLevel: 'technical_full'
  startsAt: ISODateTime
  expiresAt: ISODateTime | null
  revokedAt: ISODateTime | null
  status: 'scheduled' | 'active' | 'expired' | 'revoked'
  offlineCacheExpiresAt: ISODateTime | null
  version: number
}

export interface Money {
  amountMinor: number
  currency: 'RUB'
}

export interface WorkOrder {
  id: string
  number: string
  version: number
  status: WorkOrderStatus
  source: { type: 'risk' | 'incident' | 'manual'; id: string | null }
  target: WorkOrderTarget
  affectedTargets: WorkOrderTarget[]
  snapshot: {
    capturedAt: ISODateTime
    facilityName: string
    sensorReadings: Array<{ sensorId: string; value: number | null; unit: string; at: ISODateTime | null }>
    note: string
  }
  categoryCode: string
  symptoms: string[]
  description: string
  systemRecommendation: string | null
  preliminaryPriority: WorkOrderPriority | null
  finalPriority: WorkOrderPriority | null
  prioritySource: 'system' | 'dispatcher' | 'coordinator' | 'manager_override' | null
  sla: SlaState | null
  creator: UserRef
  responsibleDispatcher: UserRef | null
  coordinator: UserRef | null
  maintenanceOrganizationId: string
  currentAssignment: WorkOrderAssignment | null
  accessGrant: AccessGrant | null
  repairResult: RepairResult | null
  estimatedCost: Money | null
  actualCost: Money | null
  duplicateOfWorkOrderId: string | null
  recurrenceOfWorkOrderId: string | null
  createdAt: ISODateTime
  updatedAt: ISODateTime
  closedAt: ISODateTime | null
  provenance: DataProvenance
  allowedActions: WorkOrderAction[]
}

export type NotificationPriority = 'info' | 'warning' | 'critical'

export interface Notification {
  id: string
  userId: string
  type: string
  priority: NotificationPriority
  title: string
  body: string
  entityType: string
  entityId: string
  deepLink: string
  createdAt: ISODateTime
  readAt: ISODateTime | null
  groupKey: string | null
  provenance: DataProvenance
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: UserRef
  actorRole: DemoRole
  occurredAt: ISODateTime
  reason: string | null
  beforeVersion: number | null
  afterVersion: number | null
  metadata: Record<string, unknown>
  provenance: DataProvenance
}

export interface DashboardMetric {
  code: string
  label: string
  value: number | null
  unit: string | null
  period: { from: ISODateTime; to: ISODateTime }
  comparison: {
    value: number | null
    changePercent: number | null
    direction: 'up' | 'down' | 'flat' | 'unknown'
  } | null
  definition: string
  updatedAt: ISODateTime
  dataState: 'actual' | 'partial' | 'stale' | 'unavailable'
  provenance: DataProvenance
  drilldown: { route: string; filters: Record<string, string> } | null
}

export interface RepositorySnapshot {
  scenarioId: string
  revision: number
  activeUserId: string
  demoClockIso: ISODateTime
}

export interface DemoState extends RepositorySnapshot {
  schemaVersion: number
  seedVersion: number
  organizations: Record<string, Organization>
  users: Record<string, User>
  operationalUnits: Record<string, OperationalUnit>
  facilityAssignments: Record<string, FacilityAssignment>
  facilities: Record<string, Facility>
  hierarchyNodes: Record<string, HierarchyNode>
  equipment: Record<string, Equipment>
  sensors: Record<string, Sensor>
  risks: Record<string, RiskForecast>
  incidents: Record<string, Incident>
  failureEpisodes: Record<string, FailureEpisode>
  workOrders: Record<string, WorkOrder>
  assignments: Record<string, WorkOrderAssignment>
  accessGrants: Record<string, AccessGrant>
  notifications: Record<string, Notification>
  auditEvents: Record<string, AuditEvent>
  processedIdempotencyKeys: Record<
    string,
    {
      kind: 'work_order_action' | 'work_order_create' | 'risk_decision' | 'dispatcher_assignment'
      actorId: string
      resourceId: string
      operation: string
      fingerprint: string
      createdAt: ISODateTime
      result: unknown
    }
  >
  counters: {
    nextWorkOrderNumber: number
    nextEntitySequence: number
  }
}

export interface CreateWorkOrderInput {
  source: { type: 'risk' | 'incident' | 'manual'; id: string | null }
  target: WorkOrderTarget
  affectedTargets?: WorkOrderTarget[]
  categoryCode: string
  symptoms: string[]
  description: string
  preliminaryPriority: WorkOrderPriority | null
}

export interface ActionCommandBase {
  expectedVersion: number
  idempotencyKey: string
  clientOccurredAt: ISODateTime
}

export type WorkOrderActionCommand = ActionCommandBase &
  (
    | { action: 'edit'; payload: Partial<Pick<WorkOrder, 'description' | 'symptoms' | 'categoryCode' | 'preliminaryPriority'>> }
    | { action: 'submit'; payload?: { comment?: string } }
    | { action: 'start_triage'; payload?: { comment?: string } }
    | { action: 'request_clarification'; payload: { reason: string } }
    | { action: 'resubmit_clarification'; payload: { comment: string } }
    | { action: 'finalize_priority'; payload: { priority: WorkOrderPriority; slaPolicyId: string } }
    | { action: 'assign'; payload: { engineerId: string; comment?: string } }
    | { action: 'reassign'; payload: { engineerId: string; reason: string } }
    | { action: 'accept'; payload?: { comment?: string } }
    | { action: 'decline'; payload: { reason: string } }
    | { action: 'mark_en_route'; payload?: { comment?: string } }
    | { action: 'start_work'; payload?: { comment?: string } }
    | { action: 'wait_access'; payload: { reason: string } }
    | { action: 'wait_parts'; payload: { reason: string } }
    | { action: 'resume_work'; payload?: { comment?: string } }
    | { action: 'submit_result'; payload: { repairResult: Omit<RepairResult, 'completedAt' | 'author'> } }
    | { action: 'start_verification'; payload?: { comment?: string } }
    | { action: 'return_for_rework'; payload: { reason: string; expectedChanges: string[] } }
    | { action: 'close'; payload: { equipmentOperational: boolean; comment?: string } }
    | { action: 'cancel'; payload: { reason: string } }
    | { action: 'override'; payload: { reason: string; note: string } }
  )

export interface WorkOrderActionResponse {
  workOrder: WorkOrder
  appliedAction: WorkOrderAction
  auditEventId: string
}

export interface MutationMeta {
  idempotencyKey: string
  clientOccurredAt: ISODateTime
}

export interface AssignFacilityDispatcherCommand extends MutationMeta {
  facilityId: string
  dispatcherId: string
  startsAt: ISODateTime
  endsAt: ISODateTime
  expectedVersion: number
}

export interface AssignFacilityDispatcherResponse {
  assignment: FacilityAssignment
  facility: Facility
  auditEventId: string
}

export interface RiskDecisionCommand extends MutationMeta {
  expectedVersion: number
  comment: string
}

export type RepositoryErrorCode =
  | 'AUTH_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'DUPLICATE_CANDIDATE'
  | 'ASSIGNMENT_CHANGED'
  | 'ACCESS_EXPIRED'
  | 'NO_SUITABLE_ENGINEER'
  | 'SOURCE_UNAVAILABLE'
  | 'PERSISTENCE_FAILED'

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode
  readonly correlationId: string
  readonly currentVersion?: number
  readonly fieldErrors: Array<{ field: string; code: string; message: string }>

  constructor(
    code: RepositoryErrorCode,
    message: string,
    options: {
      correlationId?: string
      currentVersion?: number
      fieldErrors?: Array<{ field: string; code: string; message: string }>
    } = {},
  ) {
    super(message)
    this.name = 'RepositoryError'
    this.code = code
    this.correlationId = options.correlationId ?? `demo-${code.toLowerCase()}`
    this.currentVersion = options.currentVersion
    this.fieldErrors = options.fieldErrors ?? []
  }
}
