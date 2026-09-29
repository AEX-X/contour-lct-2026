import { z } from 'zod'
import { RepositoryError } from '../domain'
import type { RepositoryAuthCredentials, StorageLike } from '../repositories'
import { apiErrorEnvelopeSchema, loginResponseSchema } from './schemas'

const TOKEN_STORAGE_KEY = 'contour.api.session-token.v1'
const REQUEST_TIMEOUT_MS = 15_000
export const CONTOUR_AUTH_REQUIRED_EVENT = 'contour:auth-required'

export type FetchLike = typeof fetch

function browserSessionStorage(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    const probe = '__contour_api_storage_probe__'
    window.sessionStorage.setItem(probe, probe)
    window.sessionStorage.removeItem(probe)
    return window.sessionStorage
  } catch {
    return null
  }
}

function makeUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const params = new URLSearchParams()
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value))
  })
  const suffix = params.size ? `?${params.toString()}` : ''
  return `${baseUrl}${normalizedPath}${suffix}`
}

function mapStatusCode(status: number, backendCode?: string) {
  const knownCodes = {
    VERSION_CONFLICT: 'VERSION_CONFLICT',
    CONFLICT: 'VERSION_CONFLICT',
    INVALID_TRANSITION: 'INVALID_TRANSITION',
    ASSIGNMENT_CHANGED: 'ASSIGNMENT_CHANGED',
    ACCESS_EXPIRED: 'ACCESS_EXPIRED',
    NO_SUITABLE_ENGINEER: 'NO_SUITABLE_ENGINEER',
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    DOMAIN_VALIDATION_ERROR: 'VALIDATION_ERROR',
    IDEMPOTENCY_KEY_REUSED: 'VALIDATION_ERROR',
    PERMISSION_DENIED: 'FORBIDDEN',
    FACILITY_ACCESS_DENIED: 'FORBIDDEN',
    TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  } as const
  if (backendCode && backendCode in knownCodes) {
    return knownCodes[backendCode as keyof typeof knownCodes]
  }
  if (status === 401) return 'AUTH_REQUIRED' as const
  if (status === 403) return 'FORBIDDEN' as const
  if (status === 404) return 'NOT_FOUND' as const
  if (status === 409) return 'VERSION_CONFLICT' as const
  if (status === 429) return 'TOO_MANY_REQUESTS' as const
  if (status === 400 || status === 422) return 'VALIDATION_ERROR' as const
  return 'SOURCE_UNAVAILABLE' as const
}

function filenameFromContentDisposition(value: string | null) {
  if (!value) return null
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(value)?.[1]
  let candidate = plain
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded)
    } catch {
      candidate = encoded
    }
  }
  return candidate?.replace(/[\\/]/g, '_').trim() || null
}

function mapFieldErrors(details: Record<string, unknown> | undefined) {
  const raw = Array.isArray(details?.errors)
    ? details.errors
    : Array.isArray(details?.field_errors)
      ? details.field_errors
      : []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const rawPath = item.loc ?? item.field
    const field = Array.isArray(rawPath)
      ? rawPath.map(String).filter((part) => part !== 'body').join('.')
      : typeof rawPath === 'string'
        ? rawPath
        : 'request'
    const message = typeof item.msg === 'string'
      ? item.msg
      : typeof item.message === 'string'
        ? item.message
        : 'Некорректное значение'
    const code = typeof item.type === 'string'
      ? item.type
      : typeof item.code === 'string'
        ? item.code
        : 'validation_error'
    return [{ field, code, message }]
  })
}

export class ContourApiClient {
  readonly baseUrl: string
  private readonly fetcher: FetchLike
  private readonly storage: StorageLike
  private token: string | null

  constructor(options: {
    baseUrl: string
    fetcher?: FetchLike
    storage?: StorageLike
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetcher = options.fetcher ?? fetch.bind(globalThis)
    this.storage = options.storage ?? browserSessionStorage() ?? {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    this.token = this.storage.getItem(TOKEN_STORAGE_KEY)
  }

  hasSession() {
    return Boolean(this.token)
  }

  async login(credentials: RepositoryAuthCredentials) {
    const result = await this.request(
      '/auth/login',
      loginResponseSchema,
      {
        method: 'POST',
        body: JSON.stringify(credentials),
      },
      false,
    )
    this.token = result.token
    this.storage.setItem(TOKEN_STORAGE_KEY, result.token)
  }

  async logout() {
    try {
      if (this.token) {
        await this.request('/auth/logout', z.void(), { method: 'POST' })
      }
    } catch {
      // Local logout must remain available when the backend is unreachable.
      // The server session is short-lived and can expire independently.
    } finally {
      this.clearSession()
    }
  }

  clearSession() {
    this.token = null
    this.storage.removeItem(TOKEN_STORAGE_KEY)
  }

  private notifyAuthRequired() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(CONTOUR_AUTH_REQUIRED_EVENT))
    }
  }

  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string | number | undefined>,
  ) {
    return this.request(makeUrl('', path, query), schema)
  }

  async getPublic<T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string | number | undefined>,
  ) {
    return this.request(makeUrl('', path, query), schema, {}, false)
  }

  async getWithHeaders<T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string | number | undefined>,
  ) {
    const response = await this.requestResponse(makeUrl('', path, query))
    return {
      data: await this.parseJson(response, schema),
      headers: response.headers,
    }
  }

  async post<T>(path: string, schema: z.ZodType<T>, body: unknown) {
    return this.request(path, schema, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  async download(
    path: string,
    query?: Record<string, string | number | undefined>,
  ) {
    const response = await this.requestResponse(makeUrl('', path, query), {
      headers: {
        Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, text/csv, application/octet-stream',
      },
    })
    return {
      blob: await response.blob(),
      filename: filenameFromContentDisposition(response.headers.get('content-disposition')) ?? 'risks-report',
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    requiresAuth = true,
  ): Promise<T> {
    const response = await this.requestResponse(path, init, requiresAuth)
    return this.parseJson(response, schema)
  }

  private async requestResponse(
    path: string,
    init: RequestInit = {},
    requiresAuth = true,
  ): Promise<Response> {
    if (requiresAuth && !this.token) {
      throw new RepositoryError('AUTH_REQUIRED', 'Войди в backend, чтобы продолжить')
    }

    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetcher(makeUrl(this.baseUrl, path), {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(requiresAuth && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new RepositoryError('SOURCE_UNAVAILABLE', 'Backend не ответил за 15 секунд')
      }
      throw new RepositoryError('SOURCE_UNAVAILABLE', 'Не удалось подключиться к backend. Проверь адрес API, HTTPS и CORS')
    } finally {
      globalThis.clearTimeout(timeout)
    }

    if (!response.ok) {
      if (response.status === 401) {
        this.clearSession()
        this.notifyAuthRequired()
      }
      const rawError = await response.json().catch(() => null)
      const parsedError = apiErrorEnvelopeSchema.safeParse(rawError)
      const message = parsedError.success
        ? parsedError.data.error.message
        : `Backend вернул ошибку ${response.status}`
      const details = parsedError.success ? parsedError.data.error.details : undefined
      const current = details?.current && typeof details.current === 'object'
        ? details.current as Record<string, unknown>
        : undefined
      const currentVersion = typeof details?.current_version === 'number'
        ? details.current_version
        : typeof current?.version === 'number'
          ? current.version
          : undefined
      const retryAfterSeconds = typeof details?.retry_after_seconds === 'number'
        ? Math.max(0, details.retry_after_seconds)
        : undefined
      throw new RepositoryError(
        mapStatusCode(response.status, parsedError.success ? parsedError.data.error.code : undefined),
        message,
        {
        correlationId: parsedError.success
          ? parsedError.data.error.trace_id
          : response.headers.get('x-trace-id') ?? undefined,
          currentVersion,
          retryAfterSeconds,
          details,
          fieldErrors: mapFieldErrors(details),
        },
      )
    }

    return response
  }

  private async parseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    if (response.status === 204) return schema.parse(undefined)
    const payload = await response.json().catch(() => {
      throw new RepositoryError('SOURCE_UNAVAILABLE', 'Backend вернул некорректный JSON')
    })
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new RepositoryError(
        'SOURCE_UNAVAILABLE',
        'Ответ backend не соответствует согласованному контракту',
        {
          fieldErrors: parsed.error.issues.slice(0, 8).map((issue) => ({
            field: issue.path.join('.') || 'response',
            code: issue.code,
            message: issue.message,
          })),
        },
      )
    }
    return parsed.data
  }
}
