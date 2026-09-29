import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage } from './memoryStorage'
import { createApiContourRepository } from './ApiContourRepository'
// Captured from the backend: POST /risks/{id}/confirm, then GET /events?is_confirmed_incident=true
import backend from './fixtures/backend-confirmed-incident.json'

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Trace-Id': 'trace-test' },
  })
}

const mePayload = {
  user_id: 'usr_dispatcher',
  display_name: 'Диспетчер объекта (демо)',
  organization_id: 'org_moscollector',
  specialization_codes: [],
  availability: 'available',
  role: 'facility_dispatcher',
  permissions: ['facility.read.assigned', 'risk.read', 'risk.confirm'],
  scope: { type: 'assigned_facilities', facility_ids: [backend.risk.target.facility_id] },
  timezone: 'Europe/Moscow',
  locale: 'ru-RU',
}

function backendFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/v1/auth/login') return json({ token: 'session-token' })
    if (url === '/api/v1/me') return json(mePayload)
    if (url.startsWith('/api/v1/events?')) return json(backend.events)
    if (url.startsWith('/api/v1/risks?')) {
      return json({
        data: [backend.risk],
        meta: { next_cursor: null, total: 1, generated_at: backend.events.meta.generated_at },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
}

async function repository() {
  const repo = createApiContourRepository({
    baseUrl: '/api/v1',
    fetcher: backendFetch() as typeof fetch,
    storage: createMemoryStorage(),
  })
  await repo.login!({ username: 'dispatcher', password: 'secret' })
  return repo
}

describe('backend confirmed incident payloads', () => {
  it('maps a confirmed incident from the event journal with the existing mapping', async () => {
    const incidents = await (await repository()).listIncidents()

    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      id: backend.incident.id,
      facilityId: backend.incident.facility_id,
      sourceRiskId: backend.incident.source_risk_id,
      status: 'open',
      severity: backend.incident.severity,
    })
    expect(incidents[0]?.description).toContain(backend.incident.description)
  })

  it('maps a confirmed risk to the confirmed status the mock repository uses', async () => {
    const risks = await (await repository()).listRisks()

    expect(risks).toHaveLength(1)
    expect(risks[0]).toMatchObject({ id: backend.risk.id, status: 'confirmed', version: 2 })
  })
})
