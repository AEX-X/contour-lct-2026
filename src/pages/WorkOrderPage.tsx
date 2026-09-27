import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  LockKeyOpen,
  Repeat,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { WorkOrderAction } from "../domain";
import { Button, InlineAlert, Modal, StatusBadge } from "../shared/ui";
import { useAuditTimeline, useFacility, useWorkOrder } from "../app/dataHooks";
import { useContour, useRepositoryCommandMeta } from "../app/ContourProvider";
import {
  actionLabels,
  formatDateTime,
  priorityLabels,
  statusLabels,
} from "../app/labels";
import { PageError, PageLoading } from "../components/StateViews";
import { WorkOrderTimeline } from "../components/WorkOrderTimeline";

type DialogAction = "return_for_rework" | "close" | "cancel" | "resubmit_clarification" | "override" | null;

export function WorkOrderPage() {
  const { workOrderId } = useParams();
  const navigate = useNavigate();
  const { repository, runtime, currentUser, profiles, invalidateAll } = useContour();
  const commandMeta = useRepositoryCommandMeta();
  const orderQuery = useWorkOrder(workOrderId);
  const facilityQuery = useFacility(orderQuery.data?.target.facilityId);
  const auditQuery = useAuditTimeline("work_order", workOrderId);
  const [dialogAction, setDialogAction] = useState<DialogAction>(null);
  const [comment, setComment] = useState("");
  const [equipmentOperational, setEquipmentOperational] = useState<boolean | null>(null);

  const openDialog = (action: Exclude<DialogAction, null>) => {
    setComment("");
    setEquipmentOperational(null);
    setDialogAction(action);
  };

  const actionMutation = useMutation({
    mutationFn: async (action: Exclude<WorkOrderAction, "edit" | "finalize_priority" | "assign" | "reassign" | "accept" | "decline" | "mark_en_route" | "start_work" | "wait_access" | "wait_parts" | "resume_work" | "submit_result">) => {
      const order = orderQuery.data;
      if (!order) throw new Error("Заявка не загружена");
      if (action === "start_triage") {
        return repository.performWorkOrderAction(order.id, {
          action,
          ...commandMeta(order.version, `${order.id}:${order.version}:start_triage`),
          payload: { comment: "Триаж начат из карточки заявки" },
        });
      }
      if (action === "request_clarification") {
        return repository.performWorkOrderAction(order.id, {
          action,
          ...commandMeta(order.version, JSON.stringify([order.id, order.version, action, comment])),
          payload: { reason: comment },
        });
      }
      if (action === "resubmit_clarification") {
        return repository.performWorkOrderAction(order.id, {
          action,
          ...commandMeta(order.version, JSON.stringify([order.id, order.version, action, comment])),
          payload: { comment },
        });
      }
      if (action === "start_verification") {
        return repository.performWorkOrderAction(order.id, {
          action,
          ...commandMeta(order.version, `${order.id}:${order.version}:start_verification`),
          payload: { comment: "Проверка результата начата" },
        });
      }
      if (action === "return_for_rework") {
        return repository.performWorkOrderAction(order.id, {
          action,
          ...commandMeta(order.version, JSON.stringify([order.id, order.version, action, comment])),
          payload: { reason: comment, expectedChanges: ["Устранить замечание диспетчера", "Повторить контрольную проверку"] },
        });
      }
      if (action === "close") {
        return repository.performWorkOrderAction(order.id, {
          action,
          ...commandMeta(order.version, JSON.stringify([order.id, order.version, action, equipmentOperational, comment])),
          payload: { equipmentOperational: equipmentOperational === true, comment },
        });
      }
      if (action === "cancel") {
        return repository.performWorkOrderAction(order.id, {
          action,
          ...commandMeta(order.version, JSON.stringify([order.id, order.version, action, comment])),
          payload: { reason: comment },
        });
      }
      return repository.performWorkOrderAction(order.id, {
        action: "override",
        ...commandMeta(order.version, JSON.stringify([order.id, order.version, "override", comment])),
        payload: { reason: comment, note: "Управленческое решение зарегистрировано отдельно" },
      });
    },
    onSuccess: async (_response, action) => {
      await invalidateAll();
      setDialogAction(null);
      setComment("");
      if (action === "close") {
        navigate(`/work-orders/${workOrderId}`, { replace: true });
      }
    },
  });

  if (orderQuery.isPending || auditQuery.isPending) {
    return <PageLoading label="Загружаем карточку заявки" />;
  }
  if (orderQuery.isError || auditQuery.isError) {
    return (
      <PageError
        title="Заявка недоступна"
        message="У текущей роли нет доступа, либо заявка была изменена"
        onRetry={() => void Promise.all([orderQuery.refetch(), auditQuery.refetch()])}
      />
    );
  }

  const order = orderQuery.data;
  const facility = facilityQuery.data;
  const assignedEngineer = profiles.find(
    (profile) => profile.id === order.currentAssignment?.engineerId,
  );
  const dialogTitle = dialogAction
    ? {
        return_for_rework: "Вернуть инженеру на доработку",
        close: "Принять работу и закрыть заявку",
        cancel: "Отменить заявку",
        resubmit_clarification: "Дополнить и отправить заявку повторно",
        override: "Зафиксировать управленческое решение",
      }[dialogAction]
    : "";

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link className="back-link" to={backRoute(currentUser.role)}>
            <ArrowLeft size={16} />
            Назад к очереди
          </Link>
          <div className="inline-actions">
            <h1>{order.number}</h1>
            <StatusBadge tone={orderTone(order.status)}>{statusLabels[order.status]}</StatusBadge>
          </div>
          <p className="page-header__meta">
            {order.target.displayName} · {order.snapshot.facilityName}
          </p>
        </div>
        <div className="page-actions">
          {order.finalPriority || order.preliminaryPriority ? (
            <StatusBadge tone={order.finalPriority === "P1" ? "critical" : "warning"}>
              {priorityLabels[order.finalPriority ?? order.preliminaryPriority!]}
            </StatusBadge>
          ) : null}
          {order.sla ? (
            <StatusBadge tone={order.sla.state === "breached" ? "critical" : "info"}>
              SLA: {slaLabel(order.sla.state)}
            </StatusBadge>
          ) : null}
        </div>
      </header>

      {order.status === "needs_clarification" ? (
        <InlineAlert
          tone="warning"
          title="Координатор запросил уточнение"
          action={
            order.allowedActions.includes("resubmit_clarification") ? (
              <Button variant="secondary" onClick={() => openDialog("resubmit_clarification")}>
                Дополнить заявку
              </Button>
            ) : undefined
          }
        >
          Дополни технический контекст, затем отправь заявку повторно
        </InlineAlert>
      ) : null}

      {actionMutation.isError ? (
        <InlineAlert tone="critical" title="Изменение не сохранено" style={{ marginTop: 12 }}>
          Заявка могла измениться в другой роли. Введённый комментарий сохранён, обнови данные и повтори действие
        </InlineAlert>
      ) : null}

      <div className="split-layout" style={{ marginTop: 16 }}>
        <div className="content-stack">
          <section className="surface">
            <header className="surface__header">
              <div>
                <h2>Содержание заявки</h2>
                <p className="page-header__meta">Точный объект работ и зафиксированный контекст</p>
              </div>
              <StatusBadge tone="neutral">Версия {order.version}</StatusBadge>
            </header>
            <div className="surface__body content-stack">
              <div className="target-summary target-summary--large">
                <WarningCircle size={24} aria-hidden="true" />
                <div>
                  <strong>{order.target.displayName}</strong>
                  <small>{order.target.hierarchyPath.map((item) => item.displayName).join(" / ")}</small>
                </div>
              </div>
              <dl className="definition-grid">
                <dt>Категория</dt>
                <dd>{categoryLabel(order.categoryCode)}</dd>
                <dt>Описание</dt>
                <dd>{order.description}</dd>
                <dt>Признаки</dt>
                <dd>{order.symptoms.join(", ") || "Не указаны"}</dd>
                <dt>Системная рекомендация</dt>
                <dd>{order.systemRecommendation ?? "Нет данных"}</dd>
                <dt>Создана</dt>
                <dd>{formatDateTime(order.createdAt)}</dd>
                <dt>Обновлена</dt>
                <dd>{formatDateTime(order.updatedAt)}</dd>
              </dl>
              <p className="provenance-note">Источник: синтетический демонстрационный сценарий Contour</p>
            </div>
          </section>

          {order.repairResult ? (
            <section className="surface">
              <header className="surface__header">
                <div>
                  <h2>Отчёт инженера</h2>
                  <p className="page-header__meta">Автор зафиксирован, электронная подпись в прототип не входит</p>
                </div>
                <StatusBadge tone={order.repairResult.equipmentRestored ? "success" : "warning"}>
                  {order.repairResult.equipmentRestored ? "Работоспособность восстановлена" : "Есть ограничения"}
                </StatusBadge>
              </header>
              <div className="surface__body">
                <dl className="definition-grid">
                  <dt>Диагноз</dt>
                  <dd>{order.repairResult.diagnosis}</dd>
                  <dt>Причина</dt>
                  <dd>{rootCauseLabel(order.repairResult.rootCauseCode)}</dd>
                  <dt>Выполнено</dt>
                  <dd>{order.repairResult.actions.join(", ")}</dd>
                  <dt>Трудозатраты</dt>
                  <dd>{order.repairResult.laborMinutes ?? 0} мин</dd>
                  <dt>Контрольная проверка</dt>
                  <dd>{order.repairResult.controlCheckResult ?? "Не указана"}</dd>
                  <dt>Рекомендации</dt>
                  <dd>{order.repairResult.recommendations || "Нет"}</dd>
                </dl>
              </div>
            </section>
          ) : null}

          <section className="surface">
            <header className="surface__header">
              <h2>История заявки</h2>
            </header>
            <div className="surface__body">
              <WorkOrderTimeline workOrder={order} events={auditQuery.data} />
            </div>
          </section>
        </div>

        <aside className="content-stack">
          <section className="surface">
            <header className="surface__header">
              <h2>Управление</h2>
            </header>
            <div className="surface__body content-stack">
              {order.allowedActions.includes("start_verification") ? (
                <Button
                  fullWidth
                  startIcon={<ShieldCheck size={18} />}
                  loading={actionMutation.isPending}
                  onClick={() => actionMutation.mutate("start_verification")}
                >
                  Начать проверку
                </Button>
              ) : null}
              {order.allowedActions.includes("close") ? (
                <Button
                  fullWidth
                  startIcon={<CheckCircle size={18} />}
                  onClick={() => openDialog("close")}
                >
                  Принять и закрыть
                </Button>
              ) : null}
              {order.allowedActions.includes("return_for_rework") ? (
                <Button
                  fullWidth
                  variant="secondary"
                  startIcon={<Repeat size={18} />}
                  onClick={() => openDialog("return_for_rework")}
                >
                  Вернуть на доработку
                </Button>
              ) : null}
              {order.allowedActions.includes("cancel") ? (
                <Button
                  fullWidth
                  variant="danger"
                  startIcon={<XCircle size={18} />}
                  onClick={() => openDialog("cancel")}
                >
                  Отменить заявку
                </Button>
              ) : null}
              {order.allowedActions.includes("override") ? (
                <Button
                  fullWidth
                  variant="secondary"
                  startIcon={<ShieldCheck size={18} />}
                  onClick={() => openDialog("override")}
                >
                  Управленческое решение
                </Button>
              ) : null}
              {!order.allowedActions.some((action) => ["start_verification", "close", "return_for_rework", "cancel", "override"].includes(action)) ? (
                <InlineAlert tone="info" title="Активных действий нет">
                  Следующий шаг выполняет другая роль согласно процессу
                </InlineAlert>
              ) : null}
              {runtime.mode === "mock" && order.status !== "closed" && ["maintenance_coordinator", "manager"].includes(currentUser.role) ? (
                <Link className="ui-button ui-button--secondary ui-button--medium ui-button--full-width" to={`/maintenance/queue?workOrder=${order.id}`}>
                  Открыть в ремонтной очереди
                  <ArrowRight size={18} />
                </Link>
              ) : null}
            </div>
          </section>

          <section className="surface">
            <header className="surface__header">
              <h2>SLA и ответственные</h2>
            </header>
            <div className="surface__body">
              <dl className="definition-grid">
                <dt>Создатель</dt>
                <dd>{order.creator.displayName}</dd>
                <dt>Координатор</dt>
                <dd>{order.coordinator?.displayName ?? "Не назначен"}</dd>
                <dt>Инженер</dt>
                <dd>
                  {assignedEngineer?.displayName ??
                    (order.currentAssignment ? "Назначенный инженер" : "Не назначен")}
                </dd>
                <dt>Принятие до</dt>
                <dd>{formatDateTime(order.sla?.acceptanceDueAt)}</dd>
                <dt>Прибытие до</dt>
                <dd>{formatDateTime(order.sla?.arrivalDueAt)}</dd>
                <dt>Устранение до</dt>
                <dd>{formatDateTime(order.sla?.resolutionDueAt)}</dd>
              </dl>
            </div>
          </section>

          <section className="surface">
            <header className="surface__header">
              <h2>Временный доступ</h2>
            </header>
            <div className="surface__body">
              {order.accessGrant?.status === "active" ? (
                <InlineAlert tone="success" title="Технический доступ активен" icon={LockKeyOpen}>
                  Инженер видит контекст объекта только в рамках этой заявки
                </InlineAlert>
              ) : order.accessGrant?.status === "scheduled" ? (
                <InlineAlert tone="info" title="Доступ подготовлен" icon={ShieldCheck}>
                  Доступ активируется после принятия назначения инженером
                </InlineAlert>
              ) : (
                <p className="muted">Активного инженерного доступа нет</p>
              )}
            </div>
          </section>

          {facility ? (
            <Link className="ui-button ui-button--secondary ui-button--medium ui-button--full-width" to={`/facilities/${facility.id}`}>
              Перейти к объекту
              <ArrowRight size={18} />
            </Link>
          ) : null}
        </aside>
      </div>

      <Modal
        open={Boolean(dialogAction)}
        onClose={() => setDialogAction(null)}
        title={dialogTitle}
        description="Решение будет добавлено в локальный журнал демо-заявки"
        footer={
          <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button variant="secondary" onClick={() => setDialogAction(null)}>
              Отмена
            </Button>
            <Button
              variant={dialogAction === "cancel" ? "danger" : "primary"}
              loading={actionMutation.isPending}
              disabled={comment.trim().length < 3 || (dialogAction === "close" && equipmentOperational !== true)}
              onClick={() => dialogAction && actionMutation.mutate(dialogAction)}
            >
              {dialogAction ? actionLabels[dialogAction] : "Подтвердить"}
            </Button>
          </div>
        }
      >
        {dialogAction === "override" ? (
          <InlineAlert tone="info" title="Действие сохраняет разделение ответственности">
            Решение руководителя попадёт в журнал заявки. Полевые этапы и отчёт о ремонте останутся за назначенным инженером
          </InlineAlert>
        ) : null}
        {dialogAction === "close" ? (
          <fieldset className="field">
            <legend>Результат контрольной проверки</legend>
            <label className="radio-row">
              <input type="radio" name="equipment-operational" checked={equipmentOperational === true} onChange={() => setEquipmentOperational(true)} />
              Оборудование работает штатно
            </label>
            <label className="radio-row">
              <input type="radio" name="equipment-operational" checked={equipmentOperational === false} onChange={() => setEquipmentOperational(false)} />
              Неисправность сохраняется
            </label>
            {equipmentOperational === false ? <p className="field__error">Закрытие недоступно. Верни работу инженеру на доработку</p> : null}
            {equipmentOperational === null ? <p className="field__hint">Выбери результат проверки явно</p> : null}
          </fieldset>
        ) : null}
        <div className="field">
          <label htmlFor="decision-comment">Комментарий или причина</label>
          <textarea
            id="decision-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Опиши основание решения"
          />
          <p className="field__hint">Минимум 3 символа</p>
        </div>
      </Modal>
    </div>
  );
}

function backRoute(role: string) {
  if (role === "maintenance_coordinator") return "/maintenance/queue";
  if (role === "senior_dispatcher") return "/operations";
  if (role === "manager") return "/city";
  return "/my-facility";
}

function orderTone(status: string) {
  if (status === "closed") return "success" as const;
  if (["waiting_access", "waiting_parts", "needs_clarification", "rework"].includes(status)) return "warning" as const;
  if (["verification", "completed_by_engineer", "triage", "submitted"].includes(status)) return "forecast" as const;
  return "info" as const;
}

function slaLabel(state: string) {
  return {
    on_track: "в норме",
    at_risk: "под риском",
    breached: "нарушен",
    paused: "пауза",
    completed: "выполнен",
    not_applicable: "нет",
  }[state] ?? state;
}

function categoryLabel(code: string) {
  return {
    predictive_maintenance: "Предиктивное обслуживание",
    sensor_failure: "Отказ датчика",
    equipment_fault: "Неисправность оборудования",
    manual_inspection: "Осмотр и диагностика",
  }[code] ?? code;
}

function rootCauseLabel(code: string | null) {
  if (!code) return "Не установлена";
  return {
    contact_failure: "Нарушение контакта",
    wear: "Износ оборудования",
    contamination: "Загрязнение",
    power_supply: "Питание или электрика",
    other: "Другая причина",
  }[code] ?? "Другая причина";
}
