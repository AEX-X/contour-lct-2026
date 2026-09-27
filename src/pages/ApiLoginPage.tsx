import { ArrowRight, Database, LockKey } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import type { RepositoryAuthCredentials, RepositoryRuntimeInfo } from '../repositories'
import { Button, InlineAlert, StatusBadge } from '../shared/ui'

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
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username.trim() || !password) {
      setError('Укажи логин и пароль backend')
      return
    }
    setPending(true)
    setError(null)
    try {
      await onLogin({ username: username.trim(), password })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Не удалось войти в backend')
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
          <InlineAlert tone="critical" title="Вход не выполнен">
            {error}
          </InlineAlert>
        ) : null}
        <form className="api-login-form" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="api-username">Логин</label>
            <input
              id="api-username"
              name="username"
              autoComplete="username"
              value={username}
              disabled={pending}
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
                disabled={pending}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <Button
            type="submit"
            fullWidth
            loading={pending}
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
