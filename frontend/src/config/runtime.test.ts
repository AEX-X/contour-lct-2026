import { describe, expect, it } from 'vitest'
import { readRuntimeConfig } from './runtime'

describe('readRuntimeConfig', () => {
  it('keeps the autonomous demo as the safe default', () => {
    expect(readRuntimeConfig({})).toEqual({
      dataMode: 'mock',
      apiBaseUrl: '/api/v1',
    })
  })

  it('accepts an explicit API mode and normalizes the trailing slash', () => {
    expect(readRuntimeConfig({
      VITE_CONTOUR_DATA_MODE: 'api',
      VITE_CONTOUR_API_BASE_URL: 'https://example.test/api/v1/',
    })).toEqual({
      dataMode: 'api',
      apiBaseUrl: 'https://example.test/api/v1',
    })
  })

  it('rejects ambiguous modes instead of silently falling back', () => {
    expect(() => readRuntimeConfig({ VITE_CONTOUR_DATA_MODE: 'hybrid' })).toThrow(
      'VITE_CONTOUR_DATA_MODE must be either mock or api',
    )
  })
})
