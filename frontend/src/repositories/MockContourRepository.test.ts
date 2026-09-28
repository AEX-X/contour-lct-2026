import { describe, expect, it } from 'vitest'
import type { RepositoryError, WorkOrder, WorkOrderActionCommand } from '../domain'
import { createMemoryStorage } from './memoryStorage'
import { createMockContourRepository } from './MockContourRepository'

const clientOccurredAt = '2026-09-21T07:00:00.000Z'

function action<T extends WorkOrderActionCommand>(command: T): T {
  return command
}

async function createSubmittedMainOrder() {
  const repository = createMockContourRepository({ storage: createMemoryStorage() })
  await repository.switchDemoUser('user-dispatcher')
  const risk = await repository.getRisk('risk-main-001')
  const decision = await repository.confirmRisk(risk.id, {
    expectedVersion: risk.version,
    idempotencyKey: 'confirm-main-before-order',
    clientOccurredAt,
    comment: 'Прогноз подтверждён перед созданием заявки',
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
    { idempotencyKey: 'create-main', clientOccurredAt },
  )
  const submitted = await repository.performWorkOrderAction(
    draft.id,
    action({
      action: 'submit',
      expectedVersion: draft.version,
      idempotencyKey: 'submit-main',
      clientOccurredAt,
    }),
  )
  return { repository, order: submitted.workOrder }
}

async function moveToAssigned(repository: ReturnType<typeof createMockContourRepository>, order: WorkOrder) {
  await repository.switchDemoUser('user-coordinator')
  const triage = await repository.performWorkOrderAction(
    order.id,
    action({
      action: 'start_triage',
      expectedVersion: order.version,
      idempotencyKey: 'triage-main',
      clientOccurredAt,
    }),
  )
  const prioritized = await repository.performWorkOrderAction(
    order.id,
    action({
      action: 'finalize_priority',
      payload: { priority: 'P2', slaPolicyId: 'sla-demo-p2' },
      expectedVersion: triage.workOrder.version,
      idempotencyKey: 'priority-main',
      clientOccurredAt,
    }),
  )
  const assigned = await repository.performWorkOrderAction(
    order.id,
    action({
      action: 'assign',
      payload: { engineerId: 'user-engineer' },
      expectedVersion: prioritized.workOrder.version,
      idempotencyKey: 'assign-main',
      clientOccurredAt,
    }),
  )
  return assigned.workOrder
}

async function moveAssignedOrderToInProgress(
  repository: ReturnType<typeof createMockContourRepository>,
  order: WorkOrder,
  keyPrefix: string,
) {
  await repository.switchDemoUser('user-engineer')
  const accepted = await repository.performWorkOrderAction(
    order.id,
    action({
      action: 'accept',
      expectedVersion: order.version,
      idempotencyKey: `${keyPrefix}-accept`,
      clientOccurredAt,
    }),
  )
  const enRoute = await repository.performWorkOrderAction(
    order.id,
    action({
      action: 'mark_en_route',
      expectedVersion: accepted.workOrder.version,
      idempotencyKey: `${keyPrefix}-en-route`,
      clientOccurredAt,
    }),
  )
  return (
    await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'start_work',
        expectedVersion: enRoute.workOrder.version,
        idempotencyKey: `${keyPrefix}-start`,
        clientOccurredAt,
      }),
    )
  ).workOrder
}

function validRepairResult() {
  return {
    failureConfirmed: true,
    rootCauseCode: 'SENSOR_DRIFT',
    diagnosis: 'Подтверждён дрейф показаний демонстрационного датчика',
    actions: ['Проверка контактов', 'Калибровка датчика', 'Контрольный замер'],
    parts: [],
    laborMinutes: 45,
    equipmentRestored: true,
    controlCheckResult: 'Контрольные показания в норме',
    residualRisk: 'low' as const,
    recommendations: 'Повторный контроль через 7 дней',
    requiresFollowUp: true,
  }
}

describe('MockContourRepository', () => {
  it('runs the full five-role happy path and preserves one work order', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    expect(await repository.getFacility('fac-001')).toMatchObject({
      status: 'attention',
      statusReason: expect.stringContaining('Подтверждена необходимость проверки'),
    })
    const assigned = await moveToAssigned(repository, order)

    await repository.switchDemoUser('user-engineer')
    expect((await repository.listWorkOrders({ assignedToCurrentUser: true }))[0]?.id).toBe(order.id)
    const accepted = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'accept',
        expectedVersion: assigned.version,
        idempotencyKey: 'accept-main',
        clientOccurredAt,
      }),
    )
    expect((await repository.getFacility('fac-001')).id).toBe('fac-001')
    const enRoute = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'mark_en_route',
        expectedVersion: accepted.workOrder.version,
        idempotencyKey: 'en-route-main',
        clientOccurredAt,
      }),
    )
    const inProgress = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'start_work',
        expectedVersion: enRoute.workOrder.version,
        idempotencyKey: 'start-work-main',
        clientOccurredAt,
      }),
    )
    const completed = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'submit_result',
        payload: {
          repairResult: {
            failureConfirmed: true,
            rootCauseCode: 'SENSOR_DRIFT',
            diagnosis: 'Подтверждён дрейф показаний демонстрационного датчика',
            actions: ['Проверка контактов', 'Калибровка датчика', 'Контрольный замер'],
            parts: [],
            laborMinutes: 45,
            equipmentRestored: true,
            controlCheckResult: 'Контрольные показания в норме',
            residualRisk: 'low',
            recommendations: 'Повторный контроль через 7 дней',
            requiresFollowUp: true,
          },
        },
        expectedVersion: inProgress.workOrder.version,
        idempotencyKey: 'complete-main',
        clientOccurredAt,
      }),
    )

    await repository.switchDemoUser('user-dispatcher')
    const verification = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'start_verification',
        expectedVersion: completed.workOrder.version,
        idempotencyKey: 'verify-main',
        clientOccurredAt,
      }),
    )
    const closed = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'close',
        payload: { equipmentOperational: true, comment: 'Работа принята' },
        expectedVersion: verification.workOrder.version,
        idempotencyKey: 'close-main',
        clientOccurredAt,
      }),
    )

    expect(closed.workOrder.status).toBe('closed')
    expect(closed.workOrder.accessGrant?.status).toBe('revoked')
    expect(closed.workOrder.repairResult?.author?.id).toBe('user-engineer')
    expect((await repository.getAuditTimeline('work_order', order.id)).length).toBeGreaterThanOrEqual(9)
    expect((await repository.listIncidents('fac-001')).find(
      (incident) => incident.sourceRiskId === 'risk-main-001',
    )?.status).toBe('resolved')
    expect((await repository.getRisk('risk-main-001')).status).toBe('resolved')
    expect(await repository.getFacility('fac-001')).toMatchObject({
      status: 'attention',
      statusReason: 'Датчик требует внимания: Датчик температуры Т-17',
    })

    await repository.switchDemoUser('user-manager')
    const metrics = await repository.getDashboardMetrics()
    expect(metrics.find((item) => item.code === 'high_risks_without_action')?.value).toBe(0)
    expect(metrics.find((item) => item.code === 'closed_work_orders_24h')?.value).toBe(2)
  })

  it('falls back from an expired forecast to the live telemetry status', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    expect((await repository.getFacility('fac-001')).status).toBe('attention')

    await repository.advanceDemoClock(72 * 60)

    expect(await repository.getFacility('fac-001')).toMatchObject({
      status: 'attention',
      statusReason: 'Датчик требует внимания: Датчик температуры Т-17',
    })
    expect(
      (await repository.getDashboardMetrics()).find(
        (item) => item.code === 'high_risks_without_action',
      )?.value,
    ).toBe(0)
  })

  it('rejects a stale version but replays the original idempotent response', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    await repository.switchDemoUser('user-coordinator')
    const command = action({
      action: 'start_triage',
      expectedVersion: order.version,
      idempotencyKey: 'idempotent-triage',
      clientOccurredAt,
    })
    const first = await repository.performWorkOrderAction(order.id, command)
    const replay = await repository.performWorkOrderAction(order.id, command)

    expect(replay).toEqual(first)
    await expect(
      repository.performWorkOrderAction(
        order.id,
        action({
          action: 'request_clarification',
          payload: { reason: 'Нужна дополнительная информация' },
          expectedVersion: order.version,
          idempotencyKey: 'stale-command',
          clientOccurredAt,
        }),
      ),
    ).rejects.toMatchObject<Partial<RepositoryError>>({
      code: 'VERSION_CONFLICT',
      currentVersion: first.workOrder.version,
    })
  })

  it('replays an engineer decline after the first command revoked access', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    const assigned = await moveToAssigned(repository, order)
    await repository.switchDemoUser('user-engineer')
    const command = action({
      action: 'decline',
      payload: { reason: 'Нужна другая специализация' },
      expectedVersion: assigned.version,
      idempotencyKey: 'decline-replay-after-revoke',
      clientOccurredAt,
    })

    const first = await repository.performWorkOrderAction(order.id, command)
    const replay = await repository.performWorkOrderAction(order.id, command)

    expect(first.workOrder.status).toBe('triage')
    expect(first.workOrder.accessGrant?.status).toBe('revoked')
    expect(replay).toEqual(first)
  })

  it('supports explicit clarification and resubmission actions', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    await repository.switchDemoUser('user-coordinator')
    const triage = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'start_triage',
        expectedVersion: order.version,
        idempotencyKey: 'clarification-triage',
        clientOccurredAt,
      }),
    )
    const clarification = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'request_clarification',
        payload: { reason: 'Уточнить признаки неисправности' },
        expectedVersion: triage.workOrder.version,
        idempotencyKey: 'clarification-request',
        clientOccurredAt,
      }),
    )
    expect(clarification.workOrder.status).toBe('needs_clarification')

    await repository.switchDemoUser('user-dispatcher')
    const resubmitted = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'resubmit_clarification',
        payload: { comment: 'Добавлены признаки перегрева и нестабильной работы' },
        expectedVersion: clarification.workOrder.version,
        idempotencyKey: 'clarification-resubmit',
        clientOccurredAt,
      }),
    )
    expect(resubmitted.workOrder.status).toBe('submitted')
  })

  it('turns a human-confirmed forecast into an incident without calling it a failure', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-dispatcher')
    const risk = await repository.getRisk('risk-main-001')
    const result = await repository.confirmRisk(risk.id, {
      expectedVersion: risk.version,
      idempotencyKey: 'confirm-risk-main',
      clientOccurredAt,
      comment: 'Нужна инструментальная проверка на объекте',
    })

    expect(result.risk.status).toBe('confirmed')
    expect(result.incident.sourceRiskId).toBe(risk.id)
    expect(result.incident.failureEpisodeId).toBeNull()
  })

  it('does not create a repair order from an unconfirmed forecast', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-dispatcher')
    const risk = await repository.getRisk('risk-main-001')

    await expect(repository.createWorkOrder(
      {
        source: { type: 'risk', id: risk.id },
        target: risk.target,
        categoryCode: 'predictive_maintenance',
        symptoms: ['Рост температуры'],
        description: 'Попытка обойти подтверждение прогноза',
        preliminaryPriority: 'P2',
      },
      { idempotencyKey: 'unconfirmed-risk-order', clientOccurredAt },
    )).rejects.toMatchObject<Partial<RepositoryError>>({ code: 'INVALID_TRANSITION' })
  })

  it('prevents a facility dispatcher from reading another facility', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-dispatcher')

    expect((await repository.listFacilities()).map((facility) => facility.id)).toEqual(['fac-001'])
    await expect(repository.getFacility('fac-002')).rejects.toMatchObject<Partial<RepositoryError>>({
      code: 'FORBIDDEN',
    })
  })

  it('canonicalizes a work-order target instead of trusting client display data', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-dispatcher')
    const sensor = (await repository.listSensors('fac-001'))[0]!
    const created = await repository.createWorkOrder(
      {
        source: { type: 'manual', id: null },
        target: {
          type: 'sensor',
          id: sensor.id,
          facilityId: sensor.facilityId,
          displayName: 'Подменённое имя',
          hierarchyPath: [{ type: 'path', id: 'spoof', displayName: 'Подменённый путь' }],
          locationSnapshot: { text: null, geo: null, planPosition: null },
        },
        categoryCode: 'inspection',
        symptoms: ['Нестабильные показания'],
        description: 'Проверить канонизацию цели заявки',
        preliminaryPriority: 'P3',
      },
      { idempotencyKey: 'canonical-target', clientOccurredAt },
    )

    expect(created.target.displayName).toBe(sensor.name)
    expect(created.target.hierarchyPath).not.toContainEqual(
      expect.objectContaining({ displayName: 'Подменённый путь' }),
    )
  })

  it('filters and enforces engineer specialization for the selected asset', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-dispatcher')
    const fan = (await repository.listEquipment('fac-001')).find((item) => item.id === 'eq-fan-001')!
    const draft = await repository.createWorkOrder(
      {
        source: { type: 'manual', id: null },
        target: {
          type: 'equipment',
          id: fan.id,
          facilityId: fan.facilityId,
          displayName: fan.name,
          hierarchyPath: [],
          locationSnapshot: { text: null, geo: null, planPosition: null },
        },
        categoryCode: 'predictive_maintenance',
        symptoms: ['Перегрев вентилятора'],
        description: 'Проверить вентиляционную установку',
        preliminaryPriority: 'P2',
      },
      { idempotencyKey: 'specialization-create', clientOccurredAt },
    )
    const submitted = await repository.performWorkOrderAction(draft.id, action({
      action: 'submit',
      expectedVersion: draft.version,
      idempotencyKey: 'specialization-submit',
      clientOccurredAt,
    }))
    await repository.switchDemoUser('user-coordinator')
    const triage = await repository.performWorkOrderAction(draft.id, action({
      action: 'start_triage',
      expectedVersion: submitted.workOrder.version,
      idempotencyKey: 'specialization-triage',
      clientOccurredAt,
    }))
    const prioritized = await repository.performWorkOrderAction(draft.id, action({
      action: 'finalize_priority',
      payload: { priority: 'P2', slaPolicyId: 'ignored-client-policy' },
      expectedVersion: triage.workOrder.version,
      idempotencyKey: 'specialization-priority',
      clientOccurredAt,
    }))
    const candidates = await repository.listEngineerCandidates(draft.id)

    expect(candidates.find((item) => item.user.id === 'user-engineer')?.eligible).toBe(true)
    expect(candidates.find((item) => item.user.id === 'user-engineer-busy')?.eligible).toBe(false)
    await expect(repository.performWorkOrderAction(draft.id, action({
      action: 'assign',
      payload: { engineerId: 'user-engineer-busy' },
      expectedVersion: prioritized.workOrder.version,
      idempotencyKey: 'specialization-invalid-assign',
      clientOccurredAt,
    }))).rejects.toMatchObject<Partial<RepositoryError>>({ code: 'NO_SUITABLE_ENGINEER' })
  })

  it('revokes facility access after the work order is closed', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    let current = await moveToAssigned(repository, order)
    await repository.switchDemoUser('user-engineer')
    for (const command of [
      action({
        action: 'accept',
        expectedVersion: current.version,
        idempotencyKey: 'grant-accept',
        clientOccurredAt,
      }),
      action({
        action: 'mark_en_route',
        expectedVersion: current.version + 1,
        idempotencyKey: 'grant-route',
        clientOccurredAt,
      }),
      action({
        action: 'start_work',
        expectedVersion: current.version + 2,
        idempotencyKey: 'grant-start',
        clientOccurredAt,
      }),
    ]) {
      current = (await repository.performWorkOrderAction(order.id, command)).workOrder
    }
    current = (
      await repository.performWorkOrderAction(
        order.id,
        action({
          action: 'submit_result',
          payload: {
            repairResult: {
              failureConfirmed: false,
              rootCauseCode: null,
              diagnosis: 'Неисправность оборудования не подтверждена',
              actions: ['Контрольный осмотр'],
              parts: [],
              laborMinutes: 20,
              equipmentRestored: true,
              controlCheckResult: 'Работа в штатном режиме',
              residualRisk: 'none',
              recommendations: 'Продолжить наблюдение',
              requiresFollowUp: false,
            },
          },
          expectedVersion: current.version,
          idempotencyKey: 'grant-result',
          clientOccurredAt,
        }),
      )
    ).workOrder

    await repository.switchDemoUser('user-dispatcher')
    current = (
      await repository.performWorkOrderAction(
        order.id,
        action({
          action: 'start_verification',
          expectedVersion: current.version,
          idempotencyKey: 'grant-verify',
          clientOccurredAt,
        }),
      )
    ).workOrder
    await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'close',
        payload: { equipmentOperational: true },
        expectedVersion: current.version,
        idempotencyKey: 'grant-close',
        clientOccurredAt,
      }),
    )

    await repository.switchDemoUser('user-engineer')
    expect((await repository.getCurrentUser()).activeAccessGrants).toHaveLength(0)
    await expect(repository.getFacility('fac-001')).rejects.toMatchObject<Partial<RepositoryError>>({
      code: 'FORBIDDEN',
    })
  })

  it('recomputes KPI from the shared state after create and close', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    const initialMetrics = await repository.getDashboardMetrics()
    expect(initialMetrics.find((item) => item.code === 'high_risks_without_action')?.value).toBe(1)
    expect(initialMetrics.find((item) => item.code === 'closed_work_orders_24h')?.value).toBe(1)

    const { repository: journeyRepository, order } = await createSubmittedMainOrder()
    await journeyRepository.switchDemoUser('user-manager')
    const afterCreate = await journeyRepository.getDashboardMetrics()
    expect(afterCreate.find((item) => item.code === 'high_risks_without_action')?.value).toBe(0)
    expect(order.id).toBe('wo-demo-main')
  })

  it('assigns a dispatcher to a facility without one and replays the command safely', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-senior')
    const facility = await repository.getFacility('fac-002')
    expect(facility.responsibleDispatcherId).toBeNull()
    const command = {
      facilityId: facility.id,
      dispatcherId: 'user-dispatcher-alt',
      startsAt: '2026-09-21T06:00:00.000Z',
      endsAt: '2026-09-21T15:00:00.000Z',
      expectedVersion: facility.version,
      idempotencyKey: 'assign-dispatcher-fac-002',
      clientOccurredAt,
    }
    const first = await repository.assignFacilityDispatcher(command)
    const replay = await repository.assignFacilityDispatcher(command)

    expect(first.facility.responsibleDispatcherId).toBe('user-dispatcher-alt')
    expect(replay).toEqual(first)
  })

  it('treats the dispatcher assignment end as an exclusive boundary', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-dispatcher')
    expect((await repository.listFacilities()).map((facility) => facility.id)).toEqual(['fac-001'])

    await repository.advanceDemoClock(9 * 60)

    expect(await repository.listFacilities()).toEqual([])
    await expect(repository.getFacility('fac-001')).rejects.toMatchObject<Partial<RepositoryError>>({
      code: 'FORBIDDEN',
    })
  })

  it('expires an engineer grant exactly at its expiry boundary', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    const assigned = await moveToAssigned(repository, order)
    const expiresAt = assigned.accessGrant?.expiresAt
    expect(expiresAt).toBe('2026-09-23T07:00:00.000Z')

    await repository.advanceDemoClock(48 * 60)
    await repository.switchDemoUser('user-engineer')
    const expired = await repository.getWorkOrder(order.id)

    expect(expired.accessGrant).toMatchObject({ status: 'expired', expiresAt })
    expect(expired.allowedActions).not.toContain('accept')
    await expect(repository.getFacility('fac-001')).rejects.toMatchObject<Partial<RepositoryError>>({
      code: 'FORBIDDEN',
    })
  })

  it('preserves the original SLA breach after the workflow advances to another stage', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    const assigned = await moveToAssigned(repository, order)

    await repository.advanceDemoClock(31)
    await repository.switchDemoUser('user-engineer')
    const breached = await repository.getWorkOrder(order.id)
    expect(breached.sla).toMatchObject({
      currentStage: 'acceptance',
      state: 'breached',
      breachStage: 'acceptance',
    })

    const accepted = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'accept',
        expectedVersion: assigned.version,
        idempotencyKey: 'accept-after-sla-breach',
        clientOccurredAt,
      }),
    )

    expect(accepted.workOrder.sla).toMatchObject({
      currentStage: 'arrival',
      state: 'breached',
      breachStage: 'acceptance',
    })
  })

  it('rejects an invalid repair report with field-level errors and keeps the order in progress', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    const assigned = await moveToAssigned(repository, order)
    const inProgress = await moveAssignedOrderToInProgress(repository, assigned, 'invalid-result')

    await expect(
      repository.performWorkOrderAction(
        order.id,
        action({
          action: 'submit_result',
          payload: {
            repairResult: {
              failureConfirmed: null,
              rootCauseCode: null,
              diagnosis: 'нет',
              actions: [],
              parts: [{ partCode: '', name: '', quantity: 0, unit: '' }],
              laborMinutes: 0,
              equipmentRestored: null,
              controlCheckResult: '',
              residualRisk: null,
              recommendations: '',
              requiresFollowUp: false,
            },
          },
          expectedVersion: inProgress.version,
          idempotencyKey: 'invalid-repair-result',
          clientOccurredAt,
        }),
      ),
    ).rejects.toMatchObject<Partial<RepositoryError>>({
      code: 'VALIDATION_ERROR',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ field: 'failureConfirmed', code: 'required' }),
        expect.objectContaining({ field: 'diagnosis', code: 'too_short' }),
        expect.objectContaining({ field: 'actions', code: 'required' }),
        expect.objectContaining({ field: 'laborMinutes', code: 'invalid' }),
        expect.objectContaining({ field: 'parts.0', code: 'invalid' }),
        expect.objectContaining({ field: 'equipmentRestored', code: 'required' }),
        expect.objectContaining({ field: 'controlCheckResult', code: 'too_short' }),
        expect.objectContaining({ field: 'residualRisk', code: 'required' }),
      ]),
    })
    expect(await repository.getWorkOrder(order.id)).toMatchObject({
      status: 'in_progress',
      repairResult: null,
      version: inProgress.version,
    })
  })

  it('uses the canonical electrical equipment category for engineer eligibility', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-dispatcher')
    const panel = (await repository.listEquipment('fac-001')).find((item) => item.id === 'eq-panel-001')!
    const draft = await repository.createWorkOrder(
      {
        source: { type: 'manual', id: null },
        target: {
          type: 'equipment',
          id: panel.id,
          facilityId: panel.facilityId,
          displayName: 'Подменённое имя шкафа',
          hierarchyPath: [],
          locationSnapshot: { text: null, geo: null, planPosition: null },
        },
        categoryCode: 'inspection',
        symptoms: ['Нестабильная работа автоматики'],
        description: 'Проверить электрический шкаф управления',
        preliminaryPriority: 'P2',
      },
      { idempotencyKey: 'electrical-create', clientOccurredAt },
    )
    const submitted = await repository.performWorkOrderAction(
      draft.id,
      action({
        action: 'submit',
        expectedVersion: draft.version,
        idempotencyKey: 'electrical-submit',
        clientOccurredAt,
      }),
    )
    await repository.switchDemoUser('user-coordinator')
    const triage = await repository.performWorkOrderAction(
      draft.id,
      action({
        action: 'start_triage',
        expectedVersion: submitted.workOrder.version,
        idempotencyKey: 'electrical-triage',
        clientOccurredAt,
      }),
    )
    await repository.performWorkOrderAction(
      draft.id,
      action({
        action: 'finalize_priority',
        payload: { priority: 'P2', slaPolicyId: 'ignored-client-policy' },
        expectedVersion: triage.workOrder.version,
        idempotencyKey: 'electrical-priority',
        clientOccurredAt,
      }),
    )
    const candidates = await repository.listEngineerCandidates(draft.id)

    expect(draft.target).toMatchObject({ id: panel.id, displayName: panel.name })
    expect(candidates.find((item) => item.user.id === 'user-engineer')?.eligible).toBe(true)
    expect(candidates.find((item) => item.user.id === 'user-engineer-busy')?.eligible).toBe(false)
    expect(candidates.find((item) => item.user.id === 'user-engineer-alt')?.eligible).toBe(false)
  })

  it('creates an order for the seeded fac-003 incident and exposes its context to the coordinator', async () => {
    const repository = createMockContourRepository({ storage: createMemoryStorage() })
    await repository.switchDemoUser('user-senior')
    const incident = (await repository.listIncidents('fac-003')).find(
      (item) => item.id === 'incident-critical-001',
    )!
    const draft = await repository.createWorkOrder(
      {
        source: { type: 'incident', id: incident.id },
        target: incident.target,
        categoryCode: 'inspection',
        symptoms: ['Подтверждённое задымление'],
        description: 'Проверить участок после подтверждённого сигнала задымления',
        preliminaryPriority: 'P1',
      },
      { idempotencyKey: 'fac-003-incident-create', clientOccurredAt },
    )
    const submitted = await repository.performWorkOrderAction(
      draft.id,
      action({
        action: 'submit',
        expectedVersion: draft.version,
        idempotencyKey: 'fac-003-incident-submit',
        clientOccurredAt,
      }),
    )

    expect(submitted.workOrder).toMatchObject({
      status: 'submitted',
      source: { type: 'incident', id: incident.id },
      target: { id: 'section-fac-003-01', facilityId: 'fac-003' },
    })

    await repository.switchDemoUser('user-coordinator')
    expect(await repository.getFacility('fac-003')).toMatchObject({ id: 'fac-003' })
    expect((await repository.listIncidents('fac-003')).map((item) => item.id)).toContain(incident.id)
  })

  it('keeps a linked incident open while another related work order is still active', async () => {
    const { repository, order } = await createSubmittedMainOrder()
    await repository.switchDemoUser('user-dispatcher')
    const incident = (await repository.listIncidents('fac-001')).find(
      (item) => item.sourceRiskId === 'risk-main-001',
    )!
    const secondDraft = await repository.createWorkOrder(
      {
        source: { type: 'incident', id: incident.id },
        target: incident.target,
        categoryCode: 'inspection',
        symptoms: ['Повторная независимая проверка'],
        description: 'Параллельная контрольная заявка по тому же инциденту',
        preliminaryPriority: 'P3',
      },
      { idempotencyKey: 'second-linked-create', clientOccurredAt },
    )
    const secondSubmitted = await repository.performWorkOrderAction(
      secondDraft.id,
      action({
        action: 'submit',
        expectedVersion: secondDraft.version,
        idempotencyKey: 'second-linked-submit',
        clientOccurredAt,
      }),
    )
    const assigned = await moveToAssigned(repository, order)
    const inProgress = await moveAssignedOrderToInProgress(repository, assigned, 'first-linked')
    const completed = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'submit_result',
        payload: { repairResult: validRepairResult() },
        expectedVersion: inProgress.version,
        idempotencyKey: 'first-linked-result',
        clientOccurredAt,
      }),
    )

    await repository.switchDemoUser('user-dispatcher')
    const verification = await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'start_verification',
        expectedVersion: completed.workOrder.version,
        idempotencyKey: 'first-linked-verification',
        clientOccurredAt,
      }),
    )
    await repository.performWorkOrderAction(
      order.id,
      action({
        action: 'close',
        payload: { equipmentOperational: true, comment: 'Первая заявка принята' },
        expectedVersion: verification.workOrder.version,
        idempotencyKey: 'first-linked-close',
        clientOccurredAt,
      }),
    )

    expect(await repository.getWorkOrder(secondSubmitted.workOrder.id)).toMatchObject({ status: 'submitted' })
    expect((await repository.listIncidents('fac-001')).find((item) => item.id === incident.id)).toMatchObject({
      status: 'open',
      resolvedAt: null,
    })
    expect(await repository.getRisk('risk-main-001')).toMatchObject({ status: 'confirmed' })
  })

  it('persists shared scenario data without leaking the selected profile to a new session', async () => {
    const storage = createMemoryStorage()
    const first = createMockContourRepository({ storage })
    await first.switchDemoUser('user-dispatcher')
    const risk = await first.getRisk('risk-main-001')
    const decision = await first.confirmRisk(risk.id, {
      expectedVersion: risk.version,
      idempotencyKey: 'persist-confirm',
      clientOccurredAt,
      comment: 'Подтверждение перед проверкой сохранения',
    })
    await first.createWorkOrder(
      {
        source: { type: 'incident', id: decision.incident.id },
        target: risk.target,
        categoryCode: 'inspection',
        symptoms: ['Рост температуры'],
        description: 'Проверка persistence',
        preliminaryPriority: 'P2',
      },
      { idempotencyKey: 'persist-order', clientOccurredAt },
    )

    const reloaded = createMockContourRepository({ storage })
    expect((await reloaded.getCurrentUser()).id).toBe('user-manager')
    expect((await reloaded.listWorkOrders()).some((item) => item.id === 'wo-demo-main')).toBe(true)

    const scenarioBeforeReset = reloaded.getSnapshot().scenarioId
    await reloaded.reset()
    expect((await reloaded.getCurrentUser()).id).toBe('user-manager')
    expect((await reloaded.listWorkOrders()).some((item) => item.id === 'wo-demo-main')).toBe(false)
    expect(reloaded.getSnapshot().scenarioId).not.toBe(scenarioBeforeReset)
    expect(reloaded.getSnapshot().scenarioId).toContain(':generation:')
  })

  it('serializes writes from repository instances that share one store', async () => {
    const storage = createMemoryStorage()
    const first = createMockContourRepository({ storage })
    const second = createMockContourRepository({ storage })
    await Promise.all([
      first.switchDemoUser('user-dispatcher'),
      second.switchDemoUser('user-dispatcher'),
    ])
    const risk = await first.getRisk('risk-main-001')
    const baseInput = {
      source: { type: 'manual' as const, id: null },
      target: risk.target,
      categoryCode: 'inspection',
      symptoms: ['Контрольный осмотр'],
      preliminaryPriority: 'P3' as const,
    }

    const [createdFirst, createdSecond] = await Promise.all([
      first.createWorkOrder(
        { ...baseInput, description: 'Первая конкурентная заявка' },
        { idempotencyKey: 'concurrent-create-1', clientOccurredAt },
      ),
      second.createWorkOrder(
        { ...baseInput, description: 'Вторая конкурентная заявка' },
        { idempotencyKey: 'concurrent-create-2', clientOccurredAt },
      ),
    ])
    const reloaded = createMockContourRepository({ storage })
    const ids = (await reloaded.listWorkOrders()).map((item) => item.id)

    expect(createdFirst.id).not.toBe(createdSecond.id)
    expect(ids).toEqual(expect.arrayContaining([createdFirst.id, createdSecond.id]))
  })

  it('does not acknowledge a mutation that could not be persisted', async () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      },
      removeItem: () => undefined,
    }
    const repository = createMockContourRepository({ storage })
    await repository.switchDemoUser('user-dispatcher')
    const risk = await repository.getRisk('risk-main-001')

    await expect(repository.createWorkOrder(
      {
        source: { type: 'manual', id: null },
        target: risk.target,
        categoryCode: 'inspection',
        symptoms: ['Проверка сохранения'],
        description: 'Изменение не должно считаться сохранённым',
        preliminaryPriority: 'P3',
      },
      { idempotencyKey: 'persistence-failure', clientOccurredAt },
    )).rejects.toMatchObject<Partial<RepositoryError>>({ code: 'PERSISTENCE_FAILED' })

    expect((await repository.listWorkOrders()).some((item) => item.id === 'wo-demo-main')).toBe(false)
  })
})
