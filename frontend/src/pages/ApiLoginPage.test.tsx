import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RepositoryError } from '../domain'
import type { RepositoryRuntimeInfo } from '../repositories'
import { ApiLoginPage } from './ApiLoginPage'

const runtime: RepositoryRuntimeInfo = {
  mode: 'api',
  label: 'Интеграционный контур',
  description: 'Backend API',
  apiBaseUrl: '/api/v1',
  supportsDemoRoleSwitch: false,
  supportsDemoReset: false,
  supportsOfflineSimulation: true,
}

describe('ApiLoginPage', () => {
  it('shows a dedicated lockout message and disables another attempt', async () => {
    const user = userEvent.setup()
    const onLogin = vi.fn().mockRejectedValue(new RepositoryError(
      'TOO_MANY_REQUESTS',
      'Слишком много попыток входа',
      { retryAfterSeconds: 119 },
    ))
    render(<ApiLoginPage runtime={runtime} onLogin={onLogin} />)

    await user.type(screen.getByLabelText('Логин'), 'manager')
    await user.type(screen.getByLabelText('Пароль'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByText('Вход временно заблокирован')).toBeInTheDocument()
    expect(screen.getByText('Слишком много попыток входа. Повторите через 2 мин')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Войти' })).toBeDisabled()
  })
})
