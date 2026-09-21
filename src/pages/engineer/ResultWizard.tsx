import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  ClipboardText,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { RepairResult, WorkOrder } from '../../repositories'
import { Button } from '../../shared/ui/Button'
import { Progress } from '../../shared/ui/Progress'

type BooleanChoice = '' | 'yes' | 'no'

export interface ResultFormState {
  failureConfirmed: BooleanChoice
  rootCauseCode: string
  diagnosis: string
  actions: string
  parts: string
  laborMinutes: string
  equipmentRestored: BooleanChoice
  controlCheckResult: string
  residualRisk: '' | NonNullable<RepairResult['residualRisk']>
  recommendations: string
  requiresFollowUp: boolean
}

export interface ResultWizardDraft {
  schemaVersion: 1
  workOrderId: string
  updatedAt: string
  step: number
  form: ResultFormState
}

export interface ResultWizardProps {
  workOrder: WorkOrder
  submitting?: boolean
  mode: 'online' | 'offline'
  initialDraft?: ResultWizardDraft | null
  onDraftChange?: (draft: ResultWizardDraft) => Promise<void> | void
  onDiscardDraft?: () => Promise<void> | void
  onCancel: () => void
  onSubmit: (
    result: Omit<RepairResult, 'completedAt' | 'author'>,
  ) => Promise<void> | void
}

type DraftSaveState = 'idle' | 'saving' | 'saved' | 'error'

const STEP_LABELS = [
  'Диагностика',
  'Выполненные работы',
  'Контроль',
  'Проверка отчёта',
] as const

const RESIDUAL_RISK_LABELS: Record<NonNullable<RepairResult['residualRisk']>, string> = {
  none: 'Отсутствует',
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
}

function initialState(workOrder: WorkOrder): ResultFormState {
  const existing = workOrder.repairResult
  return {
    failureConfirmed:
      existing?.failureConfirmed === true
        ? 'yes'
        : existing?.failureConfirmed === false
          ? 'no'
          : '',
    rootCauseCode: existing?.rootCauseCode ?? '',
    diagnosis: existing?.diagnosis ?? '',
    actions: existing?.actions.join('\n') ?? '',
    parts:
      existing?.parts
        .map((part) => `${part.name} | ${part.quantity} | ${part.unit}`)
        .join('\n') ?? '',
    laborMinutes: existing?.laborMinutes?.toString() ?? '',
    equipmentRestored:
      existing?.equipmentRestored === true
        ? 'yes'
        : existing?.equipmentRestored === false
          ? 'no'
          : '',
    controlCheckResult: existing?.controlCheckResult ?? '',
    residualRisk: existing?.residualRisk ?? '',
    recommendations: existing?.recommendations ?? '',
    requiresFollowUp: existing?.requiresFollowUp ?? false,
  }
}

export function isResultWizardDraft(
  value: unknown,
  workOrderId?: string,
): value is ResultWizardDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Partial<ResultWizardDraft>
  const form = draft.form as Partial<ResultFormState> | undefined
  return (
    draft.schemaVersion === 1 &&
    typeof draft.workOrderId === 'string' &&
    (!workOrderId || draft.workOrderId === workOrderId) &&
    typeof draft.updatedAt === 'string' &&
    Number.isFinite(Date.parse(draft.updatedAt)) &&
    typeof draft.step === 'number' &&
    Number.isInteger(draft.step) &&
    draft.step >= 0 &&
    draft.step < STEP_LABELS.length &&
    Boolean(form) &&
    ['', 'yes', 'no'].includes(String(form?.failureConfirmed)) &&
    typeof form?.rootCauseCode === 'string' &&
    typeof form?.diagnosis === 'string' &&
    typeof form?.actions === 'string' &&
    typeof form?.parts === 'string' &&
    typeof form?.laborMinutes === 'string' &&
    ['', 'yes', 'no'].includes(String(form?.equipmentRestored)) &&
    typeof form?.controlCheckResult === 'string' &&
    ['', 'none', 'low', 'medium', 'high'].includes(String(form?.residualRisk)) &&
    typeof form?.recommendations === 'string' &&
    typeof form?.requiresFollowUp === 'boolean'
  )
}

function parseParts(value: string): RepairResult['parts'] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [rawName, rawQuantity, rawUnit] = line
        .split('|')
        .map((item) => item.trim())
      const quantity = Number(rawQuantity)
      return {
        partCode: `manual-${index + 1}`,
        name: rawName || `Запчасть ${index + 1}`,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0,
        unit: rawUnit || 'шт.',
      }
    })
}

function splitActions(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function ResultWizard({
  workOrder,
  submitting = false,
  mode,
  initialDraft = null,
  onDraftChange,
  onDiscardDraft,
  onCancel,
  onSubmit,
}: ResultWizardProps) {
  const restoredDraft = isResultWizardDraft(initialDraft, workOrder.id)
    ? initialDraft
    : null
  const [step, setStep] = useState(() => restoredDraft?.step ?? 0)
  const [form, setForm] = useState<ResultFormState>(() =>
    restoredDraft?.form ?? initialState(workOrder),
  )
  const [errors, setErrors] = useState<string[]>([])
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>('idle')
  const [draftRestored, setDraftRestored] = useState(Boolean(restoredDraft))
  const [discardingDraft, setDiscardingDraft] = useState(false)
  const errorSummaryRef = useRef<HTMLDivElement>(null)
  const draftTouchedRef = useRef(Boolean(restoredDraft))
  const draftSaveRevisionRef = useRef(0)

  useEffect(() => {
    if (!onDraftChange || !draftTouchedRef.current) return

    const revision = ++draftSaveRevisionRef.current
    const timeoutId = window.setTimeout(() => {
      setDraftSaveState('saving')
      const draft: ResultWizardDraft = {
        schemaVersion: 1,
        workOrderId: workOrder.id,
        updatedAt: new Date().toISOString(),
        step,
        form,
      }
      void Promise.resolve(onDraftChange(draft))
        .then(() => {
          if (draftSaveRevisionRef.current === revision) {
            setDraftSaveState('saved')
          }
        })
        .catch(() => {
          if (draftSaveRevisionRef.current === revision) {
            setDraftSaveState('error')
          }
        })
    }, 350)

    return () => window.clearTimeout(timeoutId)
  }, [form, onDraftChange, step, workOrder.id])

  const result = useMemo<Omit<RepairResult, 'completedAt' | 'author'>>(
    () => ({
      failureConfirmed:
        form.failureConfirmed === ''
          ? null
          : form.failureConfirmed === 'yes',
      rootCauseCode: form.rootCauseCode || null,
      diagnosis: form.diagnosis.trim(),
      actions: splitActions(form.actions),
      parts: parseParts(form.parts),
      laborMinutes: form.laborMinutes ? Number(form.laborMinutes) : null,
      equipmentRestored:
        form.equipmentRestored === ''
          ? null
          : form.equipmentRestored === 'yes',
      controlCheckResult: form.controlCheckResult.trim() || null,
      residualRisk: form.residualRisk || null,
      recommendations: form.recommendations.trim(),
      requiresFollowUp: form.requiresFollowUp,
    }),
    [form],
  )

  const update = <Key extends keyof ResultFormState>(
    key: Key,
    value: ResultFormState[Key],
  ) => {
    draftTouchedRef.current = true
    setForm((current) => ({ ...current, [key]: value }))
  }

  const discardDraft = async () => {
    setDiscardingDraft(true)
    try {
      await onDiscardDraft?.()
      draftSaveRevisionRef.current += 1
      draftTouchedRef.current = false
      setDraftRestored(false)
      setDraftSaveState('idle')
      setErrors([])
      setStep(0)
      setForm(initialState(workOrder))
    } catch {
      setDraftSaveState('error')
    } finally {
      setDiscardingDraft(false)
    }
  }

  const validateStep = (targetStep: number): string[] => {
    const nextErrors: string[] = []
    if (targetStep === 0) {
      if (!form.failureConfirmed) {
        nextErrors.push('Укажи, подтверждена ли неисправность')
      }
      if (form.diagnosis.trim().length < 5) {
        nextErrors.push('Опиши результат диагностики минимум 5 символами')
      }
    }
    if (targetStep === 1) {
      if (splitActions(form.actions).length === 0) {
        nextErrors.push('Добавь хотя бы одно выполненное действие')
      }
      const laborMinutes = Number(form.laborMinutes)
      if (!Number.isInteger(laborMinutes) || laborMinutes <= 0) {
        nextErrors.push('Укажи фактические трудозатраты целым числом минут')
      }
      const invalidPart = form.parts
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .some((line) => {
          const [name, rawQuantity] = line.split('|').map((item) => item.trim())
          const quantity = Number(rawQuantity)
          return !name || !Number.isFinite(quantity) || quantity <= 0
        })
      if (invalidPart) {
        nextErrors.push('Для каждой запчасти укажи название и количество больше нуля через символ |')
      }
    }
    if (targetStep === 2) {
      if (!form.equipmentRestored) {
        nextErrors.push('Укажи, восстановлена ли работоспособность')
      }
      if (form.controlCheckResult.trim().length < 3) {
        nextErrors.push('Зафиксируй результат контрольной проверки')
      }
      if (!form.residualRisk) {
        nextErrors.push('Оцени остаточный риск')
      }
    }
    return nextErrors
  }

  const showErrors = (nextErrors: string[]) => {
    setErrors(nextErrors)
    if (nextErrors.length > 0) {
      requestAnimationFrame(() => errorSummaryRef.current?.focus())
    }
  }

  const goNext = () => {
    const nextErrors = validateStep(step)
    showErrors(nextErrors)
    if (nextErrors.length === 0) {
      draftTouchedRef.current = true
      setStep((current) => Math.min(current + 1, STEP_LABELS.length - 1))
    }
  }

  const handleSubmit = async () => {
    for (const targetStep of [0, 1, 2]) {
      const stepErrors = validateStep(targetStep)
      if (stepErrors.length > 0) {
        setStep(targetStep)
        showErrors(stepErrors)
        return
      }
    }
    showErrors([])
    await onSubmit(result)
  }

  const hasError = (fragment: string) => errors.some((error) => error.includes(fragment))

  return (
    <section className="engineer-result surface" aria-labelledby="result-title">
      <div className="surface__header engineer-result__header">
        <div>
          <p className="engineer-eyebrow">Шаг {step + 1} из 4</p>
          <h2 id="result-title">Отчёт о выполнении</h2>
        </div>
        <span className="engineer-result__mode" data-offline={mode === 'offline'}>
          {mode === 'offline' ? 'Сохранится на устройстве' : 'Отправится диспетчеру'}
        </span>
      </div>

      <div className="surface__body engineer-result__body">
        {onDraftChange ? (
          <div
            className="engineer-draft-status"
            role={draftSaveState === 'error' ? 'alert' : 'status'}
          >
            <div>
              <strong>
                {draftSaveState === 'saving'
                  ? 'Сохраняем черновик'
                  : draftSaveState === 'error'
                    ? 'Черновик не сохранился'
                    : draftRestored
                      ? 'Черновик восстановлен'
                      : draftSaveState === 'saved'
                        ? 'Черновик сохранён'
                        : 'Автосохранение включено'}
              </strong>
              <span>
                {draftSaveState === 'error'
                  ? 'Не закрывай экран и повтори ввод после восстановления хранилища'
                  : 'Данные хранятся на этом устройстве до отправки отчёта'}
              </span>
            </div>
            {draftRestored ? (
              <Button
                variant="ghost"
                disabled={submitting || discardingDraft}
                onClick={() => void discardDraft()}
              >
                Начать заново
              </Button>
            ) : null}
          </div>
        ) : null}

        <Progress
          value={step + 1}
          max={STEP_LABELS.length}
          label={STEP_LABELS[step]}
          valueLabel={`${step + 1} из ${STEP_LABELS.length}`}
          showValue
        />

        {errors.length > 0 && (
          <div
            ref={errorSummaryRef}
            className="error-summary"
            role="alert"
            tabIndex={-1}
          >
            <strong>Проверь данные</strong>
            <ul>
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {step === 0 && (
          <div className="engineer-result__step">
            <fieldset className="engineer-choice-group" aria-invalid={hasError('подтверждена ли неисправность')} aria-describedby={hasError('подтверждена ли неисправность') ? 'failure-confirmed-error' : undefined}>
              <legend>Неисправность подтверждена</legend>
              <div className="engineer-choice-grid">
                <label>
                  <input
                    type="radio"
                    name="failureConfirmed"
                    value="yes"
                    checked={form.failureConfirmed === 'yes'}
                    onChange={() => update('failureConfirmed', 'yes')}
                  />
                  <span>Да</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="failureConfirmed"
                    value="no"
                    checked={form.failureConfirmed === 'no'}
                    onChange={() => update('failureConfirmed', 'no')}
                  />
                  <span>Нет</span>
                </label>
              </div>
              {hasError('подтверждена ли неисправность') ? <p className="field__error" id="failure-confirmed-error">Выбери один вариант</p> : null}
            </fieldset>

            <div className="field">
              <label htmlFor="engineer-root-cause">Предварительная причина</label>
              <select
                id="engineer-root-cause"
                value={form.rootCauseCode}
                onChange={(event) => update('rootCauseCode', event.target.value)}
              >
                <option value="">Не определена</option>
                <option value="contact_failure">Нарушение контакта</option>
                <option value="wear">Износ оборудования</option>
                <option value="contamination">Загрязнение</option>
                <option value="power_supply">Питание или электрика</option>
                <option value="other">Другая причина</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="engineer-diagnosis">Результат диагностики</label>
              <textarea
                id="engineer-diagnosis"
                rows={5}
                value={form.diagnosis}
                aria-invalid={hasError('результат диагностики')}
                aria-describedby={hasError('результат диагностики') ? 'engineer-diagnosis-error' : undefined}
                onChange={(event) => update('diagnosis', event.target.value)}
                placeholder="Что обнаружено при осмотре и проверке"
              />
              {hasError('результат диагностики') ? <p className="field__error" id="engineer-diagnosis-error">Минимум 5 символов</p> : null}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="engineer-result__step">
            <div className="field">
              <label htmlFor="engineer-actions">Выполненные действия</label>
              <textarea
                id="engineer-actions"
                rows={5}
                value={form.actions}
                aria-invalid={hasError('выполненное действие')}
                aria-describedby={hasError('выполненное действие') ? 'engineer-actions-error' : 'engineer-actions-hint'}
                onChange={(event) => update('actions', event.target.value)}
                placeholder={'Каждое действие с новой строки\nЗаменён контактный модуль'}
              />
              <span className="field__hint" id="engineer-actions-hint">Одно действие на строку</span>
              {hasError('выполненное действие') ? <p className="field__error" id="engineer-actions-error">Добавь хотя бы одно действие</p> : null}
            </div>

            <div className="field">
              <label htmlFor="engineer-labor">Трудозатраты, минут</label>
              <input
                id="engineer-labor"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                value={form.laborMinutes}
                aria-invalid={hasError('трудозатраты')}
                aria-describedby={hasError('трудозатраты') ? 'engineer-labor-error' : undefined}
                onChange={(event) => update('laborMinutes', event.target.value)}
              />
              {hasError('трудозатраты') ? <p className="field__error" id="engineer-labor-error">Укажи целое число больше нуля</p> : null}
            </div>

            <div className="field">
              <label htmlFor="engineer-parts">Использованные запчасти</label>
              <textarea
                id="engineer-parts"
                rows={4}
                value={form.parts}
                aria-invalid={hasError('каждой запчасти')}
                aria-describedby={hasError('каждой запчасти') ? 'engineer-parts-error' : 'engineer-parts-hint'}
                onChange={(event) => update('parts', event.target.value)}
                placeholder={'Название | количество | единица\nКонтактный модуль | 1 | шт.'}
              />
              <span className="field__hint" id="engineer-parts-hint">Необязательно, одна позиция на строку</span>
              {hasError('каждой запчасти') ? <p className="field__error" id="engineer-parts-error">Формат: название | количество | единица</p> : null}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="engineer-result__step">
            <fieldset className="engineer-choice-group" aria-invalid={hasError('восстановлена ли работоспособность')} aria-describedby={hasError('восстановлена ли работоспособность') ? 'equipment-restored-error' : undefined}>
              <legend>Работоспособность восстановлена</legend>
              <div className="engineer-choice-grid">
                <label>
                  <input
                    type="radio"
                    name="equipmentRestored"
                    value="yes"
                    checked={form.equipmentRestored === 'yes'}
                    onChange={() => update('equipmentRestored', 'yes')}
                  />
                  <span>Да</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="equipmentRestored"
                    value="no"
                    checked={form.equipmentRestored === 'no'}
                    onChange={() => update('equipmentRestored', 'no')}
                  />
                  <span>Нет</span>
                </label>
              </div>
              {hasError('восстановлена ли работоспособность') ? <p className="field__error" id="equipment-restored-error">Выбери один вариант</p> : null}
            </fieldset>

            <div className="field">
              <label htmlFor="engineer-control-check">Контрольная проверка</label>
              <textarea
                id="engineer-control-check"
                rows={4}
                value={form.controlCheckResult}
                aria-invalid={hasError('результат контрольной проверки')}
                aria-describedby={hasError('результат контрольной проверки') ? 'engineer-control-error' : undefined}
                onChange={(event) =>
                  update('controlCheckResult', event.target.value)
                }
                placeholder="Какие показатели проверены и каков результат"
              />
              {hasError('результат контрольной проверки') ? <p className="field__error" id="engineer-control-error">Минимум 3 символа</p> : null}
            </div>

            <div className="field">
              <label htmlFor="engineer-residual-risk">Остаточный риск</label>
              <select
                id="engineer-residual-risk"
                value={form.residualRisk}
                aria-invalid={hasError('остаточный риск')}
                aria-describedby={hasError('остаточный риск') ? 'engineer-risk-error' : undefined}
                onChange={(event) =>
                  update(
                    'residualRisk',
                    event.target.value as ResultFormState['residualRisk'],
                  )
                }
              >
                <option value="">Выбери уровень</option>
                <option value="none">Отсутствует</option>
                <option value="low">Низкий</option>
                <option value="medium">Средний</option>
                <option value="high">Высокий</option>
              </select>
              {hasError('остаточный риск') ? <p className="field__error" id="engineer-risk-error">Выбери уровень риска</p> : null}
            </div>

            <div className="field">
              <label htmlFor="engineer-recommendations">Рекомендации</label>
              <textarea
                id="engineer-recommendations"
                rows={4}
                value={form.recommendations}
                onChange={(event) => update('recommendations', event.target.value)}
                placeholder="Что проверить при следующем обслуживании"
              />
            </div>

            <label className="engineer-checkbox">
              <input
                type="checkbox"
                checked={form.requiresFollowUp}
                onChange={(event) =>
                  update('requiresFollowUp', event.target.checked)
                }
              />
              <span>Требуется повторный выезд или наблюдение</span>
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="engineer-result__step">
            <div className="engineer-review-card">
              <ClipboardText size={24} weight="duotone" aria-hidden="true" />
              <div>
                <strong>{workOrder.number}</strong>
                <span>{workOrder.target.displayName}</span>
              </div>
            </div>
            <dl className="engineer-review-list">
              <div>
                <dt>Диагноз</dt>
                <dd>{result.diagnosis}</dd>
              </div>
              <div>
                <dt>Выполнено</dt>
                <dd>{result.actions.join(', ')}</dd>
              </div>
              <div>
                <dt>Трудозатраты</dt>
                <dd>{result.laborMinutes} мин.</dd>
              </div>
              <div>
                <dt>Работоспособность</dt>
                <dd>{result.equipmentRestored ? 'Восстановлена' : 'Не восстановлена'}</dd>
              </div>
              <div>
                <dt>Остаточный риск</dt>
                <dd>
                  {result.residualRisk
                    ? RESIDUAL_RISK_LABELS[result.residualRisk]
                    : 'Не указан'}
                </dd>
              </div>
            </dl>
            <div className="engineer-submit-note" data-offline={mode === 'offline'}>
              {mode === 'offline'
                ? 'Нажми «Сохранить отчёт», прежде чем закрывать приложение. После сохранения отчёт останется на устройстве до безопасной синхронизации'
                : 'После отправки диспетчер получит отчёт для проверки. Самостоятельно закрыть заявку инженер не может'}
            </div>
          </div>
        )}

        <div className="engineer-result__footer">
          {step === 0 ? (
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Отмена
            </Button>
          ) : (
            <Button
              variant="secondary"
              startIcon={<ArrowLeft size={18} aria-hidden="true" />}
              onClick={() => {
                draftTouchedRef.current = true
                setErrors([])
                setStep((current) => current - 1)
              }}
              disabled={submitting}
            >
              Назад
            </Button>
          )}

          {step < STEP_LABELS.length - 1 ? (
            <Button
              endIcon={<ArrowRight size={18} aria-hidden="true" />}
              onClick={goNext}
            >
              Далее
            </Button>
          ) : (
            <Button
              startIcon={<CheckCircle size={19} weight="bold" aria-hidden="true" />}
              onClick={handleSubmit}
              loading={submitting}
            >
              {mode === 'offline' ? 'Сохранить отчёт' : 'Передать на проверку'}
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
