import { z } from 'zod'
import { RepositoryError } from '../domain'
import type { RepositoryAuthCredentials, StorageLike } from '../repositories'
import { apiErrorEnvelopeSchema, loginResponseSchema } from './schemas'

const TOKEN_STORAGE_KEY = 'contour.api.session-token.v1'
const REQUEST_TIMEOUT_MS = 15_000

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

function mapStatusCode(status: number) {
  if (status === 401) return 'AUTH_REQUIRED' as const
  if (status === 403) return 'FORBIDDEN' as const
  if (status === 404) return 'NOT_FOUND' as const
  if (status === 409) return 'VERSION_CONFLICT' as const
  if (status === 400 || status === 422) return 'VALIDATION_ERROR' as const
  return 'SOURCE_UNAVAILABLE' as const
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
    if (this.token) {
      try {
        await this.request('/auth/logout', z.void(), { method: 'POST' })
      } finally {
        this.clearSession()
      }
      return
    }
    this.clearSession()
  }

  clearSession() {
    this.token = null
    this.storage.removeItem(TOKEN_STORAGE_KEY)
  }

  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string | number | undefined>,
  ) {
    return this.request(makeUrl('', path, query), schema)
  }

  async post<T>(path: string, schema: z.ZodType<T>, body: unknown) {
    return this.request(path, schema, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    requiresAuth = true,
  ): Promise<T> {
    if (requiresAuth && !this.token) {
      throw new RepositoryError('AUTH_REQUIRED', 'Войди в backend, чтобы продолжить')
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetcher(makeUrl(this.baseUrl, path), {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new RepositoryError('SOURCE_UNAVAILABLE', 'Backend не ответил за 15 секунд')
      }
      throw new RepositoryError('SOURCE_UNAVAILABLE', 'Не удалось подключиться к backend. Проверь адрес API, HTTPS и CORS')
    } finally {
      window.clearTimeout(timeout)
    }

    if (!response.ok) {
      if (response.status === 401) this.clearSession()
      const rawError = await response.json().catch(() => null)
      const parsedError = apiErrorEnvelopeSchema.safeParse(rawError)
      const message = parsedError.success
        ? parsedError.data.error.message
        : `Backend вернул ошибку ${response.status}`
      throw new RepositoryError(mapStatusCode(response.status), message, {
        correlationId: parsedError.success
          ? parsedError.data.error.trace_id
          : response.headers.get('x-trace-id') ?? undefined,
      })
    }

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
