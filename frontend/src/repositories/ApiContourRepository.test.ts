import { describe, expect, it, vi } from 'vitest'
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
        facility_id: 'fac-1',
        target_entity_type: 'hierarchy_node',
        target_entity_id: 'equipment-1',
        work_type: 'repair',
        priority: 'high',
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

  it('translates frontend priority and hierarchy targets to the backend contract', async () => {
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
    expect(order.target.type).toBe('section')
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
})
