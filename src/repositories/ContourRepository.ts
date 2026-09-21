import type {
  AssignFacilityDispatcherCommand,
  AssignFacilityDispatcherResponse,
  AuditEvent,
  CreateWorkOrderInput,
  CurrentUser,
  DashboardMetric,
  Equipment,
  Facility,
  HierarchyNode,
  Incident,
  MutationMeta,
  Notification,
  RepositorySnapshot,
  RiskDecisionCommand,
  RiskForecast,
  Sensor,
  User,
  WorkOrder,
  WorkOrderActionCommand,
  WorkOrderActionResponse,
  WorkOrderStatus,
} from '../domain'

export interface FacilityListParams {
  query?: string
  operationalUnitId?: string
  status?: Facility['status'] | 'all'
}

export interface WorkOrderListParams {
  facilityId?: string
  status?: WorkOrderStatus | WorkOrderStatus[]
  assignedToCurrentUser?: boolean
}

export interface RiskListParams {
  facilityId?: string
  severity?: RiskForecast['severity'] | RiskForecast['severity'][]
  status?: RiskForecast['status'] | RiskForecast['status'][]
}

export interface EngineerCandidate {
  user: Pick<User, 'id' | 'displayName' | 'availability' | 'specializationCodes'>
  activeWorkOrderCount: number
  eligible: boolean
  eligibilityReason: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface RepositoryChange {
  source: 'local' | 'external'
  snapshot: RepositorySnapshot
}

export interface ContourRepository {
  getSnapshot(): RepositorySnapshot
  subscribe(listener: (change: RepositoryChange) => void): () => void
  getCurrentUser(): Promise<CurrentUser>
  listDemoProfiles(): Promise<User[]>
  switchDemoUser(userId: string): Promise<CurrentUser>
  reset(): Promise<RepositorySnapshot>
  advanceDemoClock(minutes: number): Promise<RepositorySnapshot>

  listFacilities(params?: FacilityListParams): Promise<Facility[]>
  getFacility(facilityId: string): Promise<Facility>
  getFacilityHierarchy(facilityId: string): Promise<HierarchyNode[]>
  listEquipment(facilityId: string): Promise<Equipment[]>
  listSensors(facilityId: string): Promise<Sensor[]>

  listRisks(params?: RiskListParams): Promise<RiskForecast[]>
  getRisk(riskId: string): Promise<RiskForecast>
  confirmRisk(riskId: string, command: RiskDecisionCommand): Promise<{ risk: RiskForecast; incident: Incident; auditEventId: string }>
  listIncidents(facilityId?: string): Promise<Incident[]>

  listWorkOrders(params?: WorkOrderListParams): Promise<WorkOrder[]>
  getWorkOrder(workOrderId: string): Promise<WorkOrder>
  createWorkOrder(input: CreateWorkOrderInput, meta: MutationMeta): Promise<WorkOrder>
  performWorkOrderAction(workOrderId: string, command: WorkOrderActionCommand): Promise<WorkOrderActionResponse>
  listEngineerCandidates(workOrderId: string): Promise<EngineerCandidate[]>
  listMaintenanceEngineers(): Promise<EngineerCandidate[]>

  listFacilityDispatchers(): Promise<Array<Pick<User, 'id' | 'displayName'>>>
  assignFacilityDispatcher(command: AssignFacilityDispatcherCommand): Promise<AssignFacilityDispatcherResponse>
  listNotifications(): Promise<Notification[]>
  markNotificationRead(notificationId: string): Promise<Notification>
  getAuditTimeline(entityType: string, entityId: string): Promise<AuditEvent[]>
  getDashboardMetrics(): Promise<DashboardMetric[]>
}
