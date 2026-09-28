import type {
  DashboardMetric,
  DemoState,
  Facility,
  Incident,
  RiskForecast,
  User,
  WorkOrder,
} from './types'
import { canAccessFacility, canAccessWorkOrder } from './access'

function hoursBefore(iso: string, hours: number): string {
  return new Date(Date.parse(iso) - hours * 60 * 60 * 1000).toISOString()
}

export type FacilityOperationalState = Facility['status'] | 'forecast'

export function isRiskActiveAt(risk: RiskForecast, asOf: string): boolean {
  const expiresAt = Date.parse(risk.expiresAt)
  // API forecasts may be calculated against an explicit historical model
  // clock. Their window belongs to that analytical timeline, while work-order
  // SLA continues to use the operational wall clock.
  const referenceTime = Date.parse(risk.modelAsOf ?? asOf)
  return (
    !['rejected', 'deferred', 'resolved'].includes(risk.status) &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(referenceTime) &&
    expiresAt >= referenceTime
  )
}

export function hasActiveEngineerAssignment(order: WorkOrder): boolean {
  return (
    !['closed', 'cancelled'].includes(order.status) &&
    Boolean(
      order.currentAssignment &&
      ['assigned', 'accepted'].includes(order.currentAssignment.status),
    )
  )
}

export function deriveFacilityOperationalState(
  facility: Facility,
  risks: readonly RiskForecast[],
  incidents: readonly Incident[],
  asOf: string,
): { state: FacilityOperationalState; reason: string } {
  const facilityIncidents = incidents
    .filter((incident) => incident.facilityId === facility.id && incident.status !== 'resolved')
    .sort((left, right) => {
      const severityWeight = { critical: 0, high: 1, medium: 2, low: 3 }
      return severityWeight[left.severity] - severityWeight[right.severity]
    })
  const leadingIncident = facilityIncidents[0]
  if (leadingIncident) {
    return {
      state: leadingIncident.severity === 'critical' ? 'critical' : 'attention',
      reason: leadingIncident.title,
    }
  }

  const leadingRisk = risks
    .filter(
      (risk) =>
        risk.facilityId === facility.id &&
        isRiskActiveAt(risk, asOf) &&
        ['new', 'acknowledged'].includes(risk.status) &&
        ['high', 'critical'].includes(risk.severity),
    )
    .sort((left, right) => right.probability - left.probability)[0]
  if (leadingRisk) {
    return { state: 'forecast', reason: leadingRisk.predictedEvent }
  }

  return { state: facility.status, reason: facility.statusReason }
}

function metric(
  state: DemoState,
  code: string,
  label: string,
  value: number,
  definition: string,
  route: string,
  filters: Record<string, string>,
): DashboardMetric {
  return {
    code,
    label,
    value,
    unit: 'шт.',
    period: { from: hoursBefore(state.demoClockIso, 24), to: state.demoClockIso },
    comparison: null,
    definition,
    updatedAt: state.demoClockIso,
    dataState: 'actual',
    provenance: {
      origin: 'derived',
      environment: 'synthetic_demo',
      sourceLabel: 'Расчёт Contour по демонстрационному состоянию',
      asOf: state.demoClockIso,
      note: 'Показатель предназначен только для демонстрации интерфейса',
    },
    drilldown: { route, filters },
  }
}

export function selectDashboardMetrics(state: DemoState, user: User): DashboardMetric[] {
  const facilities = Object.values(state.facilities).filter((facility) =>
    canAccessFacility(state, user, facility.id),
  )
  const facilityIds = new Set(facilities.map((facility) => facility.id))
  const orders = Object.values(state.workOrders).filter(
    (order) => facilityIds.has(order.target.facilityId) && canAccessWorkOrder(state, user, order),
  )
  const risks = Object.values(state.risks).filter((risk) => facilityIds.has(risk.facilityId))
  const incidents = Object.values(state.incidents).filter((incident) => facilityIds.has(incident.facilityId))
  const orderRiskIds = new Set(
    orders
      .filter(
        (order) =>
          order.source.type === 'risk' &&
          order.status !== 'cancelled',
      )
      .map((order) => order.source.id)
      .filter((id): id is string => Boolean(id)),
  )
  const from = Date.parse(hoursBefore(state.demoClockIso, 24))
  const to = Date.parse(state.demoClockIso)

  const highRiskFacilityIds = new Set(risks.filter(
    (risk) =>
      ['high', 'critical'].includes(risk.severity) &&
      ['new', 'acknowledged'].includes(risk.status) &&
      isRiskActiveAt(risk, state.demoClockIso) &&
      !orderRiskIds.has(risk.id),
  ).map((risk) => risk.facilityId))
  const criticalIncidentFacilityIds = new Set(incidents.filter(
    (incident) => incident.severity === 'critical' && incident.status !== 'resolved',
  ).map((incident) => incident.facilityId))
  const overdueOrders = orders.filter(
    (order) => order.status !== 'closed' && order.status !== 'cancelled' && order.sla?.state === 'breached',
  ).length
  const openOrders = orders.filter(
    (order) => order.status !== 'closed' && order.status !== 'cancelled' && order.status !== 'draft',
  ).length
  const closedIn24Hours = orders.filter((order) => {
    if (!order.closedAt) return false
    const closedAt = Date.parse(order.closedAt)
    return closedAt >= from && closedAt <= to
  }).length

  return [
    metric(
      state,
      'critical_incidents_now',
      'Критические объекты',
      criticalIncidentFacilityIds.size,
      'Объекты с подтверждёнными критическими инцидентами, которые ещё не разрешены',
      '/city/list',
      { incident: 'critical_open' },
    ),
    metric(
      state,
      'high_risks_without_action',
      'Высокий риск без заявки',
      highRiskFacilityIds.size,
      'Объекты с активными высокими или критическими прогнозными рисками без заявки',
      '/city/list',
      { risk: 'high_without_action' },
    ),
    metric(
      state,
      'overdue_work_orders',
      'Просроченные заявки',
      overdueOrders,
      'Незакрытые заявки с нарушенным контрольным сроком SLA',
      '/work-orders',
      { preset: 'attention', sla: 'breached' },
    ),
    metric(
      state,
      'open_work_orders',
      'Открытые заявки',
      openOrders,
      'Все отправленные заявки, которые ещё не закрыты и не отменены',
      '/work-orders',
      { preset: 'active' },
    ),
    metric(
      state,
      'closed_work_orders_24h',
      'Закрыто за 24 часа',
      closedIn24Hours,
      'Заявки, закрытые за последние 24 часа относительно demo clock',
      '/work-orders',
      {
        preset: 'closed',
        closedFrom: hoursBefore(state.demoClockIso, 24),
        closedTo: state.demoClockIso,
      },
    ),
  ]
}
