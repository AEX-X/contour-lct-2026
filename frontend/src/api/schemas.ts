import { z } from 'zod'

const isoDateTime = z.string().min(1)
const nullableString = z.string().nullable()

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    trace_id: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    retryable: z.boolean().optional(),
  }),
})

export const loginResponseSchema = z.object({ token: z.string().min(1) })

export const meSchema = z.object({
  user_id: z.string().optional(),
  display_name: z.string().optional(),
  organization_id: z.string().optional(),
  organization_name: z.string().optional(),
  specialization_codes: z.array(z.string()).optional(),
  availability: z.enum(['available', 'busy', 'off_shift']).optional(),
  role: z.string(),
  permissions: z.array(z.string()),
  scope: z.object({
    type: z.string(),
    facility_ids: z.array(z.string()).nullable().optional(),
  }),
  timezone: z.string(),
  locale: z.string(),
})

const listMetaSchema = z.object({
  next_cursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  generated_at: isoDateTime,
})

export const facilitySchema = z.object({
  id: z.string(),
  version: z.number().int().positive().optional(),
  display_name: z.string(),
  address: z.string().nullable().optional(),
  internal_code: z.string().nullable().optional(),
  rosta_code: z.string().nullable().optional(),
  operational_unit_id: z.string().nullable().optional(),
  responsible_dispatcher_id: z.string().nullable().optional(),
  facility_type: z.string(),
  location: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
    is_demo: z.boolean(),
  }),
  current_state: z.string(),
  forecast: z.object({
    risk_level: z.string(),
    max_probability: z.number(),
    active_count: z.number().int(),
    earliest_window_start: nullableString,
  }),
  incidents: z.object({
    open_count: z.number().int(),
    critical_count: z.number().int(),
  }),
  assets: z.object({
    collector_count: z.number().int(),
    sensor_count: z.number().int(),
    offline_sensor_count: z.number().int(),
  }),
  data_health: z.object({
    freshness: z.string(),
    last_event_at: nullableString,
    coverage: z.number(),
  }),
  priority_score: z.number(),
  source_health: z.array(z.object({
    source: z.string(),
    display_name: z.string(),
    status: z.string(),
    last_success_at: nullableString,
    delay_seconds: z.number().int().nullable(),
  })),
  updated_at: isoDateTime,
})

export const facilityListSchema = z.object({
  data: z.array(facilitySchema),
  meta: listMetaSchema,
})

export const hierarchyNodeSchema = z.object({
  id: z.string(),
  parent_id: nullableString,
  entity_type: z.enum(['facility', 'building', 'collector', 'section', 'room', 'equipment', 'sensor']),
  entity_id: z.string(),
  display_name: z.string(),
  path: z.array(z.string()),
  children_count: z.number().int(),
  sensor_count: z.number().int(),
  attention_count: z.number().int(),
  current_state: z.string(),
  risk_level: z.string(),
  has_children: z.boolean(),
})

export const hierarchySchema = z.array(hierarchyNodeSchema)

export const layoutSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.object({
    type: z.literal('Feature'),
    geometry: z.object({
      type: z.literal('Point'),
      coordinates: z.tuple([z.number(), z.number()]),
    }),
    properties: z.object({
      id: z.string(),
      parent_id: nullableString,
      entity_type: z.string(),
      entity_id: z.string(),
      display_name: z.string(),
      is_demo: z.boolean(),
    }),
  })),
})

const sensorCurrentReadingSchema = z.object({
  value: z.string(),
  numeric_value: z.number().nullable(),
  unit: nullableString,
  measured_at: isoDateTime,
})

export const sensorListItemSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  tag: z.string(),
  sensor_type: z.string(),
  system_type: z.string(),
  value_type: z.string(),
  display_name: z.string(),
  facility_id: nullableString,
  hierarchy_node_id: nullableString,
  has_geolocation: z.boolean().default(false),
  position: z.null().optional(),
  current_reading: sensorCurrentReadingSchema.nullable().default(null),
  current_state: z.string().default('unknown'),
  data_health: z.string().default('unavailable'),
})

export const sensorDetailSchema = sensorListItemSchema.extend({
  hierarchy_path: z.array(z.string()),
  forecast_summary: nullableString,
  maintenance_state: z.string(),
})

export const sensorListSchema = z.object({
  data: z.array(sensorListItemSchema),
  meta: listMetaSchema,
})

export const numericSeriesSchema = z.object({
  value_type: z.literal('numeric'),
  points: z.array(z.object({
    timestamp: isoDateTime,
    value: z.number(),
    state: z.string(),
    quality: z.string(),
  })),
  thresholds: z.array(z.object({ kind: z.string(), value: z.number() })),
  missing_intervals: z.array(z.object({ from: isoDateTime, to: isoDateTime })),
})

export const categoricalSeriesSchema = z.object({
  value_type: z.literal('categorical'),
  intervals: z.array(z.object({
    from: isoDateTime,
    to: isoDateTime,
    value: z.string(),
    state: z.string(),
  })),
})

export const sensorSeriesSchema = z.discriminatedUnion('value_type', [
  numericSeriesSchema,
  categoricalSeriesSchema,
])

export const riskSchema = z.object({
  id: z.string(),
  forecast_id: z.string(),
  risk_type: z.string(),
  target: z.object({
    type: z.enum(['sensor', 'facility']),
    id: z.string(),
    facility_id: nullableString,
  }),
  as_of: isoDateTime,
  demo_clock: z.object({
    requested_as_of_utc: isoDateTime,
    anchor_utc: isoDateTime,
  }).nullable().optional(),
  is_invalidated: z.boolean().default(false),
  lead_min_hours: z.number(),
  horizon_hours: z.number(),
  prediction_window: z.object({ start: isoDateTime, end: isoDateTime }),
  probability: z.number(),
  threshold: z.number(),
  alert: z.boolean().nullable().optional(),
  model_threshold: z.number().nullable().optional(),
  risk_level: z.enum(['low', 'medium', 'high', 'critical']),
  priority_score: z.number(),
  decision_status: z.enum(['open', 'acknowledged', 'confirmed', 'rejected', 'deferred', 'resolved']),
  sla_due_at: isoDateTime,
  data_health: z.string(),
  model: z.string(),
  top_factors: z.array(z.string()),
  recommendation: z.string(),
  version: z.number().int(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
})

export const riskListSchema = z.object({
  data: z.array(riskSchema),
  meta: listMetaSchema,
})

export const eventSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  source: z.string(),
  facility_id: nullableString,
  sensor_id: z.string(),
  occurred_at: isoDateTime,
  ingested_at: isoDateTime,
  state: z.string(),
  value: z.string(),
  is_confirmed_incident: z.boolean(),
  verification_result: nullableString,
  resolved_at: nullableString,
  related_risk_id: nullableString,
})

export const eventListSchema = z.object({
  data: z.array(eventSchema),
  meta: listMetaSchema,
})

const apiUserRefSchema = z.object({
  id: z.string(),
  display_name: z.string(),
})

const workOrderAssignmentSchema = z.object({
  id: z.string(),
  work_order_id: z.string(),
  engineer_id: z.string(),
  assigned_by: apiUserRefSchema,
  assigned_at: isoDateTime,
  accepted_at: isoDateTime.nullable(),
  declined_at: isoDateTime.nullable(),
  decline_reason: nullableString,
  completed_at: isoDateTime.nullable(),
  status: z.enum(['assigned', 'accepted', 'declined', 'completed', 'superseded', 'cancelled']),
  version: z.number().int().positive(),
})

const accessGrantSchema = z.object({
  id: z.string(),
  work_order_id: z.string(),
  facility_id: z.string(),
  user_id: z.string(),
  access_level: z.literal('technical_full'),
  starts_at: isoDateTime,
  expires_at: isoDateTime.nullable(),
  revoked_at: isoDateTime.nullable(),
  status: z.enum(['scheduled', 'active', 'expired', 'revoked']),
  offline_cache_expires_at: isoDateTime.nullable(),
  version: z.number().int().positive(),
})

const partUsageSchema = z.object({
  part_code: z.string(),
  name: z.string(),
  quantity: z.number().nonnegative(),
  unit: z.string(),
})

const repairResultSchema = z.object({
  failure_confirmed: z.boolean().nullable(),
  root_cause_code: nullableString,
  diagnosis: z.string(),
  actions: z.array(z.string()),
  parts: z.array(partUsageSchema),
  labor_minutes: z.number().int().nonnegative().nullable(),
  equipment_restored: z.boolean().nullable(),
  control_check_result: nullableString,
  residual_risk: z.enum(['none', 'low', 'medium', 'high']).nullable(),
  recommendations: z.string(),
  requires_follow_up: z.boolean(),
  completed_at: isoDateTime.nullable(),
  author: apiUserRefSchema.nullable(),
})

const slaStateSchema = z.object({
  policy_id: z.string(),
  started_at: isoDateTime.nullable(),
  acceptance_due_at: isoDateTime.nullable(),
  arrival_due_at: isoDateTime.nullable(),
  resolution_due_at: isoDateTime.nullable(),
  current_stage: z.enum(['acceptance', 'arrival', 'resolution', 'completed']),
  state: z.enum(['on_track', 'at_risk', 'breached', 'paused', 'completed', 'not_applicable']),
  paused_at: isoDateTime.nullable(),
  pause_reason: nullableString,
  breach_stage: z.enum(['acceptance', 'arrival', 'resolution']).nullable(),
  remaining_seconds: z.number().int().nullable(),
  server_time: isoDateTime,
})

export const workOrderSchema = z.object({
  id: z.string(),
  display_number: z.string(),
  source_risk_id: nullableString,
  facility_id: nullableString,
  target_entity_type: z.enum(['sensor', 'facility', 'hierarchy_node', 'building', 'collector', 'section', 'equipment']),
  target_entity_id: z.string(),
  work_type: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'critical', 'P1', 'P2', 'P3', 'P4', 'p1', 'p2', 'p3', 'p4']),
  due_at: isoDateTime,
  description: z.string(),
  symptoms: z.array(z.string()).default([]),
  comment: nullableString,
  status: z.enum([
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
    'ready',
    'completed',
    'integration_error',
  ]),
  created_by: z.string(),
  creator: apiUserRefSchema.nullable().optional(),
  responsible_dispatcher: apiUserRefSchema.nullable().optional(),
  coordinator: apiUserRefSchema.nullable().optional(),
  assigned_engineer_id: nullableString.optional(),
  coordinator_id: nullableString.optional(),
  submitted_at: isoDateTime.nullable().optional(),
  closed_at: isoDateTime.nullable().optional(),
  sla_policy_id: nullableString.optional(),
  sla: slaStateSchema.nullable().optional(),
  active_assignment: workOrderAssignmentSchema.nullable().optional(),
  access_grant: accessGrantSchema.nullable().optional(),
  repair_result: repairResultSchema.nullable().optional(),
  estimated_cost_minor: z.number().int().nullable().optional(),
  actual_cost_minor: z.number().int().nullable().optional(),
  allowed_actions: z.array(z.string()).optional(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  version: z.number().int(),
})

export const workOrderListSchema = z.object({
  data: z.array(workOrderSchema),
  meta: listMetaSchema,
})

export const workOrderActionResponseSchema = z.object({
  work_order: workOrderSchema,
  applied_action: z.string(),
  audit_event_id: z.string(),
})

const engineerCandidateSchema = z.object({
  user: z.object({
    id: z.string(),
    display_name: z.string(),
    availability: z.enum(['available', 'busy', 'off_shift']),
    specialization_codes: z.array(z.string()),
  }),
  active_work_order_count: z.number().int().nonnegative(),
  eligible: z.boolean(),
  eligibility_reason: z.string(),
})

const compactListMetaSchema = z.object({
  total: z.number().int().nonnegative(),
  generated_at: isoDateTime,
})

export const engineerCandidateListSchema = z.object({
  data: z.array(engineerCandidateSchema),
  meta: compactListMetaSchema,
})

export const notificationSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  type: z.string(),
  priority: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  body: z.string(),
  entity_type: z.string(),
  entity_id: z.string(),
  deep_link: z.string(),
  created_at: isoDateTime,
  read_at: isoDateTime.nullable(),
  group_key: nullableString,
})

export const notificationListSchema = z.object({
  data: z.array(notificationSchema),
  meta: compactListMetaSchema.extend({ unread: z.number().int().nonnegative() }),
})

export const facilityDispatcherListSchema = z.object({
  data: z.array(apiUserRefSchema),
  meta: compactListMetaSchema.optional(),
})

const facilityAssignmentSchema = z.object({
  id: z.string(),
  facility_id: z.string(),
  dispatcher_id: z.string(),
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']),
  assigned_by: apiUserRefSchema,
  version: z.number().int().positive(),
})

export const facilityDispatcherAssignmentResponseSchema = z.object({
  assignment: facilityAssignmentSchema,
  facility_id: z.string(),
  facility_version: z.number().int().positive().optional(),
  audit_event_id: z.string(),
})

export const auditEntrySchema = z.object({
  id: z.number().int(),
  occurred_at: isoDateTime,
  user_id: nullableString,
  username: nullableString,
  action: z.string(),
  target_type: nullableString,
  target_id: nullableString,
  result: z.string(),
  status_code: z.number().int(),
  ip: nullableString,
  trace_id: z.string(),
  details: z.record(z.string(), z.unknown()).nullable(),
})

export const auditListSchema = z.object({
  data: z.array(auditEntrySchema),
  meta: listMetaSchema,
})

export type ApiFacility = z.infer<typeof facilitySchema>
export type ApiHierarchyNode = z.infer<typeof hierarchyNodeSchema>
export type ApiLayout = z.infer<typeof layoutSchema>
export type ApiSensorListItem = z.infer<typeof sensorListItemSchema>
export type ApiSensorDetail = z.infer<typeof sensorDetailSchema>
export type ApiSensorSeries = z.infer<typeof sensorSeriesSchema>
export type ApiRisk = z.infer<typeof riskSchema>
export type ApiEvent = z.infer<typeof eventSchema>
export type ApiWorkOrder = z.infer<typeof workOrderSchema>
export type ApiWorkOrderActionResponse = z.infer<typeof workOrderActionResponseSchema>
export type ApiEngineerCandidate = z.infer<typeof engineerCandidateSchema>
export type ApiNotification = z.infer<typeof notificationSchema>
export type ApiFacilityAssignment = z.infer<typeof facilityAssignmentSchema>
export type ApiAuditEntry = z.infer<typeof auditEntrySchema>
