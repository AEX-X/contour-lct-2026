import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { MemoryOfflineStorage, OfflineEngineerService } from '../../offline'
import {
  createMemoryStorage,
  createMockContourRepository,
  type WorkOrder,
  type WorkOrderActionCommand,
} from '../../repositories'
import { calculateOfflineAccessExpiry, EngineerWorkspace } from './EngineerWorkspace'

const CLIENT_OCCURRED_AT = '2026-09-21T07:00:00.000Z'

function command<T extends WorkOrderActionCommand>(value: T): T {
  return value
}

async function createAssignedScenario() {
  const repository = createMockContourRepository({
    storage: createMemoryStorage(),
  })
  await repository.switchDemoUser('user-dispatcher')
  const risk = await repository.getRisk('risk-main-001')
  const decision = await repository.confirmRisk(risk.id, {
    expectedVersion: risk.version,
    idempotencyKey: 'engineer-test-confirm-risk',
    clientOccurredAt: CLIENT_OCCURRED_AT,
    comment: 'Прогноз подтверждён для инженерного сценария',
  })
  const draft = await repository.createWorkOrder(
    {
      source: { type: 'incident', id: decision.incident.id },
      target: risk.target,
      categoryCode: 'predictive_inspection',
      symptoms: ['Рост температуры', 'Нестабильная работа вентиляции'],
      description: 'Проверить датчик и вентиляционную установку по прогнозу',
      preliminaryPriority: 'P2',
    },
    {
      idempotencyKey: 'engineer-test-create',
      clientOccurredAt: CLIENT_OCCURRED_AT,
    },
  )
  const submitted = await repository.performWorkOrderAction(
    draft.id,
    command({
      action: 'submit',
      expectedVersion: draft.version,
      idempotencyKey: 'engineer-test-submit',
      clientOccurredAt: CLIENT_OCCURRED_AT,
    }),
  )

  await repository.switchDemoUser('user-coordinator')
  const triage = await repository.performWorkOrderAction(
    submitted.workOrder.id,
    command({
      action: 'start_triage',
      expectedVersion: submitted.workOrder.version,
      idempotencyKey: 'engineer-test-triage',
      clientOccurredAt: CLIENT_OCCURRED_AT,
    }),
  )
  const prioritized = await repository.performWorkOrderAction(
    triage.workOrder.id,
    command({
      action: 'finalize_priority',
      payload: { priority: 'P2', slaPolicyId: 'sla-demo-p2' },
      expectedVersion: triage.workOrder.version,
      idempotencyKey: 'engineer-test-priority',
      clientOccurredAt: CLIENT_OCCURRED_AT,
    }),
  )
  const assigned = await repository.performWorkOrderAction(
    prioritized.workOrder.id,
    command({
      action: 'assign',
      payload: { engineerId: 'user-engineer' },
      expectedVersion: prioritized.workOrder.version,
      idempotencyKey: 'engineer-test-assign',
      clientOccurredAt: CLIENT_OCCURRED_AT,
    }),
  )

  await repository.switchDemoUser('user-engineer')
  const currentUser = await repository.getCurrentUser()
  const offlineService = new OfflineEngineerService({
    storage: new MemoryOfflineStorage(),
    now: () => new Date(repository.getSnapshot().demoClockIso),
    createId: (() => {
      let sequence = 0
      return () => `offline-test-${++sequence}`
    })(),
  })

  return {
    repository,
    currentUser,
    workOrder: assigned.workOrder,
    offlineService,
  }
}

async function advanceToInProgress(
  repository: Awaited<ReturnType<typeof createAssignedScenario>>['repository'],
  initialOrder: WorkOrder,
) {
  const accepted = await repository.performWorkOrderAction(
    initialOrder.id,
    command({
      action: 'accept',
      expectedVersion: initialOrder.version,
      idempotencyKey: 'engineer-test-accept-direct',
      clientOccurredAt: CLIENT_OCCURRED_AT,
    }),
  )
  const enRoute = await repository.performWorkOrderAction(
    initialOrder.id,
    command({
      action: 'mark_en_route',
      expectedVersion: accepted.workOrder.version,
      idempotencyKey: 'engineer-test-route-direct',
      clientOccurredAt: CLIENT_OCCURRED_AT,
    }),
  )
  return (
    await repository.performWorkOrderAction(
      initialOrder.id,
      command({
        action: 'start_work',
        expectedVersion: enRoute.workOrder.version,
        idempotencyKey: 'engineer-test-start-direct',
        clientOccurredAt: CLIENT_OCCURRED_AT,
      }),
    )
  ).workOrder
}

function renderWorkspace(
  scenario: Awaited<ReturnType<typeof createAssignedScenario>>,
  onInvalidateQueries = vi.fn(),
  initialEntry = `/my-work/${scenario.workOrder.id}`,
) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/my-work/:workOrderId/*"
          element={
            <EngineerWorkspace
              currentUser={scenario.currentUser}
              repository={scenario.repository}
              offlineService={scenario.offlineService}
              onInvalidateQueries={onInvalidateQueries}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  )
  return onInvalidateQueries
}

describe('EngineerWorkspace', () => {
  it('converts demo grant duration to a wall-clock-relative offline expiry', () => {
    const futureWallClock = Date.parse('2030-05-01T10:00:00.000Z')
    expect(
      calculateOfflineAccessExpiry(
        '2026-09-21T07:00:00.000Z',
        ['2026-09-21T09:00:00.000Z', '2026-09-21T19:00:00.000Z'],
        futureWallClock,
      ),
    ).toBe('2030-05-01T12:00:00.000Z')
  })

  it('runs the assigned, accepted, en route, in progress and waiting path', async () => {
    const user = userEvent.setup()
    const scenario = await createAssignedScenario()
    const onInvalidate = renderWorkspace(scenario)

    expect(
      await screen.findByRole('button', { name: 'Принять назначение' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Контекст откроется после принятия')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Принять назначение' }))
    expect(
      await screen.findByRole('button', { name: 'Выехать на объект' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Полный техконтекст объекта')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Выехать на объект' }))
    expect(
      await screen.findByRole('button', { name: 'Начать работу' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Начать работу' }))
    expect(
      await screen.findByRole('button', { name: 'Оформить результат' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Нет доступа' }))
    await user.type(
      screen.getByLabelText('Причина'),
      'Охрана не предоставила допуск',
    )
    await user.click(screen.getByRole('button', { name: 'Зафиксировать' }))

    expect(
      await screen.findByRole('button', { name: 'Продолжить работу' }),
    ).toBeInTheDocument()
    expect(onInvalidate).toHaveBeenCalled()
  })

  it('keeps a four-step result offline and synchronizes it after connectivity returns', async () => {
    const user = userEvent.setup()
    const scenario = await createAssignedScenario()
    scenario.workOrder = await advanceToInProgress(
      scenario.repository,
      scenario.workOrder,
    )
    renderWorkspace(scenario)

    const prepareButton = await screen.findByRole('button', {
      name: 'Подготовить офлайн-пакет',
    })
    await user.click(prepareButton)
    expect(await screen.findByText('Пакет готов')).toBeInTheDocument()

    await user.click(
      screen.getByRole('switch', { name: 'Перейти в режим без сети' }),
    )
    expect(screen.getByText('Демо: без сети')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Оформить результат' }))
    const wizard = screen.getByRole('heading', { name: 'Отчёт о выполнении' }).closest('section')
    if (!wizard) throw new Error('Result wizard was not rendered')

    await user.click(within(wizard).getByLabelText('Да'))
    await user.type(
      within(wizard).getByLabelText('Результат диагностики'),
      'Подтверждено нарушение контакта датчика',
    )
    await user.click(within(wizard).getByRole('button', { name: 'Далее' }))

    await user.type(
      within(wizard).getByLabelText('Выполненные действия'),
      'Проверены контакты\nЗаменён контактный модуль',
    )
    await user.type(within(wizard).getByLabelText('Трудозатраты, минут'), '45')
    await user.click(within(wizard).getByRole('button', { name: 'Далее' }))

    await user.click(within(wizard).getByLabelText('Да'))
    await user.type(
      within(wizard).getByLabelText('Контрольная проверка'),
      'Показания стабильны, тревог нет',
    )
    await user.selectOptions(
      within(wizard).getByLabelText('Остаточный риск'),
      'low',
    )
    await user.click(within(wizard).getByRole('button', { name: 'Далее' }))
    await user.click(
      within(wizard).getByRole('button', { name: 'Сохранить отчёт' }),
    )

    expect(
      await screen.findByText('Ожидает синхронизации'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Включить сеть' }))
    await user.click(
      await screen.findByRole('button', { name: 'Синхронизировать' }),
    )

    await waitFor(() => {
      expect(screen.getAllByText('Передана на проверку').length).toBeGreaterThan(0)
    })
    expect(
      screen.getAllByText(
        'Локальный отчёт синхронизирован и передан диспетчеру',
      ).length,
    ).toBeGreaterThan(0)
    expect(await scenario.offlineService.listMutations()).toEqual([
      expect.objectContaining({ status: 'synced' }),
    ])
  })

  it('restores an autosaved result draft after the workspace is remounted', async () => {
    const user = userEvent.setup()
    const scenario = await createAssignedScenario()
    scenario.workOrder = await advanceToInProgress(
      scenario.repository,
      scenario.workOrder,
    )
    const resultRoute = `/my-work/${scenario.workOrder.id}/result`

    renderWorkspace(scenario, vi.fn(), resultRoute)
    await user.click(await screen.findByLabelText('Да'))
    await user.type(
      screen.getByLabelText('Результат диагностики'),
      'Черновик проверки контактов',
    )

    await waitFor(async () => {
      const draft = await scenario.offlineService.getDraft<{
        form: { diagnosis: string }
      }>(scenario.workOrder.id)
      expect(draft?.form.diagnosis).toBe('Черновик проверки контактов')
    })

    cleanup()
    renderWorkspace(scenario, vi.fn(), resultRoute)

    expect(await screen.findByText('Черновик восстановлен')).toBeInTheDocument()
    expect(screen.getByLabelText('Результат диагностики')).toHaveValue(
      'Черновик проверки контактов',
    )

    await user.click(screen.getByRole('button', { name: 'Начать заново' }))
    expect(screen.getByLabelText('Результат диагностики')).toHaveValue('')
    await waitFor(async () => {
      expect(
        await scenario.offlineService.getDraft(scenario.workOrder.id),
      ).toBeUndefined()
    })
  })

  it('shows a version conflict without deleting the local report', async () => {
    const user = userEvent.setup()
    const scenario = await createAssignedScenario()
    const inProgress = await advanceToInProgress(
      scenario.repository,
      scenario.workOrder,
    )
    const grant = inProgress.accessGrant
    if (!grant?.offlineCacheExpiresAt) {
      throw new Error('Expected active offline grant')
    }
    await scenario.offlineService.preparePackage({
      workOrderId: inProgress.id,
      engineerId: scenario.currentUser.id,
      grantId: grant.id,
      expectedVersion: inProgress.version,
      accessExpiresAt: grant.offlineCacheExpiresAt,
      context: { workOrder: inProgress },
    })
    const staleCommand = command({
      action: 'submit_result',
      expectedVersion: inProgress.version,
      idempotencyKey: 'engineer-conflict-result',
      clientOccurredAt: CLIENT_OCCURRED_AT,
      payload: {
        repairResult: {
          failureConfirmed: true,
          rootCauseCode: 'contact_failure',
          diagnosis: 'Локальный отчёт инженера',
          actions: ['Проверены контакты'],
          parts: [],
          laborMinutes: 20,
          equipmentRestored: true,
          controlCheckResult: 'Проверка пройдена',
          residualRisk: 'low',
          recommendations: '',
          requiresFollowUp: false,
        },
      },
    })
    await scenario.offlineService.enqueue({
      idempotencyKey: staleCommand.idempotencyKey,
      kind: 'submit_engineer_result',
      workOrderId: inProgress.id,
      engineerId: scenario.currentUser.id,
      grantId: grant.id,
      expectedVersion: inProgress.version,
      payload: staleCommand,
    })

    const waiting = await scenario.repository.performWorkOrderAction(
      inProgress.id,
      command({
        action: 'wait_access',
        payload: { reason: 'Версия изменена для проверки конфликта' },
        expectedVersion: inProgress.version,
        idempotencyKey: 'engineer-conflict-wait',
        clientOccurredAt: CLIENT_OCCURRED_AT,
      }),
    )
    scenario.workOrder = (
      await scenario.repository.performWorkOrderAction(
        inProgress.id,
        command({
          action: 'resume_work',
          expectedVersion: waiting.workOrder.version,
          idempotencyKey: 'engineer-conflict-resume',
          clientOccurredAt: CLIENT_OCCURRED_AT,
        }),
      )
    ).workOrder

    renderWorkspace(scenario)
    await user.click(
      await screen.findByRole('button', { name: 'Синхронизировать' }),
    )

    expect(
      await screen.findByText('Нужно разрешить конфликт'),
    ).toBeInTheDocument()
    const retained = await scenario.offlineService.listMutations<
      typeof staleCommand
    >()
    expect(retained[0]).toMatchObject({
      status: 'conflict',
      payload: {
        payload: { repairResult: { diagnosis: 'Локальный отчёт инженера' } },
      },
    })
  })
})
