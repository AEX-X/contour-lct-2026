import type { RepositoryMode } from '../repositories'

export interface RuntimeConfig {
  dataMode: RepositoryMode
  apiBaseUrl: string
}

function normalizeBaseUrl(value: string | undefined) {
  const fallback = '/api/v1'
  const normalized = (value?.trim() || fallback).replace(/\/+$/, '')
  if (!normalized.startsWith('/') && !/^https?:\/\//i.test(normalized)) {
    throw new Error('VITE_CONTOUR_API_BASE_URL must be an absolute URL or an absolute path')
  }
  return normalized
}

export function readRuntimeConfig(
  env: Record<string, string | boolean | undefined> = import.meta.env,
): RuntimeConfig {
  const requestedMode = String(env.VITE_CONTOUR_DATA_MODE ?? 'mock').trim().toLowerCase()
  if (requestedMode !== 'mock' && requestedMode !== 'api') {
    throw new Error('VITE_CONTOUR_DATA_MODE must be either mock or api')
  }

  return {
    dataMode: requestedMode,
    apiBaseUrl: normalizeBaseUrl(String(env.VITE_CONTOUR_API_BASE_URL ?? '')),
  }
}
