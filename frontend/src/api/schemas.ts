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
  display_name: z.string(),
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
  entity_type: z.string(),
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
})

export const sensorDetailSchema = sensorListItemSchema.extend({
  hierarchy_path: z.array(z.string()),
  current_reading: z.object({
    value: z.string(),
    numeric_value: z.number().nullable(),
    unit: nullableString,
    measured_at: isoDateTime,
  }).nullable(),
  current_state: z.string(),
  forecast_summary: nullableString,
  data_health: z.string(),
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
    type: z.string(),
    id: z.string(),
    facility_id: nullableString,
  }),
  as_of: isoDateTime,
  lead_min_hours: z.number(),
  horizon_hours: z.number(),
  prediction_window: z.object({ start: isoDateTime, end: isoDateTime }),
  probability: z.number(),
  threshold: z.number(),
  alert: z.boolean().nullable().optional(),
  model_threshold: z.number().nullable().optional(),
  risk_level: z.string(),
  priority_score: z.number(),
  decision_status: z.string(),
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

export const workOrderSchema = z.object({
  id: z.string(),
  display_number: z.string(),
  source_risk_id: nullableString,
  facility_id: nullableString,
  target_entity_type: z.string(),
  target_entity_id: z.string(),
  work_type: z.string(),
  priority: z.string(),
  due_at: isoDateTime,
  description: z.string(),
  comment: nullableString,
  status: z.string(),
  created_by: z.string(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  version: z.number().int(),
})

export const workOrderListSchema = z.object({
  data: z.array(workOrderSchema),
  meta: listMetaSchema,
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
export type ApiAuditEntry = z.infer<typeof auditEntrySchema>
