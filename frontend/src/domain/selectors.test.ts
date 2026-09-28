import { describe, expect, it } from 'vitest'

import type { RiskForecast } from './types'
import { isRiskActiveAt } from './selectors'

function risk(overrides: Partial<RiskForecast> = {}): RiskForecast {
  return {
    id: 'risk-1',
    version: 1,
    facilityId: 'fac-1',
    target: {
      type: 'facility',
      id: 'fac-1',
      facilityId: 'fac-1',
      displayName: 'Объект 1',
      hierarchyPath: [],
      locationSnapshot: { text: null, geo: null, planPosition: null },
    },
    predictedEvent: 'Риск отказа',
    probability: 0.8,
    severity: 'high',
    horizonHours: 72,
    status: 'new',
    topFactors: [],
    recommendation: 'Проверить оборудование',
    createdAt: '2026-09-28T12:00:00Z',
    expiresAt: '2026-06-23T00:00:00Z',
    decidedAt: null,
    decidedBy: null,
    provenance: {
      origin: 'model_output',
      environment: 'real',
      sourceLabel: 'ML',
      asOf: '2026-06-20T00:00:00Z',
    },
    ...overrides,
  }
}

describe('isRiskActiveAt', () => {
  it('evaluates an API historical prediction inside its model timeline', () => {
    expect(isRiskActiveAt(risk({ modelAsOf: '2026-06-20T00:00:00Z' }), '2026-09-28T12:00:00Z')).toBe(true)
  })

  it('continues to evaluate ordinary and mock predictions against the scenario clock', () => {
    expect(isRiskActiveAt(risk(), '2026-09-28T12:00:00Z')).toBe(false)
  })
})
