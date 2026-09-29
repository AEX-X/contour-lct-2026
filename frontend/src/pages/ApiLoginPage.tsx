import { ArrowRight, Database, LockKey } from '@phosphor-icons/react'
import { useEffect, useState, type FormEvent } from 'react'
import { RepositoryError } from '../domain'
import type { RepositoryAuthCredentials, RepositoryRuntimeInfo } from '../repositories'
import { Button, InlineAlert, StatusBadge } from '../shared/ui'

const demoAccounts = [
  { label: 'Руководитель', username: 'manager', password: 'manager123' },
  { label: 'Старший диспетчер', username: 'senior_dispatcher', password: 'senior123' },
  { label: 'Диспетчер объекта', username: 'dispatcher', password: 'dispatcher123' },
  { label: 'Координатор', username: 'coordinator', password: 'coordinator123' },
  { label: 'Инженер', username: 'engineer', password: 'engineer123' },
] as const

const showDemoAccounts = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_CREDENTIALS === 'true'

export function ApiLoginPage({
  runtime,
  onLogin,
}: {
  runtime: RepositoryRuntimeInfo
  onLogin: (credentials: RepositoryAuthCredentials) => Promise<void>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{ title: string; message: string } | null>(null)
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0)

  useEffect(() => {
    if (retryAfterSeconds <= 0) return
    const timer = globalThis.setTimeout(() => {
      setRetryAfterSeconds((value) => Math.max(0, value - 1))
    }, 1_000)
    return () => globalThis.clearTimeout(timer)
  }, [retryAfterSeconds])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username.trim() || !password) {
      setError({ title: 'Проверь данные', message: 'Укажи логин и пароль backend' })
      return
    }
    setPending(true)
    setError(null)
    try {
      await onLogin({ username: username.trim(), password })
    } catch (nextError) {
      if (nextError instanceof RepositoryError && nextError.code === 'TOO_MANY_REQUESTS') {
        const seconds = Math.max(1, Math.ceil(nextError.retryAfterSeconds ?? 60))
        setRetryAfterSeconds(seconds)
        setError({
          title: 'Вход временно заблокирован',
          message: `Слишком много попыток входа. Повторите через ${Math.max(1, Math.ceil(seconds / 60))} мин`,
        })
      } else {
        setError({
          title: 'Вход не выполнен',
          message: nextError instanceof Error ? nextError.message : 'Не удалось войти в backend',
        })
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="api-login-shell">
      <section className="api-login-card" aria-labelledby="api-login-title">
        <div className="api-login-brand" aria-hidden="true">C</div>
        <StatusBadge tone="info" icon={Database}>Интеграционный режим</StatusBadge>
        <div>
          <h1 id="api-login-title">Вход в Contour</h1>
          <p>Авторизация выполняется через текущий FastAPI backend. Пароль не сохраняется в браузере</p>
        </div>
        <dl className="api-login-meta">
          <div>
            <dt>Источник</dt>
            <dd>{runtime.label}</dd>
          </div>
          <div>
            <dt>API</dt>
            <dd><code>{runtime.apiBaseUrl}</code></dd>
          </div>
        </dl>
        {error ? (
          <InlineAlert tone="critical" title={error.title}>
            {retryAfterSeconds > 0
              ? `Слишком много попыток входа. Повторите через ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} мин`
              : error.message}
          </InlineAlert>
        ) : null}
        <form className="api-login-form" onSubmit={handleSubmit}>
          {showDemoAccounts ? (
            <fieldset className="api-login-profiles">
              <legend>Демонстрационные роли</legend>
              <div>
                {demoAccounts.map((account) => (
                  <button
                    key={account.username}
                    type="button"
                    disabled={pending || retryAfterSeconds > 0}
                    onClick={() => {
                      setUsername(account.username)
                      setPassword(account.password)
                      setError(null)
                    }}
                  >
                    {account.label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="field">
            <label htmlFor="api-username">Логин</label>
            <input
              id="api-username"
              name="username"
              autoComplete="username"
              value={username}
              disabled={pending || retryAfterSeconds > 0}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="api-password">Пароль</label>
            <div className="api-password-field">
              <LockKey size={18} aria-hidden="true" />
              <input
                id="api-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={pending || retryAfterSeconds > 0}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <Button
            type="submit"
            fullWidth
            loading={pending}
            disabled={retryAfterSeconds > 0}
            endIcon={<ArrowRight size={18} />}
          >
            Войти
          </Button>
        </form>
        <p className="api-login-hint">
          Учётные данные предоставляет backend-команда. При локальном запуске HTTPS-сертификат backend должен быть доверен браузером
        </p>
      </section>
    </main>
  )
}
