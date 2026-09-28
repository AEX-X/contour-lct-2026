import type {
  Capability,
  CurrentUser,
  DemoState,
  FacilityAssignment,
  User,
  WorkOrder,
  WorkOrderAction,
} from './types'

export function hasCapability(user: Pick<User, 'permissions'>, capability: Capability): boolean {
  return user.permissions.includes(capability)
}

function isBetween(value: string, start: string, end: string): boolean {
  const timestamp = Date.parse(value)
  return timestamp >= Date.parse(start) && timestamp < Date.parse(end)
}

export function getActiveFacilityAssignment(
  state: DemoState,
  dispatcherId: string,
  facilityId?: string,
): FacilityAssignment | null {
  return (
    Object.values(state.facilityAssignments).find(
      (assignment) =>
        assignment.dispatcherId === dispatcherId &&
        assignment.status === 'active' &&
        (!facilityId || assignment.facilityId === facilityId) &&
        isBetween(state.demoClockIso, assignment.startsAt, assignment.endsAt),
    ) ?? null
  )
}

export function canAccessFacility(
  state: DemoState,
  user: User,
  facilityId: string,
): boolean {
  if (!state.facilities[facilityId]) return false

  switch (user.scope.type) {
    case 'all_facilities':
      return hasCapability(user, 'facility.read.all')
    case 'operational_unit':
      return (
        hasCapability(user, 'facility.read.unit') &&
        user.scope.facilityIds.includes(facilityId)
      )
    case 'single_facility':
      return (
        hasCapability(user, 'facility.read.assigned') &&
        user.scope.facilityIds.includes(facilityId) &&
        getActiveFacilityAssignment(state, user.id, facilityId) !== null
      )
    case 'maintenance_organization':
      return hasCapability(user, 'facility.technical_context.read') && Object.values(state.workOrders).some(
        (order) =>
          order.target.facilityId === facilityId &&
          order.maintenanceOrganizationId === user.organizationId &&
          !['draft', 'closed', 'cancelled'].includes(order.status),
      )
    case 'work_order_grants':
      return hasCapability(user, 'facility.read.temporary') && Object.values(state.accessGrants).some(
        (grant) =>
          grant.userId === user.id &&
          grant.facilityId === facilityId &&
          grant.status === 'active' &&
          !grant.revokedAt &&
          (!grant.expiresAt || Date.parse(state.demoClockIso) < Date.parse(grant.expiresAt)),
      )
    default:
      return false
  }
}

export function canAccessWorkOrder(
  state: DemoState,
  user: User,
  order: WorkOrder,
): boolean {
  if (user.role === 'maintenance_coordinator') {
    return order.maintenanceOrganizationId === user.organizationId && order.status !== 'draft'
  }

  if (user.role === 'engineer') {
    const assignment = order.currentAssignment
    const assignmentAllowsSummary =
      order.status !== 'closed' &&
      order.status !== 'cancelled' &&
      assignment?.engineerId === user.id &&
      ['assigned', 'accepted', 'completed'].includes(assignment.status)
    const grantAllowsAccess = Object.values(state.accessGrants).some(
      (grant) =>
        grant.userId === user.id &&
        grant.workOrderId === order.id &&
        ['scheduled', 'active'].includes(grant.status) &&
        !grant.revokedAt &&
        Date.parse(grant.startsAt) <= Date.parse(state.demoClockIso) &&
        (!grant.expiresAt || Date.parse(state.demoClockIso) < Date.parse(grant.expiresAt)),
    )
    const activeFacilityGrantAllowsContext = Object.values(state.accessGrants).some(
      (grant) =>
        grant.userId === user.id &&
        grant.facilityId === order.target.facilityId &&
        grant.status === 'active' &&
        !grant.revokedAt &&
        Date.parse(grant.startsAt) <= Date.parse(state.demoClockIso) &&
        (!grant.expiresAt || Date.parse(state.demoClockIso) < Date.parse(grant.expiresAt)),
    )
    return (
      assignmentAllowsSummary || grantAllowsAccess || activeFacilityGrantAllowsContext
    )
  }

  return canAccessFacility(state, user, order.target.facilityId)
}

const ACTION_CAPABILITY: Record<WorkOrderAction, Capability> = {
  edit: 'work_order.edit_draft',
  submit: 'work_order.submit',
  start_triage: 'work_order.triage',
  request_clarification: 'work_order.request_clarification',
  resubmit_clarification: 'work_order.submit',
  finalize_priority: 'work_order.priority.finalize',
  assign: 'work_order.assign_engineer',
  reassign: 'work_order.reassign_engineer',
  accept: 'work_order.accept_assignment',
  decline: 'work_order.decline_assignment',
  mark_en_route: 'work_order.execute',
  start_work: 'work_order.execute',
  wait_access: 'work_order.execute',
  wait_parts: 'work_order.execute',
  resume_work: 'work_order.execute',
  submit_result: 'work_order.submit_result',
  start_verification: 'work_order.verify',
  return_for_rework: 'work_order.return_for_rework',
  close: 'work_order.close',
  cancel: 'work_order.cancel',
  override: 'work_order.override',
}

function statusActions(order: WorkOrder): WorkOrderAction[] {
  switch (order.status) {
    case 'draft':
      return ['edit', 'submit', 'cancel', 'override']
    case 'submitted':
      return ['start_triage', 'cancel', 'override']
    case 'triage':
      return [
        'request_clarification',
        ...(order.finalPriority && order.sla ? [] : ['finalize_priority' as const]),
        'assign',
        'cancel',
        'override',
      ]
    case 'needs_clarification':
      return ['resubmit_clarification', 'cancel', 'override']
    case 'assigned':
      return ['accept', 'decline', 'reassign', 'cancel', 'override']
    case 'accepted':
      return ['mark_en_route', 'reassign', 'cancel', 'override']
    case 'en_route':
      return ['start_work', 'reassign', 'cancel', 'override']
    case 'in_progress':
      return ['wait_access', 'wait_parts', 'submit_result', 'reassign', 'cancel', 'override']
    case 'waiting_access':
    case 'waiting_parts':
      return ['resume_work', 'reassign', 'cancel', 'override']
    case 'completed_by_engineer':
      return ['start_verification', 'override']
    case 'verification':
      return ['return_for_rework', 'close', 'override']
    case 'rework':
      return ['resume_work', 'reassign', 'cancel', 'override']
    case 'closed':
    case 'cancelled':
      return []
  }
}

function actorMayOwnAction(user: User, order: WorkOrder, action: WorkOrderAction): boolean {
  if (action === 'override') return user.role === 'manager'

  const isRepairExecution = [
    'accept',
    'decline',
    'mark_en_route',
    'start_work',
    'wait_access',
    'wait_parts',
    'resume_work',
    'submit_result',
  ].includes(action)

  if (isRepairExecution) {
    return user.role === 'engineer' && order.currentAssignment?.engineerId === user.id
  }

  if (action === 'start_triage' || action === 'request_clarification' || action === 'finalize_priority') {
    return user.role === 'maintenance_coordinator' || user.role === 'manager'
  }

  if (action === 'assign' || action === 'reassign') {
    return user.role === 'maintenance_coordinator' || user.role === 'manager'
  }

  if (action === 'start_verification' || action === 'return_for_rework' || action === 'close') {
    return ['facility_dispatcher', 'senior_dispatcher', 'manager'].includes(user.role)
  }

  if (action === 'edit' || action === 'submit' || action === 'resubmit_clarification') {
    return (
      order.creator.id === user.id ||
      ['facility_dispatcher', 'senior_dispatcher', 'manager'].includes(user.role)
    )
  }

  if (action === 'cancel') {
    if (user.role === 'manager' || user.role === 'maintenance_coordinator') return true
    if (user.role === 'senior_dispatcher') return order.status !== 'in_progress'
    return user.role === 'facility_dispatcher' && ['draft', 'submitted', 'triage'].includes(order.status)
  }

  return false
}

export function computeAllowedActions(
  state: DemoState,
  user: User,
  order: WorkOrder,
): WorkOrderAction[] {
  if (!canAccessWorkOrder(state, user, order)) return []

  return statusActions(order).filter((action) => {
    if (!hasCapability(user, ACTION_CAPABILITY[action])) return false
    if (!actorMayOwnAction(user, order, action)) return false
    if (action === 'assign' && (!order.finalPriority || !order.sla)) return false
    if (user.role === 'engineer') {
      const grant = order.accessGrant ? state.accessGrants[order.accessGrant.id] ?? order.accessGrant : null
      const grantInTime = Boolean(
        grant &&
        !grant.revokedAt &&
        Date.parse(grant.startsAt) <= Date.parse(state.demoClockIso) &&
        (!grant.expiresAt || Date.parse(state.demoClockIso) < Date.parse(grant.expiresAt)),
      )
      if (action === 'accept' && (!grantInTime || grant?.status !== 'scheduled')) return false
      if (
        ['mark_en_route', 'start_work', 'wait_access', 'wait_parts', 'resume_work', 'submit_result'].includes(action) &&
        (!grantInTime || grant?.status !== 'active')
      ) {
        return false
      }
    }
    return true
  })
}

export function materializeCurrentUser(state: DemoState, user: User): CurrentUser {
  const organization = state.organizations[user.organizationId]
  if (!organization) {
    throw new Error(`Organization ${user.organizationId} is missing for user ${user.id}`)
  }
  return {
    ...user,
    organization,
    activeAccessGrants: Object.values(state.accessGrants).filter(
      (grant) =>
        grant.userId === user.id &&
        grant.status === 'active' &&
        !grant.revokedAt &&
        Date.parse(grant.startsAt) <= Date.parse(state.demoClockIso) &&
        (!grant.expiresAt || Date.parse(state.demoClockIso) < Date.parse(grant.expiresAt)),
    ),
  }
}
