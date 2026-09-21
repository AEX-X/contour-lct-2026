import {
  ArrowLeft,
  Buildings,
  CaretRight,
  CheckCircle,
  CloudArrowDown,
  CloudCheck,
  CloudSlash,
  Database,
  HardHat,
  MapPin,
  Package,
  Pause,
  Play,
  ShieldCheck,
  SignIn,
  SpinnerGap,
  Truck,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  Wrench,
} from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import {
  OfflineEngineerService,
  type OfflineMutation,
  type OfflineMutationStatus,
} from '../../offline'
import {
  RepositoryError,
  type AuditEvent,
  type ContourRepository,
  type CurrentUser,
  type Equipment,
  type Facility,
  type HierarchyNode,
  type Incident,
  type RepairResult,
  type RiskForecast,
  type Sensor,
  type WorkOrder,
  type WorkOrderActionCommand,
} from '../../repositories'
import { Button } from '../../shared/ui/Button'
import { DemoBadge } from '../../shared/ui/DemoBadge'
import { EmptyState } from '../../shared/ui/EmptyState'
import { InlineAlert } from '../../shared/ui/InlineAlert'
import { Skeleton } from '../../shared/ui/Skeleton'
import { StatusBadge, type StatusTone } from '../../shared/ui/StatusBadge'
import {
  isResultWizardDraft,
  ResultWizard,
  type ResultWizardDraft,
} from './ResultWizard'
import { createClientId } from '../../app/clientId'
import './engineer.css'

type SimpleEngineerAction =
  | 'accept'
  | 'mark_en_route'
  | 'start_work'
  | 'resume_work'

type WaitingAction = 'wait_access' | 'wait_parts'

type QueuedResultCommand = Extract<
  WorkOrderActionCommand,
  { action: 'submit_result' }
>

interface EngineerTechnicalContext {
  workOrder: WorkOrder
  facility: Facility
  hierarchy: HierarchyNode[]
  equipment: Equipment[]
  sensors: Sensor[]
  risks: RiskForecast[]
  incidents: Incident[]
  workOrders: WorkOrder[]
  auditEvents: AuditEvent[]
}

export function calculateOfflineAccessExpiry(
  demoNowIso: string,
  grantDeadlines: readonly string[],
  wallNowMs: number,
): string {
  const demoNowMs = Date.parse(demoNowIso)
  const validDeadlines = grantDeadlines.map((value) => Date.parse(value)).filter(Number.isFinite)
  if (!Number.isFinite(demoNowMs)) throw new Error('Некорректное время демонстрационного сценария')
  const remainingMs = validDeadlines.length
    ? Math.max(0, Math.min(...validDeadlines) - demoNowMs)
    : 12 * 60 * 60 * 1000
  if (remainingMs <= 0) throw new Error('Срок офлайн-доступа истёк. Обнови назначение')
  return new Date(wallNowMs + Math.min(remainingMs, 12 * 60 * 60 * 1000)).toISOString()
}

export interface EngineerWorkspaceProps {
  currentUser: CurrentUser
  repository: ContourRepository
  onInvalidateQueries?: () => void | Promise<void>
  workOrderId?: string
  offlineService?: OfflineEngineerService
  isOnline?: boolean
  onOnlineChange?: (value: boolean) => void
}

const STATUS_LABELS: Record<WorkOrder['status'], string> = {
  draft: 'Черновик',
  submitted: 'Отправлена',
  triage: 'Триаж',
  needs_clarification: 'Нужно уточнение',
  assigned: 'Назначена',
  accepted: 'Принята',
  en_route: 'В пути',
  in_progress: 'В работе',
  waiting_access: 'Ожидает доступа',
  waiting_parts: 'Ожидает запчастей',
  completed_by_engineer: 'Передана на проверку',
  verification: 'На проверке',
  rework: 'На доработке',
  closed: 'Закрыта',
  cancelled: 'Отменена',
}

const MUTATION_LABELS: Record<OfflineMutationStatus, string> = {
  pending: 'Ожидает синхронизации',
  syncing: 'Синхронизируется',
  synced: 'Синхронизировано',
  conflict: 'Нужно разрешить конфликт',
  access_expired: 'Доступ истёк',
  failed: 'Ошибка синхронизации',
}

const EQUIPMENT_STATUS_LABELS: Record<Equipment['status'], string> = {
  operational: 'Исправно',
  attention: 'Требует внимания',
  fault: 'Неисправность',
  unknown: 'Нет данных',
}

const SENSOR_STATUS_LABELS: Record<Sensor['status'], string> = {
  normal: 'Норма',
  attention: 'Внимание',
  alarm: 'Тревога',
  offline: 'Нет связи',
}

function createIdempotencyKey(
  order: WorkOrder,
  action: string,
): string {
  return createClientId(`engineer:${order.id}:${order.version}:${action}`)
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Не ограничен'
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value))
}

function slaStageLabel(stage: NonNullable<WorkOrder['sla']>['currentStage']): string {
  return {
    acceptance: 'Принять до',
    arrival: 'Прибыть до',
    resolution: 'Завершить до',
    completed: 'SLA выполнен',
  }[stage]
}

function formatRemaining(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'Нет данных'
  const absolute = Math.abs(seconds)
  const hours = Math.floor(absolute / 3600)
  const minutes = Math.floor((absolute % 3600) / 60)
  const value = `${hours} ч ${minutes} мин`
  return seconds < 0 ? `Просрочено на ${value}` : `Осталось ${value}`
}

function statusTone(status: WorkOrder['status']): StatusTone {
  if (status === 'closed') return 'success'
  if (status === 'cancelled') return 'neutral'
  if (
    status === 'waiting_access' ||
    status === 'waiting_parts' ||
    status === 'rework' ||
    status === 'needs_clarification'
  ) {
    return 'warning'
  }
  if (status === 'completed_by_engineer' || status === 'verification') {
    return 'forecast'
  }
  return 'info'
}

function mutationTone(status: OfflineMutationStatus): StatusTone {
  if (status === 'synced') return 'success'
  if (status === 'conflict' || status === 'access_expired') return 'warning'
  if (status === 'failed') return 'critical'
  return 'info'
}

function isRepositoryError(error: unknown): error is RepositoryError {
  return (
    error instanceof RepositoryError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string')
  )
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Не удалось выполнить действие. Повтори попытку'
}

export function EngineerWorkspace({
  currentUser,
  repository,
  onInvalidateQueries,
  workOrderId,
  offlineService: injectedOfflineService,
  isOnline: controlledOnline,
  onOnlineChange,
}: EngineerWorkspaceProps) {
  const routeParams = useParams<{ workOrderId?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedWorkOrderId = workOrderId ?? routeParams.workOrderId
  const assignmentQuery = (searchParams.get('q') ?? '').trim().toLocaleLowerCase('ru-RU')
  const isSyncRoute = location.pathname.endsWith('/sync')
  const isResultRoute = location.pathname.endsWith('/result')
  const scenarioId = repository.getSnapshot().scenarioId
  const offlineService = useMemo(
    () =>
      injectedOfflineService ??
      new OfflineEngineerService({
        storageKey: `contour:offline:${scenarioId}:${currentUser.id}:v1`,
      }),
    [currentUser.id, injectedOfflineService, scenarioId],
  )

  const [assignments, setAssignments] = useState<WorkOrder[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(
    requestedWorkOrderId ?? null,
  )
  const [selectedOrder, setSelectedOrder] = useState<WorkOrder | null>(null)
  const [technicalContext, setTechnicalContext] =
    useState<EngineerTechnicalContext | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [orderLoading, setOrderLoading] = useState(false)
  const [contextLoading, setContextLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [localOnline, setLocalOnline] = useState(true)
  const online = controlledOnline ?? localOnline
  const setOnline = (value: boolean) => {
    if (controlledOnline === undefined) setLocalOnline(value)
    onOnlineChange?.(value)
  }
  const [wizardOpen, setWizardOpen] = useState(false)
  const [waitAction, setWaitAction] = useState<WaitingAction | null>(null)
  const [waitReason, setWaitReason] = useState('')
  const [declineOpen, setDeclineOpen] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [offlineMutations, setOfflineMutations] = useState<
    OfflineMutation<QueuedResultCommand>[]
  >([])
  const [offlinePackageReady, setOfflinePackageReady] = useState(false)
  const [offlinePackagePreparedAt, setOfflinePackagePreparedAt] = useState<string | null>(null)
  const [resultDraft, setResultDraft] = useState<ResultWizardDraft | null>(null)
  const [draftLoading, setDraftLoading] = useState(false)
  const selectedIdRef = useRef(selectedId)
  const commandKeyByIntentRef = useRef(new Map<string, string>())
  const offlineReloadSupported = typeof window === 'undefined' || window.isSecureContext

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    const nextId = requestedWorkOrderId ?? null
    queueMicrotask(() => {
      selectedIdRef.current = nextId
      setSelectedId(nextId)
      setSelectedOrder(null)
      setTechnicalContext(null)
      setOrderLoading(Boolean(nextId))
      setWizardOpen(false)
      setResultDraft(null)
      setDraftLoading(false)
    })
  }, [requestedWorkOrderId])

  useEffect(() => {
    if (isSyncRoute && !selectedId && assignments[0]) {
      queueMicrotask(() => setSelectedId(assignments[0]!.id))
    }
  }, [assignments, isSyncRoute, selectedId])

  const refreshAssignments = useCallback(async () => {
    if (currentUser.role !== 'engineer') {
      setOrdersLoading(false)
      return
    }
    try {
      const nextAssignments = await repository.listWorkOrders({
        assignedToCurrentUser: true,
      })
      setAssignments(nextAssignments)
      setError(null)
    } catch (nextError) {
      setError(messageFromError(nextError))
    } finally {
      setOrdersLoading(false)
    }
  }, [currentUser.role, repository])

  const refreshSelectedOrder = useCallback(async () => {
    if (!selectedId || currentUser.role !== 'engineer') {
      setSelectedOrder(null)
      setOrderLoading(false)
      return
    }
    const requestId = selectedId
    setOrderLoading(true)
    try {
      const nextOrder = await repository.getWorkOrder(requestId)
      if (selectedIdRef.current !== requestId) return
      if (
        nextOrder.accessGrant &&
        ['revoked', 'expired'].includes(nextOrder.accessGrant.status)
      ) {
        await offlineService.markGrantExpired(nextOrder.accessGrant.id)
        if (selectedIdRef.current !== requestId) return
        setOfflinePackageReady(false)
        setOfflinePackagePreparedAt(null)
        setTechnicalContext(null)
      }
      setSelectedOrder(nextOrder)
      setError(null)
    } catch (nextError) {
      if (selectedIdRef.current !== requestId) return
      if (
        isRepositoryError(nextError) &&
        (nextError.code === 'ACCESS_EXPIRED' || nextError.code === 'FORBIDDEN')
      ) {
        await offlineService.removePackage(requestId)
        if (selectedIdRef.current !== requestId) return
        setOfflinePackageReady(false)
        setOfflinePackagePreparedAt(null)
        setTechnicalContext(null)
      }
      setSelectedOrder(null)
      if (
        isRepositoryError(nextError) &&
        (nextError.code === 'ACCESS_EXPIRED' || nextError.code === 'FORBIDDEN')
      ) {
        setError('Временный доступ к заявке завершён')
      } else {
        setError(messageFromError(nextError))
      }
    } finally {
      if (selectedIdRef.current === requestId) setOrderLoading(false)
    }
  }, [currentUser.role, offlineService, repository, selectedId])

  const refreshOfflineState = useCallback(async () => {
    if (!selectedId) {
      setOfflineMutations([])
      setOfflinePackageReady(false)
      setOfflinePackagePreparedAt(null)
      return
    }
    const requestId = selectedId
    try {
      const [mutations, workPackage] = await Promise.all([
        offlineService.listMutations<QueuedResultCommand>({ workOrderId: requestId }),
        offlineService.getPackage(requestId),
      ])
      if (selectedIdRef.current !== requestId) return
      setOfflineMutations(mutations)
      setOfflinePackageReady(Boolean(workPackage))
      setOfflinePackagePreparedAt(workPackage?.preparedAt ?? null)
    } catch (nextError) {
      if (selectedIdRef.current === requestId) setError(messageFromError(nextError))
    }
  }, [offlineService, selectedId])

  useEffect(() => {
    void offlineService.initialize().then(refreshOfflineState).catch((nextError) => {
      setError(messageFromError(nextError))
    })
  }, [offlineService, refreshOfflineState])

  useEffect(() => {
    queueMicrotask(() => void refreshAssignments())
  }, [refreshAssignments])

  useEffect(() => {
    queueMicrotask(() => {
      void refreshSelectedOrder()
      void refreshOfflineState()
    })
  }, [refreshOfflineState, refreshSelectedOrder])

  const fetchOnlineContext = useCallback(
    async (order: WorkOrder): Promise<EngineerTechnicalContext> => {
      const facilityId = order.target.facilityId
      const [facility, hierarchy, equipment, sensors, risks, incidents, workOrders, auditEvents] = await Promise.all([
        repository.getFacility(facilityId),
        repository.getFacilityHierarchy(facilityId),
        repository.listEquipment(facilityId),
        repository.listSensors(facilityId),
        repository.listRisks({ facilityId }),
        repository.listIncidents(facilityId),
        repository.listWorkOrders({ facilityId }),
        repository.getAuditTimeline('facility', facilityId),
      ])
      return {
        workOrder: order,
        facility,
        hierarchy,
        equipment,
        sensors,
        risks,
        incidents,
        workOrders,
        auditEvents,
      }
    },
    [repository],
  )

  const refreshTechnicalContext = useCallback(async () => {
    if (!selectedOrder) {
      setTechnicalContext(null)
      return
    }
    const requestId = selectedOrder.id

    const grant = selectedOrder.accessGrant
    if (!grant || grant.status !== 'active') {
      setTechnicalContext(null)
      setContextError(null)
      return
    }

    setContextLoading(true)
    try {
      if (online) {
        const nextContext = await fetchOnlineContext(selectedOrder)
        if (selectedIdRef.current !== requestId) return
        setTechnicalContext(nextContext)
      } else {
        const workPackage =
          await offlineService.getPackage<EngineerTechnicalContext>(
            selectedOrder.id,
          )
        if (!workPackage) {
          if (selectedIdRef.current !== requestId) return
          setTechnicalContext(null)
          setContextError(
            'На устройстве нет действующего офлайн-пакета для этой заявки',
          )
          return
        }
        if (selectedIdRef.current !== requestId) return
        setTechnicalContext(workPackage.context)
      }
      setContextError(null)
    } catch (nextError) {
      if (selectedIdRef.current !== requestId) return
      setTechnicalContext(null)
      setContextError(messageFromError(nextError))
    } finally {
      if (selectedIdRef.current === requestId) setContextLoading(false)
    }
  }, [fetchOnlineContext, offlineService, online, selectedOrder])

  useEffect(() => {
    queueMicrotask(() => void refreshTechnicalContext())
  }, [refreshTechnicalContext])

  const invalidateAndRefresh = useCallback(async () => {
    await onInvalidateQueries?.()
    await Promise.all([refreshAssignments(), refreshSelectedOrder()])
  }, [onInvalidateQueries, refreshAssignments, refreshSelectedOrder])

  const baseCommand = (order: WorkOrder, action: string, payloadSignature = '') => {
    const intent = JSON.stringify([order.id, order.version, action, payloadSignature])
    let idempotencyKey = commandKeyByIntentRef.current.get(intent)
    if (!idempotencyKey) {
      idempotencyKey = createIdempotencyKey(order, action)
      commandKeyByIntentRef.current.set(intent, idempotencyKey)
    }
    return {
      expectedVersion: order.version,
      idempotencyKey,
      clientOccurredAt: repository.getSnapshot().demoClockIso,
    }
  }

  const runSimpleAction = async (action: SimpleEngineerAction) => {
    if (!selectedOrder || !online) return
    const actionOrder = selectedOrder
    setActionBusy(true)
    setError(null)
    setNotice(null)
    try {
      const command = {
        ...baseCommand(actionOrder, action),
        action,
        payload: {},
      } as WorkOrderActionCommand
      const response = await repository.performWorkOrderAction(
        actionOrder.id,
        command,
      )
      if (selectedIdRef.current !== actionOrder.id) {
        await onInvalidateQueries?.()
        await refreshAssignments()
        return
      }
      setSelectedOrder(response.workOrder)
      setNotice(
        action === 'accept'
          ? 'Назначение принято. Временный доступ к техконтексту активирован'
          : action === 'mark_en_route'
            ? 'Статус обновлён: ты в пути'
            : action === 'start_work'
              ? 'Работа начата'
              : 'Работа продолжена',
      )
      await invalidateAndRefresh()
    } catch (nextError) {
      if (selectedIdRef.current === actionOrder.id) setError(messageFromError(nextError))
    } finally {
      setActionBusy(false)
    }
  }

  const submitWaitingState = async () => {
    if (!selectedOrder || !waitAction || !online) return
    if (waitReason.trim().length < 3) {
      setError('Укажи причину ожидания минимум 3 символами')
      return
    }
    const actionOrder = selectedOrder
    const pendingWaitAction = waitAction
    setActionBusy(true)
    setError(null)
    try {
      const command = {
        ...baseCommand(actionOrder, pendingWaitAction, waitReason.trim()),
        action: pendingWaitAction,
        payload: { reason: waitReason.trim() },
      } as WorkOrderActionCommand
      const response = await repository.performWorkOrderAction(
        actionOrder.id,
        command,
      )
      if (selectedIdRef.current !== actionOrder.id) {
        await onInvalidateQueries?.()
        await refreshAssignments()
        return
      }
      setSelectedOrder(response.workOrder)
      setWaitAction(null)
      setWaitReason('')
      setNotice(
        pendingWaitAction === 'wait_access'
          ? 'Зафиксировано ожидание доступа'
          : 'Зафиксировано ожидание запчастей',
      )
      await invalidateAndRefresh()
    } catch (nextError) {
      if (selectedIdRef.current === actionOrder.id) setError(messageFromError(nextError))
    } finally {
      setActionBusy(false)
    }
  }

  const submitDecline = async () => {
    if (!selectedOrder || !online) return
    if (declineReason.trim().length < 5) {
      setError('Укажи причину отказа минимум 5 символами')
      return
    }
    const actionOrder = selectedOrder
    setActionBusy(true)
    setError(null)
    try {
      await repository.performWorkOrderAction(actionOrder.id, {
        ...baseCommand(actionOrder, 'decline', declineReason.trim()),
        action: 'decline',
        payload: { reason: declineReason.trim() },
      })
      if (selectedIdRef.current !== actionOrder.id) {
        await onInvalidateQueries?.()
        await refreshAssignments()
        return
      }
      setDeclineOpen(false)
      setDeclineReason('')
      selectedIdRef.current = null
      setSelectedId(null)
      setSelectedOrder(null)
      navigate('/my-work', { replace: true })
      setNotice('Отказ зарегистрирован. Заявка возвращена координатору')
      await invalidateAndRefresh()
    } catch (nextError) {
      if (selectedIdRef.current === actionOrder.id) setError(messageFromError(nextError))
    } finally {
      setActionBusy(false)
    }
  }

  const prepareOfflinePackage = async () => {
    if (!selectedOrder || !online) return
    const actionOrder = selectedOrder
    const grant = actionOrder.accessGrant
    if (!grant || grant.status !== 'active') {
      setError('Офлайн-пакет доступен после принятия назначения')
      return
    }
    setActionBusy(true)
    setError(null)
    try {
      const context =
        technicalContext ?? (await fetchOnlineContext(actionOrder))
      const demoNowIso = repository.getSnapshot().demoClockIso
      const wallNow = Date.now()
      const grantDeadlines = [grant.expiresAt, grant.offlineCacheExpiresAt]
        .filter((value): value is string => Boolean(value))
      const accessExpiresAt = calculateOfflineAccessExpiry(
        demoNowIso,
        grantDeadlines,
        wallNow,
      )
      const workPackage = await offlineService.preparePackage({
        workOrderId: actionOrder.id,
        engineerId: currentUser.id,
        grantId: grant.id,
        expectedVersion: actionOrder.version,
        preparedAt: new Date(wallNow).toISOString(),
        accessExpiresAt,
        context,
      })
      if (selectedIdRef.current !== actionOrder.id) return
      setOfflinePackageReady(true)
      setOfflinePackagePreparedAt(workPackage.preparedAt)
      setNotice('Офлайн-пакет подготовлен. Техконтекст доступен без сети')
      await refreshOfflineState()
    } catch (nextError) {
      if (selectedIdRef.current === actionOrder.id) setError(messageFromError(nextError))
    } finally {
      setActionBusy(false)
    }
  }

  const submitRepairResult = async (
    repairResult: Omit<RepairResult, 'completedAt' | 'author'>,
  ) => {
    if (!selectedOrder) return
    const actionOrder = selectedOrder
    setActionBusy(true)
    setError(null)
    setNotice(null)
    const command: QueuedResultCommand = {
      ...baseCommand(actionOrder, 'submit_result', JSON.stringify(repairResult)),
      action: 'submit_result',
      payload: { repairResult },
    }

    try {
      if (!online) {
        const workPackage = await offlineService.getPackage(actionOrder.id)
        if (!workPackage) {
          throw new Error(
            'Офлайн-пакет отсутствует или срок его действия истёк. Отчёт не отправлен',
          )
        }
        const queued = await offlineService.enqueue({
          idempotencyKey: command.idempotencyKey,
          kind: 'submit_engineer_result',
          workOrderId: actionOrder.id,
          engineerId: currentUser.id,
          grantId: workPackage.grantId,
          expectedVersion: actionOrder.version,
          payload: command,
        })
        if (selectedIdRef.current !== actionOrder.id) return
        if (queued.status === 'access_expired') {
          throw new Error('Временный доступ истёк. Черновик сохранён на устройстве')
        }
        await offlineService.removeDraft(actionOrder.id).catch(() => undefined)
        setResultDraft(null)
        setWizardOpen(false)
        navigate(`/my-work/${actionOrder.id}`, { replace: true })
        setNotice('Отчёт сохранён на устройстве и ожидает синхронизации')
        await refreshOfflineState()
        return
      }

      const response = await repository.performWorkOrderAction(
        actionOrder.id,
        command,
      )
      await offlineService.removeDraft(actionOrder.id).catch(() => undefined)
      if (selectedIdRef.current !== actionOrder.id) {
        await onInvalidateQueries?.()
        await refreshAssignments()
        return
      }
      setResultDraft(null)
      setSelectedOrder(response.workOrder)
      setWizardOpen(false)
      navigate(`/my-work/${actionOrder.id}`, { replace: true })
      setNotice('Отчёт передан диспетчеру на проверку')
      await invalidateAndRefresh()
    } catch (nextError) {
      if (selectedIdRef.current === actionOrder.id) setError(messageFromError(nextError))
    } finally {
      setActionBusy(false)
    }
  }

  const syncOfflineChanges = async () => {
    if (!online || !selectedOrder) return
    const syncOrderId = selectedOrder.id
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const summary = await offlineService.sync<QueuedResultCommand>(
        async ({ mutation }) => {
          try {
            const response = await repository.performWorkOrderAction(
              mutation.workOrderId,
              mutation.payload,
            )
            return {
              status: 'synced',
              remoteVersion: response.workOrder.version,
              receipt: { auditEventId: response.auditEventId },
            }
          } catch (nextError) {
            if (isRepositoryError(nextError)) {
              if (nextError.code === 'VERSION_CONFLICT') {
                return {
                  status: 'conflict',
                  message: nextError.message,
                  serverVersion: nextError.currentVersion,
                }
              }
              if (
                nextError.code === 'ACCESS_EXPIRED' ||
                nextError.code === 'FORBIDDEN' ||
                nextError.code === 'ASSIGNMENT_CHANGED'
              ) {
                return { status: 'access_expired', message: nextError.message }
              }
              return {
                status: 'failed',
                code: nextError.code,
                message: nextError.message,
                retryable: nextError.code === 'SOURCE_UNAVAILABLE',
              }
            }
            return {
              status: 'failed',
              message: messageFromError(nextError),
              retryable: true,
            }
          }
        },
        { workOrderId: syncOrderId },
      )
      if (selectedIdRef.current !== syncOrderId) return
      await refreshOfflineState()
      if (selectedIdRef.current !== syncOrderId) return
      if (summary.counts.conflict > 0) {
        setError('Заявка изменилась на сервере. Локальный отчёт сохранён')
      } else if (summary.counts.access_expired > 0) {
        setError('Доступ завершён. Локальный отчёт сохранён на устройстве')
      } else if (summary.counts.failed > 0) {
        setError('Не удалось синхронизировать отчёт. Данные не потеряны')
      } else if (summary.counts.synced > 0) {
        setNotice('Локальный отчёт синхронизирован и передан диспетчеру')
        await invalidateAndRefresh()
      }
    } catch (nextError) {
      if (selectedIdRef.current === syncOrderId) setError(messageFromError(nextError))
    } finally {
      setSyncing(false)
    }
  }

  const retryConflict = async (mutation: OfflineMutation<QueuedResultCommand>) => {
    if (
      !selectedOrder?.accessGrant ||
      selectedOrder.accessGrant.status !== 'active' ||
      !selectedOrder.allowedActions.includes('submit_result') ||
      !online
    ) return
    const retryOrder = selectedOrder
    try {
      const idempotencyKey = createIdempotencyKey(retryOrder, 'submit_result_conflict_retry')
      const updatedCommand: QueuedResultCommand = {
        ...mutation.payload,
        expectedVersion: retryOrder.version,
        idempotencyKey,
      }
      await offlineService.requeue(mutation.mutationId, {
        expectedVersion: retryOrder.version,
        grantId: retryOrder.accessGrant!.id,
        idempotencyKey,
        payload: updatedCommand,
      })
      if (selectedIdRef.current !== retryOrder.id) return
      await refreshOfflineState()
      if (selectedIdRef.current !== retryOrder.id) return
      await syncOfflineChanges()
    } catch (nextError) {
      if (selectedIdRef.current === retryOrder.id) setError(messageFromError(nextError))
    }
  }

  const saveResultDraft = useCallback(
    async (draft: ResultWizardDraft) => {
      await offlineService.saveDraft(draft.workOrderId, draft)
    },
    [offlineService],
  )

  const discardResultDraft = useCallback(
    async (workOrderIdToDiscard: string) => {
      await offlineService.removeDraft(workOrderIdToDiscard)
      setResultDraft(null)
    },
    [offlineService],
  )

  const activeMutations = offlineMutations.filter(
    (mutation) => mutation.status !== 'synced',
  )
  const canUseTechnicalContext = selectedOrder?.accessGrant?.status === 'active'
  const selectedOrderId = selectedOrder?.id ?? null
  const canSubmitSelectedResult = Boolean(
    selectedOrder?.allowedActions.includes('submit_result'),
  )
  const filteredAssignments = assignments.filter((order) =>
    !assignmentQuery ||
    [order.number, order.target.displayName, order.snapshot.facilityName]
      .join(' ')
      .toLocaleLowerCase('ru-RU')
      .includes(assignmentQuery),
  )

  useEffect(() => {
    let cancelled = false

    queueMicrotask(() => {
      if (cancelled) return
      if (!selectedOrderId) {
        setWizardOpen(false)
        setResultDraft(null)
        setDraftLoading(false)
        return
      }
      if (!isResultRoute) {
        setWizardOpen(false)
        setResultDraft(null)
        setDraftLoading(false)
        return
      }
      if (!canSubmitSelectedResult) {
        navigate(`/my-work/${selectedOrderId}`, { replace: true })
        return
      }

      setWizardOpen(false)
      setDraftLoading(true)
      void offlineService
        .getDraft<unknown>(selectedOrderId)
        .then(async (storedDraft) => {
          if (cancelled) return
          if (storedDraft && !isResultWizardDraft(storedDraft, selectedOrderId)) {
            await offlineService.removeDraft(selectedOrderId)
            if (cancelled) return
          }
          setResultDraft(
            isResultWizardDraft(storedDraft, selectedOrderId)
              ? storedDraft
              : null,
          )
          setWizardOpen(true)
        })
        .catch((nextError) => {
          if (cancelled) return
          setResultDraft(null)
          setWizardOpen(true)
          setError(`Не удалось восстановить локальный черновик: ${messageFromError(nextError)}`)
        })
        .finally(() => {
          if (!cancelled) setDraftLoading(false)
        })
    })

    return () => {
      cancelled = true
    }
  }, [
    canSubmitSelectedResult,
    isResultRoute,
    navigate,
    offlineService,
    selectedOrderId,
  ])

  useEffect(() => {
    if (!isSyncRoute || !selectedOrder) return
    requestAnimationFrame(() => document.getElementById('sync-title')?.scrollIntoView({ block: 'start' }))
  }, [isSyncRoute, selectedOrder])

  if (currentUser.role !== 'engineer') {
    return (
      <section className="engineer-shell page" aria-label="Рабочее место инженера">
        <InlineAlert tone="critical" title="Раздел доступен только инженеру">
          Текущий профиль не имеет права выполнять ремонтные работы
        </InlineAlert>
      </section>
    )
  }

  return (
    <section
      className="engineer-shell engineer-workspace page"
      data-has-selection={Boolean(selectedId)}
      aria-labelledby="engineer-workspace-title"
    >
      <header className="engineer-mobile-header">
        <div>
          <p className="engineer-eyebrow">Рабочее место</p>
          <h1 id="engineer-workspace-title">
            {isSyncRoute ? 'Синхронизация' : 'Мои работы'}
          </h1>
        </div>
        <DemoBadge compact />
      </header>

      <div className="connectivity-banner" data-offline={!online}>
        <div className="engineer-connectivity__copy">
          {online ? (
            <WifiHigh size={20} weight="bold" aria-hidden="true" />
          ) : (
            <WifiSlash size={20} weight="bold" aria-hidden="true" />
          )}
          <span>
            <strong>{online ? 'Сеть доступна' : 'Демо: без сети'}</strong>
            <small>
              {online
                ? 'Можно синхронизировать отчёты'
                : 'После сохранения отчёт останется на устройстве'}
            </small>
          </span>
        </div>
        <button
          type="button"
          className="engineer-network-switch"
          role="switch"
          aria-checked={online}
          aria-label={online ? 'Перейти в режим без сети' : 'Включить сеть'}
          onClick={() => {
            setOnline(!online)
            setNotice(null)
            setError(null)
          }}
        >
          <span aria-hidden="true" />
          {online ? 'Онлайн' : 'Офлайн'}
        </button>
      </div>

      {!offlineReloadSupported && (
        <InlineAlert tone="warning" title="Для полной офлайн-работы нужен HTTPS">
          В текущем небезопасном HTTP-контексте браузер не сможет открыть приложение после перезагрузки без сети
        </InlineAlert>
      )}

      <div className="engineer-layout">
        <aside className="engineer-assignment-pane" aria-label="Назначенные работы">
          <div className="engineer-pane-heading">
            <div>
              <h2>Назначения</h2>
              <p>{filteredAssignments.length} из {assignments.length} назначений</p>
            </div>
            <HardHat size={24} weight="duotone" aria-hidden="true" />
          </div>

          {ordersLoading ? (
            <div className="engineer-skeleton-list" aria-label="Загрузка назначений">
              <Skeleton variant="rectangle" height={124} />
              <Skeleton variant="rectangle" height={124} />
            </div>
          ) : filteredAssignments.length === 0 ? (
            <EmptyState
              icon={CheckCircle}
              title={assignmentQuery ? "Назначения не найдены" : "Новых назначений нет"}
              description={assignmentQuery ? "Измени запрос в верхней строке поиска" : "Когда координатор назначит работу, она появится здесь"}
              compact
            />
          ) : (
            <div className="engineer-assignment-list">
              {filteredAssignments.map((order) => (
                <button
                  key={order.id}
                  type="button"
                  className="engineer-assignment-card"
                  disabled={actionBusy || syncing}
                  aria-current={selectedId === order.id ? 'true' : undefined}
                  onClick={() => {
                    setError(null)
                    setNotice(null)
                    navigate(`/my-work/${order.id}`)
                  }}
                >
                  <span className="engineer-assignment-card__top">
                    <strong>{order.number}</strong>
                    <StatusBadge tone={statusTone(order.status)}>
                      {STATUS_LABELS[order.status]}
                    </StatusBadge>
                  </span>
                  <span className="engineer-assignment-card__target">
                    {order.target.displayName}
                  </span>
                  <span className="engineer-assignment-card__meta">
                    <MapPin size={16} aria-hidden="true" />
                    {order.snapshot.facilityName}
                  </span>
                  <span className="engineer-assignment-card__bottom">
                    <span>{order.finalPriority ?? 'Приоритет не указан'}</span>
                    <CaretRight size={18} weight="bold" aria-hidden="true" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="engineer-detail-pane" aria-label="Карточка работы">
          {!selectedId ? (
            <EmptyState
              icon={Wrench}
              title="Выбери назначение"
              description="Здесь появятся маршрут, техконтекст и действия по заявке"
            />
          ) : orderLoading ? (
            <div className="engineer-detail-loading" aria-label="Загрузка заявки">
              <Skeleton width="45%" />
              <Skeleton variant="rectangle" height={180} />
              <Skeleton variant="rectangle" height={220} />
            </div>
          ) : selectedOrder ? (
            <div className="engineer-detail-stack">
              <div className="engineer-detail-title">
                <button
                  type="button"
                  className="engineer-mobile-back"
                  onClick={() => navigate('/my-work')}
                >
                  <ArrowLeft size={20} weight="bold" aria-hidden="true" />
                  К назначениям
                </button>
                <div className="engineer-detail-title__row">
                  <div>
                    <p className="engineer-eyebrow">{selectedOrder.number}</p>
                    <h2>{selectedOrder.target.displayName}</h2>
                  </div>
                  <StatusBadge tone={statusTone(selectedOrder.status)}>
                    {STATUS_LABELS[selectedOrder.status]}
                  </StatusBadge>
                </div>
                <p className="engineer-detail-title__facility">
                  <Buildings size={18} aria-hidden="true" />
                  {selectedOrder.snapshot.facilityName}
                </p>
              </div>

              {error && (
                <InlineAlert
                  tone="critical"
                  title="Действие не выполнено"
                  onDismiss={() => setError(null)}
                >
                  {error}
                </InlineAlert>
              )}
              {notice && (
                <InlineAlert
                  tone="success"
                  title="Готово"
                  onDismiss={() => setNotice(null)}
                >
                  {notice}
                </InlineAlert>
              )}
              {isSyncRoute && activeMutations.length === 0 ? (
                <InlineAlert tone="info" title="Очередь синхронизации пуста">
                  Сохранённые без сети отчёты появятся здесь. Незавершённые черновики восстанавливаются в форме результата
                </InlineAlert>
              ) : null}

              <section className="surface engineer-summary" aria-labelledby="summary-title">
                <div className="surface__header">
                  <h3 id="summary-title">Задача</h3>
                  <span className="engineer-priority" data-priority={selectedOrder.finalPriority ?? 'none'}>
                    {selectedOrder.finalPriority ?? 'Без приоритета'}
                  </span>
                </div>
                <div className="surface__body">
                  <p className="engineer-description">{selectedOrder.description}</p>
                  <dl className="engineer-facts">
                    <div>
                      <dt>Симптомы</dt>
                      <dd>{selectedOrder.symptoms.join(', ') || 'Не указаны'}</dd>
                    </div>
                    <div>
                      <dt>Местоположение</dt>
                      <dd>{selectedOrder.target.locationSnapshot.text ?? selectedOrder.target.displayName}</dd>
                    </div>
                    <div>
                      <dt>{selectedOrder.sla ? slaStageLabel(selectedOrder.sla.currentStage) : 'SLA'}</dt>
                      <dd>{formatRemaining(selectedOrder.sla?.remainingSeconds)}</dd>
                    </div>
                    <div>
                      <dt>Рекомендация</dt>
                      <dd>{selectedOrder.systemRecommendation ?? 'Нет рекомендации'}</dd>
                    </div>
                  </dl>
                </div>
              </section>

              <section className="surface engineer-access" aria-labelledby="access-title">
                <div className="surface__header">
                  <div className="engineer-section-heading">
                    <ShieldCheck size={22} weight="duotone" aria-hidden="true" />
                    <h3 id="access-title">Временный доступ</h3>
                  </div>
                  <StatusBadge
                    tone={canUseTechnicalContext ? 'success' : 'neutral'}
                  >
                    {canUseTechnicalContext ? 'Активен' : 'Не активен'}
                  </StatusBadge>
                </div>
                <div className="surface__body engineer-access__body">
                  {selectedOrder.accessGrant ? (
                    <>
                      <div>
                        <span>Полный техконтекст объекта</span>
                        <strong>
                          до {formatDateTime(selectedOrder.accessGrant.expiresAt)}
                        </strong>
                      </div>
                      <div>
                        <span>Офлайн-копия</span>
                        <strong>
                          до {formatDateTime(selectedOrder.accessGrant.offlineCacheExpiresAt)}
                        </strong>
                      </div>
                    </>
                  ) : (
                    <p className="muted">Доступ будет выдан вместе с назначением</p>
                  )}
                </div>
              </section>

              <section className="surface engineer-offline" aria-labelledby="offline-title">
                <div className="surface__header">
                  <div className="engineer-section-heading">
                    <Database size={22} weight="duotone" aria-hidden="true" />
                    <h3 id="offline-title">Работа без сети</h3>
                  </div>
                  {offlinePackageReady && (
                    <StatusBadge tone="success">Пакет готов</StatusBadge>
                  )}
                </div>
                <div className="surface__body engineer-offline__body">
                  <p>
                    Сохрани карточку, оборудование и показания на устройстве перед спуском в коллектор
                  </p>
                  {offlinePackagePreparedAt ? (
                    <small>
                      Снимок подготовлен {formatDateTime(offlinePackagePreparedAt)} по времени устройства. Перед выходом без сети обнови его после изменения статуса заявки
                    </small>
                  ) : null}
                  <Button
                    variant={offlinePackageReady ? 'secondary' : 'primary'}
                    fullWidth
                    startIcon={
                      offlinePackageReady ? (
                        <CloudCheck size={20} aria-hidden="true" />
                      ) : (
                        <CloudArrowDown size={20} aria-hidden="true" />
                      )
                    }
                    disabled={!online || !canUseTechnicalContext}
                    loading={actionBusy}
                    onClick={prepareOfflinePackage}
                  >
                    {offlinePackageReady ? 'Обновить офлайн-пакет' : 'Подготовить офлайн-пакет'}
                  </Button>
                  {!canUseTechnicalContext && (
                    <small>Сначала прими назначение, чтобы активировать доступ</small>
                  )}
                </div>
              </section>

              {activeMutations.length > 0 && (
                <section className="surface engineer-sync" aria-labelledby="sync-title">
                  <div className="surface__header">
                    <div className="engineer-section-heading">
                      <CloudSlash size={22} weight="duotone" aria-hidden="true" />
                      <h3 id="sync-title">Локальные изменения</h3>
                    </div>
                    <span className="engineer-sync__count">{activeMutations.length}</span>
                  </div>
                  <div className="surface__body engineer-sync__body">
                    {activeMutations.map((mutation) => (
                      <div className="engineer-sync-item" key={mutation.mutationId}>
                        <div>
                          <StatusBadge tone={mutationTone(mutation.status)}>
                            {MUTATION_LABELS[mutation.status]}
                          </StatusBadge>
                          <small>
                            Отчёт сохранён {formatDateTime(mutation.createdAt)}
                          </small>
                          <small>
                            Диагноз: {mutation.payload.payload.repairResult.diagnosis}
                          </small>
                        </div>
                        {['conflict', 'access_expired'].includes(mutation.status) && online && (
                          <Button
                            variant="secondary"
                            disabled={
                              selectedOrder.accessGrant?.status !== 'active' ||
                              !selectedOrder.allowedActions.includes('submit_result')
                            }
                            onClick={() => void retryConflict(mutation)}
                          >
                            {mutation.status === 'access_expired'
                              ? 'Отправить после продления доступа'
                              : 'Повторить с новой версией'}
                          </Button>
                        )}
                      </div>
                    ))}
                    {online &&
                      activeMutations.some((mutation) =>
                        ['pending', 'failed'].includes(mutation.status),
                      ) && (
                        <Button
                          fullWidth
                          startIcon={
                            syncing ? (
                              <SpinnerGap className="ui-spin" size={20} aria-hidden="true" />
                            ) : (
                              <CloudCheck size={20} aria-hidden="true" />
                            )
                          }
                          disabled={syncing}
                          onClick={() => void syncOfflineChanges()}
                        >
                          Синхронизировать
                        </Button>
                      )}
                    {!online && (
                      <p className="engineer-sync__hint">
                        Включи сеть, когда выйдешь на связь. Отчёт останется на устройстве
                      </p>
                    )}
                  </div>
                </section>
              )}

              {waitAction && (
                <section className="surface engineer-wait-form" aria-labelledby="wait-title">
                  <div className="surface__header">
                    <h3 id="wait-title">
                      {waitAction === 'wait_access'
                        ? 'Ожидание доступа'
                        : 'Ожидание запчастей'}
                    </h3>
                  </div>
                  <div className="surface__body">
                    <div className="field">
                      <label htmlFor="engineer-wait-reason">Причина</label>
                      <textarea
                        id="engineer-wait-reason"
                        rows={3}
                        value={waitReason}
                        onChange={(event) => setWaitReason(event.target.value)}
                        placeholder="Что именно блокирует продолжение работ"
                      />
                    </div>
                    <div className="engineer-inline-actions">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setWaitAction(null)
                          setWaitReason('')
                        }}
                      >
                        Отмена
                      </Button>
                      <Button
                        onClick={() => void submitWaitingState()}
                        loading={actionBusy}
                      >
                        Зафиксировать
                      </Button>
                    </div>
                  </div>
                </section>
              )}

              {draftLoading && isResultRoute ? (
                <section className="surface engineer-result" role="status" aria-label="Загрузка черновика отчёта">
                  <div className="surface__header">
                    <h2>Восстанавливаем черновик</h2>
                  </div>
                  <div className="surface__body">
                    <Skeleton lines={3} />
                  </div>
                </section>
              ) : null}

              {wizardOpen && !draftLoading && (
                <ResultWizard
                  key={selectedOrder.id}
                  workOrder={selectedOrder}
                  submitting={actionBusy}
                  mode={online ? 'online' : 'offline'}
                  initialDraft={resultDraft}
                  onDraftChange={saveResultDraft}
                  onDiscardDraft={() => discardResultDraft(selectedOrder.id)}
                  onCancel={() => navigate(`/my-work/${selectedOrder.id}`, { replace: true })}
                  onSubmit={submitRepairResult}
                />
              )}

              {!wizardOpen && !draftLoading && (
                <section className="surface engineer-actions" aria-labelledby="actions-title">
                  <div className="surface__header">
                    <h3 id="actions-title">Следующий шаг</h3>
                  </div>
                  <div className="surface__body engineer-actions__body">
                    {!online && selectedOrder.status !== 'in_progress' && (
                      <InlineAlert tone="warning" title="Для смены статуса нужна сеть">
                        В офлайн-режиме можно заполнять отчёт по уже начатой работе
                      </InlineAlert>
                    )}

                    {selectedOrder.allowedActions.includes('accept') && (
                      <>
                        <Button
                          fullWidth
                          size="large"
                          startIcon={<SignIn size={21} aria-hidden="true" />}
                          disabled={!online}
                          loading={actionBusy}
                          onClick={() => void runSimpleAction('accept')}
                        >
                          Принять назначение
                        </Button>
                        <Button
                          fullWidth
                          variant="secondary"
                          disabled={!online}
                          onClick={() => setDeclineOpen(true)}
                        >
                          Отказаться от назначения
                        </Button>
                      </>
                    )}
                    {declineOpen && selectedOrder.allowedActions.includes('decline') && (
                      <div className="field">
                        <label htmlFor="decline-reason">Причина отказа</label>
                        <textarea
                          id="decline-reason"
                          value={declineReason}
                          onChange={(event) => setDeclineReason(event.target.value)}
                          placeholder="Например, отсутствует нужный допуск"
                        />
                        <div className="inline-actions">
                          <Button variant="secondary" onClick={() => setDeclineOpen(false)}>Отмена</Button>
                          <Button
                            variant="danger"
                            disabled={declineReason.trim().length < 5}
                            loading={actionBusy}
                            onClick={() => void submitDecline()}
                          >
                            Подтвердить отказ
                          </Button>
                        </div>
                      </div>
                    )}
                    {selectedOrder.allowedActions.includes('mark_en_route') && (
                      <Button
                        fullWidth
                        size="large"
                        startIcon={<Truck size={21} aria-hidden="true" />}
                        disabled={!online}
                        loading={actionBusy}
                        onClick={() => void runSimpleAction('mark_en_route')}
                      >
                        Выехать на объект
                      </Button>
                    )}
                    {selectedOrder.allowedActions.includes('start_work') && (
                      <Button
                        fullWidth
                        size="large"
                        startIcon={<Play size={21} aria-hidden="true" />}
                        disabled={!online}
                        loading={actionBusy}
                        onClick={() => void runSimpleAction('start_work')}
                      >
                        Начать работу
                      </Button>
                    )}
                    {selectedOrder.allowedActions.includes('resume_work') && (
                      <Button
                        fullWidth
                        size="large"
                        startIcon={<Play size={21} aria-hidden="true" />}
                        disabled={!online}
                        loading={actionBusy}
                        onClick={() => void runSimpleAction('resume_work')}
                      >
                        Продолжить работу
                      </Button>
                    )}
                    {selectedOrder.allowedActions.includes('submit_result') && (
                      <>
                        <Button
                          fullWidth
                          size="large"
                          startIcon={<CheckCircle size={21} aria-hidden="true" />}
                          disabled={!online && !offlinePackageReady}
                          onClick={() => navigate(`/my-work/${selectedOrder.id}/result`)}
                        >
                          Оформить результат
                        </Button>
                        <div className="engineer-wait-actions">
                          <Button
                            variant="secondary"
                            startIcon={<Pause size={18} aria-hidden="true" />}
                            disabled={!online}
                            onClick={() => setWaitAction('wait_access')}
                          >
                            Нет доступа
                          </Button>
                          <Button
                            variant="secondary"
                            startIcon={<Package size={18} aria-hidden="true" />}
                            disabled={!online}
                            onClick={() => setWaitAction('wait_parts')}
                          >
                            Нужны запчасти
                          </Button>
                        </div>
                      </>
                    )}
                    {selectedOrder.status === 'completed_by_engineer' && (
                      <InlineAlert tone="success" title="Работа выполнена">
                        Отчёт передан диспетчеру. Он проверит результат и закроет заявку или вернёт её на доработку
                      </InlineAlert>
                    )}
                    {selectedOrder.status === 'closed' && (
                      <InlineAlert tone="success" title="Заявка закрыта">
                        Временный доступ к объекту завершён
                      </InlineAlert>
                    )}
                  </div>
                </section>
              )}

              <section className="surface engineer-context" aria-labelledby="context-title">
                <div className="surface__header">
                  <div className="engineer-section-heading">
                    <Wrench size={22} weight="duotone" aria-hidden="true" />
                    <h3 id="context-title">Технический контекст</h3>
                  </div>
                  {!online && <StatusBadge tone="warning">Офлайн-копия</StatusBadge>}
                </div>
                <div className="surface__body">
                  {!canUseTechnicalContext ? (
                    <EmptyState
                      icon={ShieldCheck}
                      title="Контекст откроется после принятия"
                      description="До принятия назначения доступны только сведения из заявки"
                      compact
                    />
                  ) : contextLoading ? (
                    <div className="engineer-context-loading">
                      <Skeleton lines={3} />
                      <Skeleton variant="rectangle" height={108} />
                    </div>
                  ) : contextError ? (
                    <InlineAlert tone="warning" title="Техконтекст недоступен">
                      {contextError}
                    </InlineAlert>
                  ) : technicalContext ? (
                    <div className="engineer-context-content">
                      <div className="engineer-context-address">
                        <MapPin size={20} weight="duotone" aria-hidden="true" />
                        <div>
                          <strong>{technicalContext.facility.name}</strong>
                          <span>{technicalContext.facility.address}</span>
                        </div>
                      </div>

                      <details open>
                        <summary>
                          Оборудование
                          <span>{technicalContext.equipment.length}</span>
                        </summary>
                        <div className="engineer-technical-list">
                          {technicalContext.equipment.map((item) => (
                            <div key={item.id} className="engineer-technical-item">
                              <div>
                                <strong>{item.name}</strong>
                                <span>{item.model ?? 'Модель не указана'}</span>
                              </div>
                              <StatusBadge
                                tone={item.status === 'fault' ? 'critical' : item.status === 'operational' ? 'success' : 'warning'}
                              >
                                {EQUIPMENT_STATUS_LABELS[item.status]}
                              </StatusBadge>
                            </div>
                          ))}
                        </div>
                      </details>

                      <details open>
                        <summary>
                          Датчики
                          <span>{technicalContext.sensors.length}</span>
                        </summary>
                        <div className="engineer-technical-list">
                          {technicalContext.sensors.map((sensor) => (
                            <div key={sensor.id} className="engineer-technical-item">
                              <div>
                                <strong>{sensor.name}</strong>
                                <span>
                                  {sensor.lastReading
                                    ? `${sensor.lastReading.value} ${sensor.unit}, ${formatDateTime(sensor.lastReading.at)}`
                                    : 'Последнее значение отсутствует'}
                                </span>
                              </div>
                              <StatusBadge
                                tone={sensor.status === 'alarm' ? 'critical' : sensor.status === 'normal' ? 'success' : 'warning'}
                              >
                                {SENSOR_STATUS_LABELS[sensor.status]}
                              </StatusBadge>
                            </div>
                          ))}
                        </div>
                      </details>

                      <details open>
                        <summary>
                          Инциденты и прогнозы
                          <span>{technicalContext.incidents.length + technicalContext.risks.length}</span>
                        </summary>
                        <div className="engineer-technical-list">
                          {technicalContext.incidents.map((incident) => (
                            <div key={incident.id} className="engineer-technical-item">
                              <div>
                                <strong>{incident.title}</strong>
                                <span>{incident.status === 'resolved' ? 'Разрешён' : 'Открыт'} · {formatDateTime(incident.confirmedAt)}</span>
                              </div>
                              <StatusBadge tone={incident.status === 'resolved' ? 'success' : incident.severity === 'critical' ? 'critical' : 'warning'}>
                                {incident.severity.toUpperCase()}
                              </StatusBadge>
                            </div>
                          ))}
                          {technicalContext.risks.map((risk) => (
                            <div key={risk.id} className="engineer-technical-item">
                              <div>
                                <strong>{risk.predictedEvent}</strong>
                                <span>{risk.recommendation}</span>
                              </div>
                              <StatusBadge tone={['resolved', 'rejected'].includes(risk.status) ? 'neutral' : 'forecast'}>
                                {Math.round(risk.probability * 100)}%
                              </StatusBadge>
                            </div>
                          ))}
                          {technicalContext.incidents.length + technicalContext.risks.length === 0 ? (
                            <p className="muted">Инцидентов и прогнозов по объекту нет</p>
                          ) : null}
                        </div>
                      </details>

                      <details open>
                        <summary>
                          История ремонтов
                          <span>{technicalContext.workOrders.length}</span>
                        </summary>
                        <div className="engineer-technical-list">
                          {technicalContext.workOrders.map((order) => (
                            <div key={order.id} className="engineer-technical-item">
                              <div>
                                <strong>{order.number} · {order.target.displayName}</strong>
                                <span>
                                  {order.repairResult?.diagnosis || order.description}
                                  {order.repairResult?.recommendations ? ` · Рекомендация: ${order.repairResult.recommendations}` : ''}
                                </span>
                              </div>
                              <StatusBadge tone={order.status === 'closed' ? 'success' : 'info'}>
                                {STATUS_LABELS[order.status]}
                              </StatusBadge>
                            </div>
                          ))}
                        </div>
                      </details>

                      <details>
                        <summary>
                          Журнал объекта
                          <span>{technicalContext.auditEvents.length}</span>
                        </summary>
                        <div className="engineer-technical-list">
                          {technicalContext.auditEvents.map((event) => (
                            <div key={event.id} className="engineer-technical-item">
                              <div>
                                <strong>{event.action}</strong>
                                <span>{event.actor.displayName} · {formatDateTime(event.occurredAt)}</span>
                              </div>
                            </div>
                          ))}
                          {technicalContext.auditEvents.length === 0 ? <p className="muted">Записей пока нет</p> : null}
                        </div>
                      </details>

                      <details>
                        <summary>
                          Структура объекта
                          <span>{technicalContext.hierarchy.length}</span>
                        </summary>
                        <ol className="engineer-hierarchy-list">
                          {technicalContext.hierarchy.map((node) => (
                            <li key={node.id}>
                              <span>{node.displayName}</span>
                              <small>{node.entityType}</small>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </div>
                  ) : null}
                </div>
              </section>

              <p className="provenance-note">
                <WarningCircle size={14} aria-hidden="true" />
                Синтетические демо-данные. Не использовать для реальных работ
              </p>
            </div>
          ) : (
            <div className="engineer-detail-stack">
              <EmptyState
                icon={WarningCircle}
                title="Заявка недоступна"
                description="Возможно, назначение изменено или временный доступ завершён"
                action={
                  <Button variant="secondary" onClick={() => navigate('/my-work')}>
                    Вернуться к списку
                  </Button>
                }
              />
              {activeMutations.length > 0 && (
                <InlineAlert
                  tone="warning"
                  title="Локальный отчёт сохранён"
                >
                  Доступ к объекту завершён, но введённые данные остались на устройстве. Их статус: {MUTATION_LABELS[activeMutations[0]!.status]}
                </InlineAlert>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="sr-only" aria-live="polite">
        {notice ?? (syncing ? 'Выполняется синхронизация' : '')}
      </div>
    </section>
  )
}
