import { describe, expect, it, vi } from 'vitest'
import { CONTOUR_AUTH_REQUIRED_EVENT } from '../api/ContourApiClient'
import type { RepositoryError } from '../domain'
import { createMemoryStorage } from './memoryStorage'
import { createApiContourRepository } from './ApiContourRepository'

function json(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'trace-test' },
  })
}

const mePayload = {
  user_id: 'usr-manager',
  display_name: 'Руководитель смены',
  organization_id: 'org-moscollector',
  specialization_codes: [],
  availability: 'available',
  role: 'manager',
  permissions: [
    'facility.read.all',
    'sensor.read',
    'risk.read',
    'risk.acknowledge',
    'work_order.read',
    'work_order.create_draft',
    'audit.read',
  ],
  scope: { type: 'all_facilities' },
  timezone: 'Europe/Moscow',
  locale: 'ru-RU',
}

const fullWorkOrderPayload = {
  id: 'wo-1',
  display_number: 'WO-2026-0001',
  source_risk_id: 'risk-1',
  facility_id: 'fac-1',
  target_entity_type: 'equipment',
  target_entity_id: 'equipment-1',
  work_type: 'repair',
  priority: 'high',
  due_at: '2026-09-28T20:00:00Z',
  description: 'Проверить насос и устранить причину перегрева корпуса',
  symptoms: ['Перегрев корпуса'],
  comment: 'Нужен доступ к насосной',
  status: 'assigned',
  created_by: 'usr-dispatcher',
  assigned_engineer_id: 'usr-engineer',
  coordinator_id: 'usr-coordinator',
  submitted_at: '2026-09-27T20:05:00Z',
  closed_at: null,
  sla_policy_id: 'sla-P2',
  sla: {
    policy_id: 'sla-P2',
    started_at: '2026-09-27T20:05:00Z',
    acceptance_due_at: '2026-09-27T20:35:00Z',
    arrival_due_at: '2026-09-27T22:05:00Z',
    resolution_due_at: '2026-09-28T20:00:00Z',
    current_stage: 'acceptance',
    state: 'on_track',
    paused_at: null,
    pause_reason: null,
    breach_stage: null,
    remaining_seconds: 1200,
    server_time: '2026-09-27T20:15:00Z',
  },
  repair_result: null,
  active_assignment: {
    id: 'asg-1',
    work_order_id: 'wo-1',
    engineer_id: 'usr-engineer',
    assigned_by: { id: 'usr-coordinator', display_name: 'Координатор' },
    assigned_at: '2026-09-27T20:10:00Z',
    accepted_at: null,
    declined_at: null,
    decline_reason: null,
    completed_at: null,
    status: 'assigned',
    version: 1,
  },
  access_grant: {
    id: 'grant-1',
    work_order_id: 'wo-1',
    facility_id: 'fac-1',
    user_id: 'usr-engineer',
    access_level: 'technical_full',
    starts_at: '2026-09-27T20:10:00Z',
    expires_at: '2026-09-29T20:00:00Z',
    revoked_at: null,
    status: 'active',
    offline_cache_expires_at: '2026-09-29T22:00:00Z',
    version: 1,
  },
  allowed_actions: ['accept', 'decline'],
  created_at: '2026-09-27T20:00:00Z',
  updated_at: '2026-09-27T20:10:00Z',
  version: 4,
}

const facilityPayload = {
  id: 'fac-1',
  display_name: 'Коллектор № 1',
  facility_type: 'collector',
  location: { type: 'Point', coordinates: [37.62, 55.75], is_demo: true },
  current_state: 'unknown',
  forecast: {
    risk_level: 'high',
    max_probability: 0.82,
    active_count: 1,
    earliest_window_start: '2026-09-28T08:00:00Z',
  },
  incidents: { open_count: 0, critical_count: 0 },
  assets: { collector_count: 1, sensor_count: 14, offline_sensor_count: 1 },
  data_health: { freshness: 'fresh', last_event_at: '2026-09-27T20:00:00Z', coverage: 0.94 },
  priority_score: 0.82,
  source_health: [],
  updated_at: '2026-09-27T20:00:00Z',
}

const riskPayload = {
  id: 'risk-1',
  forecast_id: 'forecast-1',
  risk_type: 'flooding',
  target: { type: 'facility', id: 'fac-1', facility_id: 'fac-1' },
  as_of: '2026-09-27T20:00:00Z',
  demo_clock: {
    requested_as_of_utc: '2026-09-28T20:00:00Z',
    anchor_utc: '2026-09-27T00:00:00Z',
  },
  lead_min_hours: 24,
  horizon_hours: 72,
  prediction_window: { start: '2026-09-28T20:00:00Z', end: '2026-09-30T20:00:00Z' },
  probability: 0.82,
  threshold: 0.7,
  alert: true,
  model_threshold: 0.7,
  risk_level: 'high',
  priority_score: 0.82,
  decision_status: 'open',
  sla_due_at: '2026-09-28T20:00:00Z',
  data_health: 'fresh',
  model: 'object-incident-72h',
  top_factors: ['Рост срабатываний датчиков затопления'],
  recommendation: 'Проверить участок и насосное оборудование',
  version: 3,
  created_at: '2026-09-27T20:00:00Z',
  updated_at: '2026-09-27T20:00:00Z',
}

function createBackendFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/auth/login') {
      expect(init?.method).toBe('POST')
      return json({ token: 'session-token' })
    }
    if (url === '/api/v1/me') {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-token')
      return json(mePayload)
    }
    if (url.startsWith('/api/v1/facilities?')) {
      return json({
        data: [facilityPayload],
        meta: { next_cursor: null, total: 1, generated_at: '2026-09-27T20:00:00Z' },
      })
    }
    if (url.startsWith('/api/v1/risks?')) {
      return json({
        data: [riskPayload],
        meta: { next_cursor: null, total: 1, generated_at: '2026-09-27T20:00:00Z' },
      })
    }
    if (url === '/api/v1/risks/risk-1/acknowledge') {
      expect(JSON.parse(String(init?.body))).toEqual({ expected_version: 3 })
      return json({
        ...riskPayload,
        decision_status: 'acknowledged',
        version: 4,
        updated_at: '2026-09-27T20:05:00Z',
      })
    }
    if (url === '/api/v1/work-orders') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(init?.method).toBe('POST')
      expect(body).toMatchObject({
        mode: 'draft',
        source_risk_id: 'risk-1',
        facility_id: 'fac-1',
        target_entity_type: 'equipment',
        target_entity_id: 'equipment-1',
        work_type: 'repair',
        priority: 'high',
        symptoms: ['Перегрев корпуса'],
        comment: null,
        idempotency_key: 'create-1',
        client_occurred_at: '2026-09-27T20:00:00Z',
      })
      return json({
        id: 'wo-1',
        display_number: 'WO-2026-0001',
        source_risk_id: 'risk-1',
        facility_id: 'fac-1',
        target_entity_type: body.target_entity_type,
        target_entity_id: body.target_entity_id,
        work_type: body.work_type,
        priority: body.priority,
        due_at: body.due_at,
        description: body.description,
        symptoms: body.symptoms,
        comment: body.comment,
        status: 'draft',
        created_by: 'manager',
        created_at: '2026-09-27T20:00:00Z',
        updated_at: '2026-09-27T20:00:00Z',
        version: 1,
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
}

function createLifecycleFetch(role = 'engineer') {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
    if (url === '/api/v1/me') {
      return json({
        ...mePayload,
        user_id: role === 'engineer' ? 'usr-engineer' : `usr-${role}`,
        display_name: role === 'engineer' ? 'Иван Инженеров' : role,
        organization_id: role === 'engineer' ? 'org-maintenance' : 'org-moscollector',
        specialization_codes: role === 'engineer' ? ['repair'] : [],
        availability: role === 'engineer' ? 'busy' : 'available',
        role,
        permissions: [
          'facility.read.assigned',
          'sensor.read',
          'work_order.read',
          'work_order.accept_assignment',
          'work_order.decline_assignment',
          'work_order.execute',
          'work_order.submit_result',
          'notification.read',
        ],
        scope: { type: role === 'engineer' ? 'work_order_grants' : 'assigned_facilities', facility_ids: ['fac-1'] },
      })
    }
    if (url === '/api/v1/facilities/fac-1') return json(facilityPayload)
    if (url.startsWith('/api/v1/facilities?')) {
      return json({
        data: [facilityPayload],
        meta: { next_cursor: null, total: 1, generated_at: '2026-09-27T20:00:00Z' },
      })
    }
    if (url === '/api/v1/work-orders/wo-1') return json(fullWorkOrderPayload)
    if (url === '/api/v1/work-orders?assigned_to_current_user=true&limit=200') {
      return json({
        data: [fullWorkOrderPayload],
        meta: { next_cursor: null, total: 1, generated_at: '2026-09-27T20:15:00Z' },
      })
    }
    if (url === '/api/v1/work-orders/wo-1/actions') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toEqual({
        action: 'accept',
        expected_version: 4,
        idempotency_key: 'accept-command-1',
        client_occurred_at: '2026-09-27T20:16:00Z',
        payload: { comment: 'Принято' },
      })
      return json({
        work_order: {
          ...fullWorkOrderPayload,
          status: 'accepted',
          version: 5,
          active_assignment: {
            ...fullWorkOrderPayload.active_assignment,
            status: 'accepted',
            accepted_at: '2026-09-27T20:16:00Z',
            version: 2,
          },
          sla: {
            ...fullWorkOrderPayload.sla,
            current_stage: 'arrival',
            remaining_seconds: 6540,
            server_time: '2026-09-27T20:16:00Z',
          },
          allowed_actions: ['mark_en_route'],
          updated_at: '2026-09-27T20:16:00Z',
        },
        applied_action: 'accept',
        audit_event_id: 'audit-accept-1',
      })
    }
    if (url === '/api/v1/work-orders/wo-1/engineer-candidates' || url === '/api/v1/engineers') {
      return json({
        data: [{
          user: {
            id: 'usr-engineer',
            display_name: 'Иван Инженеров',
            availability: 'busy',
            specialization_codes: ['repair'],
          },
          active_work_order_count: 1,
          eligible: true,
          eligibility_reason: 'Подходит по специализации и доступности',
        }],
        meta: { total: 1, generated_at: '2026-09-27T20:15:00Z' },
      })
    }
    if (url === '/api/v1/notifications') {
      return json({
        data: [{
          id: 'notification-1',
          user_id: 'usr-engineer',
          type: 'work_order_assigned',
          priority: 'warning',
          title: 'Назначена новая заявка',
          body: 'Тебе назначена заявка WO-2026-0001',
          entity_type: 'work_order',
          entity_id: 'wo-1',
          deep_link: '/work-orders/wo-1',
          created_at: '2026-09-27T20:10:00Z',
          read_at: null,
          group_key: 'wo-1',
        }],
        meta: { total: 1, unread: 1, generated_at: '2026-09-27T20:15:00Z' },
      })
    }
    if (url === '/api/v1/notifications/notification-1/read') {
      expect(init?.method).toBe('POST')
      return json({
        id: 'notification-1',
        user_id: 'usr-engineer',
        type: 'work_order_assigned',
        priority: 'warning',
        title: 'Назначена новая заявка',
        body: 'Тебе назначена заявка WO-2026-0001',
        entity_type: 'work_order',
        entity_id: 'wo-1',
        deep_link: '/work-orders/wo-1',
        created_at: '2026-09-27T20:10:00Z',
        read_at: '2026-09-27T20:17:00Z',
        group_key: 'wo-1',
      })
    }
    if (url === '/api/v1/facility-dispatchers') {
      return json({ data: [{ id: 'usr-dispatcher', display_name: 'Анна Диспетчер' }] })
    }
    if (url === '/api/v1/facilities/fac-1/dispatcher-assignment') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        dispatcher_id: 'usr-dispatcher',
        expected_version: 1,
        idempotency_key: 'dispatcher-command-1',
      })
      return json({
        assignment: {
          id: 'facility-assignment-1',
          facility_id: 'fac-1',
          dispatcher_id: 'usr-dispatcher',
          assigned_by: { id: 'usr-manager', display_name: 'Руководитель смены' },
          starts_at: body.starts_at,
          ends_at: body.ends_at,
          status: 'active',
          version: 1,
        },
        facility_id: 'fac-1',
        facility_version: 2,
        audit_event_id: 'audit-dispatcher-1',
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
}

describe('ApiContourRepository', () => {
  it('logs in, maps backend role and keeps server capabilities authoritative', async () => {
    const fetcher = createBackendFetch()
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })

    const user = await repository.login!({ username: 'manager', password: 'secret' })

    expect(user.role).toBe('manager')
    expect(user.scope.type).toBe('all_facilities')
    expect(user.permissions).toContain('facility.read.all')
    expect(user.permissions).toContain('analytics.city.read')
    expect(user.permissions).toContain('work_order.create')
    expect(user.permissions).not.toContain('work_order.submit')
  })

  it('maps facilities without presenting demo coordinates as real', async () => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createBackendFetch() as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const [facility] = await repository.listFacilities()

    expect(facility).toMatchObject({
      id: 'fac-1',
      name: 'Коллектор № 1',
      address: 'Адрес не предоставлен в API',
      sensorAvailability: 0.94,
      position: { lon: 37.62, lat: 55.75 },
    })
    expect(facility?.provenance.environment).toBe('synthetic_demo')
    expect(facility?.provenance.note).toContain('координаты являются демонстрационными')
  })

  it('does not invent numeric factor contributions missing from backend', async () => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createBackendFetch() as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const [risk] = await repository.listRisks()

    expect(risk?.predictedEvent).toBe('Риск подтопления')
    expect(risk?.topFactors[0]).toEqual({
      label: 'Рост срабатываний датчиков затопления',
      contribution: null,
      direction: 'up',
    })
    expect(risk).toMatchObject({
      modelAsOf: '2026-09-27T20:00:00Z',
      demoClock: {
        requestedAsOfUtc: '2026-09-28T20:00:00Z',
        anchorUtc: '2026-09-27T00:00:00Z',
      },
      dataHealth: 'fresh',
    })
    expect(risk?.provenance.note).toContain('Исторический ML-демо')
  })

  it('uses the real optimistic-concurrency acknowledge endpoint', async () => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createBackendFetch() as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const risk = await repository.acknowledgeRisk!('risk-1', {
      expectedVersion: 3,
      idempotencyKey: 'ack-1',
      clientOccurredAt: '2026-09-27T20:05:00Z',
      comment: 'Принято в работу',
    })

    expect(risk.status).toBe('acknowledged')
    expect(risk.version).toBe(4)
  })

  it('translates frontend priority and preserves a concrete target type in the backend contract', async () => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createBackendFetch() as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const order = await repository.createWorkOrder({
      source: { type: 'risk', id: 'risk-1' },
      target: {
        type: 'equipment',
        id: 'equipment-1',
        facilityId: 'fac-1',
        displayName: 'Насос № 1',
        hierarchyPath: [
          { type: 'facility', id: 'fac-1', displayName: 'Коллектор № 1' },
          { type: 'section', id: 'section-1', displayName: 'Насосная' },
        ],
        locationSnapshot: { text: null, geo: null, planPosition: null },
      },
      categoryCode: 'repair',
      symptoms: ['Перегрев корпуса'],
      description: 'Проверить насос и устранить причину перегрева корпуса',
      preliminaryPriority: 'P2',
    }, {
      idempotencyKey: 'create-1',
      clientOccurredAt: '2026-09-27T20:00:00Z',
    })

    expect(order.preliminaryPriority).toBe('P2')
    expect(order.target.type).toBe('equipment')
    expect(order.symptoms).toEqual(['Перегрев корпуса'])
  })

  it.each([
    ['inspection', 'inspection'],
    ['repair', 'repair'],
    ['replacement', 'replacement'],
    ['maintenance', 'maintenance'],
    ['manual_inspection', 'inspection'],
    ['predictive_inspection', 'inspection'],
    ['equipment_fault', 'repair'],
    ['sensor_failure', 'replacement'],
    ['predictive_maintenance', 'maintenance'],
  ])('maps frontend category %s to backend work type %s', async (categoryCode, expectedWorkType) => {
    let submittedWorkType: unknown
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url === '/api/v1/work-orders') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        submittedWorkType = body.work_type
        return json({
          id: `wo-${categoryCode}`,
          display_number: 'WO-2026-0098',
          source_risk_id: null,
          facility_id: 'fac-1',
          target_entity_type: body.target_entity_type,
          target_entity_id: body.target_entity_id,
          work_type: body.work_type,
          priority: body.priority,
          due_at: body.due_at,
          description: body.description,
          symptoms: body.symptoms,
          comment: body.comment,
          status: 'draft',
          created_by: 'usr-manager',
          created_at: '2026-09-27T20:00:00Z',
          updated_at: '2026-09-27T20:00:00Z',
          version: 1,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const order = await repository.createWorkOrder({
      source: { type: 'manual', id: null },
      target: {
        type: 'facility',
        id: 'fac-1',
        facilityId: 'fac-1',
        displayName: 'Коллектор № 1',
        hierarchyPath: [],
        locationSnapshot: { text: null, geo: null, planPosition: null },
      },
      categoryCode,
      symptoms: [],
      description: 'Проверка преобразования типа работ',
      preliminaryPriority: 'P3',
    }, {
      idempotencyKey: `create-${categoryCode}`,
      clientOccurredAt: '2026-09-27T20:00:00Z',
    })

    expect(submittedWorkType).toBe(expectedWorkType)
    expect(order.categoryCode).toBe(expectedWorkType)
  })

  it.each(['facility', 'building', 'collector', 'section', 'equipment', 'sensor'] as const)(
    'round-trips the %s work-order target type without collapsing it to hierarchy_node',
    async (targetType) => {
      let submittedTargetType: unknown
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
        if (url === '/api/v1/me') return json(mePayload)
        if (url === '/api/v1/work-orders') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          submittedTargetType = body.target_entity_type
          return json({
            id: `wo-${targetType}`,
            display_number: 'WO-2026-0099',
            source_risk_id: null,
            facility_id: 'fac-1',
            target_entity_type: body.target_entity_type,
            target_entity_id: body.target_entity_id,
            work_type: body.work_type,
            priority: body.priority,
            due_at: body.due_at,
            description: body.description,
            symptoms: body.symptoms,
            comment: body.comment,
            status: 'draft',
            created_by: 'usr-manager',
            created_at: '2026-09-27T20:00:00Z',
            updated_at: '2026-09-27T20:00:00Z',
            version: 1,
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })
      const repository = createApiContourRepository({
        baseUrl: '/api/v1',
        fetcher: fetcher as typeof fetch,
        storage: createMemoryStorage(),
      })
      await repository.login!({ username: 'manager', password: 'secret' })

      const order = await repository.createWorkOrder({
        source: { type: 'manual', id: null },
        target: {
          type: targetType,
          id: `${targetType}-1`,
          facilityId: 'fac-1',
          displayName: `${targetType} 1`,
          hierarchyPath: [],
          locationSnapshot: { text: null, geo: null, planPosition: null },
        },
        categoryCode: 'inspection',
        symptoms: ['Проверка типа цели'],
        description: 'Проверить сохранение конкретного типа цели заявки',
        preliminaryPriority: 'P3',
      }, {
        idempotencyKey: `create-${targetType}`,
        clientOccurredAt: '2026-09-27T20:00:00Z',
      })

      expect(submittedTargetType).toBe(targetType)
      expect(order.target.type).toBe(targetType)
      expect(order.symptoms).toEqual(['Проверка типа цели'])
    },
  )

  it.each([
    ['manager', 'manager'],
    ['senior_dispatcher', 'senior_dispatcher'],
    ['facility_dispatcher', 'facility_dispatcher'],
    ['maintenance_coordinator', 'maintenance_coordinator'],
    ['engineer', 'engineer'],
    ['Руководитель', 'manager'],
    ['Диспетчер района', 'senior_dispatcher'],
    ['Диспетчер объекта', 'facility_dispatcher'],
    ['Координатор ремонтных работ', 'maintenance_coordinator'],
    ['Инженер', 'engineer'],
  ])('maps backend role %s to %s without inferring it from scope size', async (backendRole, expectedRole) => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createLifecycleFetch(backendRole) as typeof fetch,
      storage: createMemoryStorage(),
    })

    const user = await repository.login!({ username: 'role-user', password: 'secret' })

    expect(user.role).toBe(expectedRole)
  })

  it('maps server-authoritative work-order lifecycle state and performs a real action', async () => {
    const fetcher = createLifecycleFetch()
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'engineer', password: 'secret' })

    const assigned = await repository.getWorkOrder('wo-1')
    expect(assigned).toMatchObject({
      status: 'assigned',
      allowedActions: ['accept', 'decline'],
      currentAssignment: {
        engineerId: 'usr-engineer',
        assignedBy: { id: 'usr-coordinator', displayName: 'Координатор' },
      },
      accessGrant: {
        id: 'grant-1',
        status: 'active',
      },
      sla: {
        policyId: 'sla-P2',
        currentStage: 'acceptance',
        remainingSeconds: 1200,
      },
    })

    const result = await repository.performWorkOrderAction('wo-1', {
      action: 'accept',
      expectedVersion: 4,
      idempotencyKey: 'accept-command-1',
      clientOccurredAt: '2026-09-27T20:16:00Z',
      payload: { comment: 'Принято' },
    })

    expect(result).toMatchObject({
      appliedAction: 'accept',
      auditEventId: 'audit-accept-1',
      workOrder: {
        status: 'accepted',
        version: 5,
        allowedActions: ['mark_en_route'],
        currentAssignment: { status: 'accepted' },
        sla: { currentStage: 'arrival' },
      },
    })
  })

  it('loads only the current engineer assignments and maps candidate workload', async () => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createLifecycleFetch() as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'engineer', password: 'secret' })

    const [order] = await repository.listWorkOrders({ assignedToCurrentUser: true })
    const [candidate] = await repository.listEngineerCandidates('wo-1')
    const [engineer] = await repository.listMaintenanceEngineers()

    expect(order?.currentAssignment?.engineerId).toBe('usr-engineer')
    expect(candidate).toEqual(engineer)
    expect(candidate).toMatchObject({
      user: {
        id: 'usr-engineer',
        displayName: 'Иван Инженеров',
        availability: 'busy',
        specializationCodes: ['repair'],
      },
      activeWorkOrderCount: 1,
      eligible: true,
    })
  })

  it('uses backend notifications, maps engineer links, and marks them read without local simulation', async () => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createLifecycleFetch() as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'engineer', password: 'secret' })

    const [notification] = await repository.listNotifications()
    expect(notification).toMatchObject({
      id: 'notification-1',
      priority: 'warning',
      deepLink: '/my-work/wo-1',
      readAt: null,
    })

    const updated = await repository.markNotificationRead('notification-1')
    expect(updated.readAt).toBe('2026-09-27T20:17:00Z')
  })

  it('uses backend dispatcher candidates and assignment endpoint', async () => {
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: createLifecycleFetch('manager') as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const dispatchers = await repository.listFacilityDispatchers()
    const response = await repository.assignFacilityDispatcher({
      facilityId: 'fac-1',
      dispatcherId: dispatchers[0]!.id,
      startsAt: '2026-09-28T08:00:00Z',
      endsAt: '2026-09-28T20:00:00Z',
      expectedVersion: 1,
      idempotencyKey: 'dispatcher-command-1',
      clientOccurredAt: '2026-09-28T07:59:00Z',
    })

    expect(response).toMatchObject({
      assignment: {
        facilityId: 'fac-1',
        dispatcherId: 'usr-dispatcher',
        status: 'active',
      },
      facility: { id: 'fac-1' },
      auditEventId: 'audit-dispatcher-1',
    })
  })

  it('maps a backend engineer repair report without inventing fields', async () => {
    const baseFetch = createLifecycleFetch()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/work-orders/wo-repair') {
        return json({
          ...fullWorkOrderPayload,
          id: 'wo-repair',
          status: 'completed_by_engineer',
          active_assignment: null,
          allowed_actions: ['start_verification'],
          repair_result: {
            failure_confirmed: true,
            root_cause_code: 'bearing_wear',
            diagnosis: 'Износ подшипника',
            actions: ['Заменён подшипник', 'Выполнен пробный запуск'],
            parts: [{ part_code: 'BRG-42', name: 'Подшипник', quantity: 1, unit: 'шт.' }],
            labor_minutes: 95,
            equipment_restored: true,
            control_check_result: 'Вибрация в пределах нормы',
            residual_risk: 'low',
            recommendations: 'Повторный осмотр через 30 дней',
            requires_follow_up: true,
            completed_at: '2026-09-27T22:00:00Z',
            author: { id: 'usr-engineer', display_name: 'Иван Инженеров' },
          },
        })
      }
      return baseFetch(input, init)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'engineer', password: 'secret' })

    const order = await repository.getWorkOrder('wo-repair')

    expect(order.repairResult).toMatchObject({
      failureConfirmed: true,
      rootCauseCode: 'bearing_wear',
      parts: [{ partCode: 'BRG-42', quantity: 1 }],
      laborMinutes: 95,
      equipmentRestored: true,
      author: { id: 'usr-engineer', displayName: 'Иван Инженеров' },
    })
  })

  it('preserves backend transition and optimistic-lock errors', async () => {
    const baseFetch = createLifecycleFetch()
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/work-orders/wo-1/actions') {
        return json({
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Заявка уже изменена другим пользователем',
            trace_id: 'trace-conflict',
            details: { current_version: 8 },
            retryable: false,
          },
        }, 409)
      }
      return baseFetch(input, init)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'engineer', password: 'secret' })

    await expect(repository.performWorkOrderAction('wo-1', {
      action: 'accept',
      expectedVersion: 4,
      idempotencyKey: 'accept-command-conflict',
      clientOccurredAt: '2026-09-27T20:16:00Z',
      payload: {},
    })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      correlationId: 'trace-conflict',
      currentVersion: 8,
    } satisfies Partial<RepositoryError>)
  })

  it('fails closed when the backend response violates the contract', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (String(input) === '/api/v1/me') return json({ role: 'manager' })
      throw new Error('Unexpected request')
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })

    await expect(repository.login!({ username: 'manager', password: 'secret' })).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    } satisfies Partial<RepositoryError>)
  })

  it('broadcasts session expiry after any authenticated request receives 401', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url.startsWith('/api/v1/facilities?')) {
        return json({
          error: {
            code: 'AUTH_REQUIRED',
            message: 'Сессия истекла',
            details: {},
            trace_id: 'trace-expired',
          },
        }, 401)
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    let authRequiredEvents = 0
    const listener = () => { authRequiredEvents += 1 }
    window.addEventListener(CONTOUR_AUTH_REQUIRED_EVENT, listener)
    try {
      await repository.login!({ username: 'manager', password: 'secret' })
      await expect(repository.listFacilities()).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      })
      expect(authRequiredEvents).toBe(1)
      await expect(repository.getCurrentUser()).rejects.toMatchObject({
        code: 'AUTH_REQUIRED',
      })
    } finally {
      window.removeEventListener(CONTOUR_AUTH_REQUIRED_EVENT, listener)
    }
  })

  it('retries creation with a byte-for-byte stable idempotent request body', async () => {
    const submittedBodies: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url === '/api/v1/facilities/fac-1') return json(facilityPayload)
      if (url === '/api/v1/work-orders') {
        const rawBody = String(init?.body)
        submittedBodies.push(rawBody)
        const body = JSON.parse(rawBody) as Record<string, unknown>
        return json({
          id: 'wo-idempotent',
          display_number: 'WO-2026-0100',
          source_risk_id: null,
          facility_id: 'fac-1',
          target_entity_type: body.target_entity_type,
          target_entity_id: body.target_entity_id,
          work_type: body.work_type,
          priority: body.priority,
          due_at: body.due_at,
          description: body.description,
          symptoms: body.symptoms,
          comment: null,
          status: 'draft',
          created_by: 'usr-manager',
          created_at: '2026-09-27T20:00:00Z',
          updated_at: '2026-09-27T20:00:00Z',
          version: 1,
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })
    const input = {
      source: { type: 'manual' as const, id: null },
      target: {
        type: 'facility' as const,
        id: 'fac-1',
        facilityId: 'fac-1',
        displayName: 'Коллектор № 1',
        hierarchyPath: [],
        locationSnapshot: { text: null, geo: null, planPosition: null },
      },
      categoryCode: 'inspection',
      symptoms: ['Контрольный осмотр'],
      description: 'Проверить объект после тревоги и зафиксировать результат',
      preliminaryPriority: 'P2' as const,
    }
    const meta = {
      idempotencyKey: 'stable-create-command',
      clientOccurredAt: '2026-09-27T20:00:00Z',
    }

    await repository.createWorkOrder(input, meta)
    await repository.createWorkOrder(input, meta)

    expect(submittedBodies).toHaveLength(2)
    expect(submittedBodies[1]).toBe(submittedBodies[0])
    expect(JSON.parse(submittedBodies[0]!)).toMatchObject({
      idempotency_key: 'stable-create-command',
      client_occurred_at: '2026-09-27T20:00:00Z',
      due_at: '2026-09-27T21:00:00.000Z',
    })
  })

  it('preserves a facility hierarchy root as a facility node', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url === '/api/v1/facilities/fac-1/hierarchy') {
        return json([{
          id: 'node-root',
          parent_id: null,
          entity_type: 'facility',
          entity_id: 'fac-1',
          display_name: 'Коллектор № 1',
          path: ['Коллектор № 1'],
          children_count: 1,
          sensor_count: 14,
          attention_count: 0,
          current_state: 'normal',
          risk_level: 'low',
          has_children: true,
        }])
      }
      if (url === '/api/v1/facilities/fac-1/layout') {
        return json({ type: 'FeatureCollection', features: [] })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const [root] = await repository.getFacilityHierarchy('fac-1')

    expect(root).toMatchObject({
      id: 'node-root',
      entityId: 'fac-1',
      entityType: 'facility',
      parentId: null,
    })
  })

  it('uses list snapshots without a sensor-detail request fan-out', async () => {
    const sensorItem = (id: string) => ({
      id,
      channel_id: `channel-${id}`,
      tag: id,
      sensor_type: 'temperature',
      system_type: 'monitoring',
      value_type: 'categorical',
      display_name: `Датчик ${id}`,
      facility_id: 'fac-1',
      hierarchy_node_id: 'node-1',
      has_geolocation: false,
      position: null,
    })
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url === '/api/v1/facilities/fac-1/hierarchy') {
        return json([
          {
            id: 'node-equipment-1', parent_id: null, entity_type: 'equipment', entity_id: 'equipment-1',
            display_name: 'Контроль объекта', path: ['Контроль объекта'], children_count: 1,
            sensor_count: 3, attention_count: 0, current_state: 'unknown', risk_level: 'unknown', has_children: true,
          },
          {
            id: 'node-1', parent_id: 'node-equipment-1', entity_type: 'sensor', entity_id: 'sensor-1',
            display_name: 'Датчики', path: ['Контроль объекта', 'Датчики'], children_count: 0,
            sensor_count: 0, attention_count: 0, current_state: 'unknown', risk_level: 'unknown', has_children: false,
          },
        ])
      }
      if (url === '/api/v1/facilities/fac-1/layout') {
        return json({ type: 'FeatureCollection', features: [] })
      }
      if (url === '/api/v1/sensors?facility_id=fac-1&limit=200') {
        return json({
          data: [
            sensorItem('sensor-1'),
            {
              ...sensorItem('sensor-2'),
              current_reading: {
                value: '24',
                numeric_value: 24,
                unit: '°C',
                measured_at: '2026-09-27T20:00:00Z',
              },
              current_state: 'normal',
              data_health: 'fresh',
            },
            {
              ...sensorItem('sensor-3'),
              current_reading: {
                value: 'На охране',
                numeric_value: null,
                unit: null,
                measured_at: '2026-09-27T20:05:00Z',
              },
              current_state: 'unknown',
              data_health: 'fresh',
            },
          ],
          meta: { next_cursor: null, total: 3, generated_at: '2026-09-27T20:00:00Z' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const sensors = await repository.listSensors('fac-1')

    expect(sensors.map((sensor) => sensor.id)).toEqual(['sensor-1', 'sensor-2', 'sensor-3'])
    expect(sensors[0]).toMatchObject({
      status: 'unknown',
      equipmentId: 'equipment-1',
      lastReading: null,
      lastValueText: null,
      updatedAt: null,
    })
    expect(sensors[1]?.status).toBe('normal')
    expect(sensors[1]?.lastReading?.value).toBe(24)
    expect(sensors[2]).toMatchObject({
      status: 'unknown',
      equipmentId: 'equipment-1',
      lastReading: null,
      lastValueText: 'На охране',
      updatedAt: '2026-09-27T20:05:00Z',
    })
    expect(fetcher.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/sensors'))).toEqual([
      '/api/v1/sensors?facility_id=fac-1&limit=200',
    ])
  })

  it('caps sensor-series hydration at twelve requests', async () => {
    const sensorItem = (index: number) => ({
      id: `sensor-${index}`,
      channel_id: `channel-${index}`,
      tag: `T-${index}`,
      sensor_type: 'temperature_sensor',
      system_type: 'temperature',
      value_type: 'numeric',
      display_name: `Датчик ${index}`,
      facility_id: 'fac-1',
      hierarchy_node_id: 'node-1',
      has_geolocation: false,
      position: null,
      current_reading: {
        value: String(20 + index),
        numeric_value: 20 + index,
        unit: '°C',
        measured_at: '2026-09-27T20:00:00Z',
      },
      current_state: 'normal',
      data_health: 'fresh',
    })
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url === '/api/v1/facilities/fac-1/hierarchy') {
        return json([
          {
            id: 'node-equipment-1', parent_id: null, entity_type: 'equipment', entity_id: 'equipment-1',
            display_name: 'Температурный контроль', path: ['Температурный контроль'], children_count: 1,
            sensor_count: 14, attention_count: 0, current_state: 'normal', risk_level: 'low', has_children: true,
          },
          {
            id: 'node-1', parent_id: 'node-equipment-1', entity_type: 'sensor', entity_id: 'sensor-1',
            display_name: 'Датчики', path: ['Температурный контроль', 'Датчики'], children_count: 0,
            sensor_count: 0, attention_count: 0, current_state: 'normal', risk_level: 'low', has_children: false,
          },
        ])
      }
      if (url === '/api/v1/facilities/fac-1/layout') {
        return json({ type: 'FeatureCollection', features: [] })
      }
      if (url === '/api/v1/sensors?facility_id=fac-1&limit=200') {
        return json({
          data: Array.from({ length: 14 }, (_, index) => sensorItem(index + 1)),
          meta: { next_cursor: null, total: 14, generated_at: '2026-09-27T20:00:00Z' },
        })
      }
      if (/\/api\/v1\/sensors\/sensor-\d+\/series\?/.test(url)) {
        return json({
          value_type: 'numeric',
          points: [],
          thresholds: [],
          missing_intervals: [],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const sensors = await repository.listSensors('fac-1')
    const sensorRequests = fetcher.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('/sensors'))

    expect(sensors).toHaveLength(14)
    expect(sensorRequests).toHaveLength(13)
    expect(sensorRequests.filter((url) => url.includes('/series?'))).toHaveLength(12)
    expect(sensorRequests.filter((url) => /\/sensors\/sensor-\d+$/.test(url))).toHaveLength(0)
  })

  it('maps audit version boundaries from backend details', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url === '/api/v1/audit?target_type=work_order&target_id=wo-1&limit=200') {
        return json({
          data: [{
            id: 17,
            occurred_at: '2026-09-27T20:16:00Z',
            user_id: 'usr-engineer',
            username: 'engineer',
            action: 'work_order.accept',
            target_type: 'work_order',
            target_id: 'wo-1',
            result: 'success',
            status_code: 200,
            ip: null,
            trace_id: 'trace-audit',
            details: { before_version: 4, after_version: 5 },
          }],
          meta: { next_cursor: null, total: 1, generated_at: '2026-09-27T20:16:00Z' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    const [event] = await repository.getAuditTimeline('work_order', 'wo-1')

    expect(event).toMatchObject({ beforeVersion: 4, afterVersion: 5 })
  })

  it('clears the local API session even when remote logout is unavailable', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
      if (url === '/api/v1/me') return json(mePayload)
      if (url === '/api/v1/auth/logout') throw new TypeError('network unavailable')
      throw new Error(`Unexpected request: ${url}`)
    })
    const repository = createApiContourRepository({
      baseUrl: '/api/v1',
      fetcher: fetcher as typeof fetch,
      storage: createMemoryStorage(),
    })
    await repository.login!({ username: 'manager', password: 'secret' })

    await expect(repository.logout!()).resolves.toBeUndefined()
    await expect(repository.getCurrentUser()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    })
  })
})
