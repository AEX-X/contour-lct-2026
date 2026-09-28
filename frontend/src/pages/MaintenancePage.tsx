import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  Play,
  ShieldCheck,
  UserPlus,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { hasActiveEngineerAssignment, type WorkOrderPriority } from "../domain";
import { Button, InlineAlert, StatusBadge } from "../shared/ui";
import { useEngineerCandidates, useWorkOrders } from "../app/dataHooks";
import { useContour, useRepositoryCommandMeta } from "../app/ContourProvider";
import {
  formatDateTime,
  pluralizeRu,
  priorityLabels,
  statusLabels,
} from "../app/labels";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";

export function MaintenancePage() {
  const { repository, invalidateAll } = useContour();
  const commandMeta = useRepositoryCommandMeta();
  const [searchParams, setSearchParams] = useSearchParams();
  const ordersQuery = useWorkOrders();
  const queueOrders = useMemo(
    () =>
      (ordersQuery.data ?? [])
        .filter((order) => !["draft", "closed", "cancelled"].includes(order.status))
        .sort((first, second) => {
          const priorityWeight = { P1: 0, P2: 1, P3: 2, P4: 3 };
          const slaWeight = { breached: 0, at_risk: 1, on_track: 2, paused: 3, completed: 4, not_applicable: 5 };
          const firstSla = first.sla ? slaWeight[first.sla.state] : 6;
          const secondSla = second.sla ? slaWeight[second.sla.state] : 6;
          if (firstSla !== secondSla) return firstSla - secondSla;
          const firstPriority = first.finalPriority ?? first.preliminaryPriority ?? "P4";
          const secondPriority = second.finalPriority ?? second.preliminaryPriority ?? "P4";
          const byPriority = priorityWeight[firstPriority] - priorityWeight[secondPriority];
          if (byPriority !== 0) return byPriority;
          return (first.sla?.remainingSeconds ?? Number.POSITIVE_INFINITY)
            - (second.sla?.remainingSeconds ?? Number.POSITIVE_INFINITY);
        }),
    [ordersQuery.data],
  );
  const selectedId = searchParams.get("workOrder") ?? queueOrders[0]?.id;
  const selected = queueOrders.find((order) => order.id === selectedId) ?? null;
  const candidatesQuery = useEngineerCandidates(selected?.id);
  const [selectedEngineer, setSelectedEngineer] = useState("");
  const [priorityOverride, setPriorityOverride] = useState<WorkOrderPriority | null>(null);
  const [clarificationReason, setClarificationReason] = useState("");
  const [reassignReason, setReassignReason] = useState("");

  useEffect(() => {
    const requestedId = searchParams.get("workOrder");
    if (requestedId && !selected && queueOrders[0]) {
      setSearchParams({ workOrder: queueOrders[0].id }, { replace: true });
    }
  }, [queueOrders, searchParams, selected, setSearchParams]);

  const priority = priorityOverride ?? selected?.finalPriority ?? selected?.preliminaryPriority ?? "P2";

  const actionMutation = useMutation({
    mutationFn: async (action: "start_triage" | "finalize_priority" | "assign" | "reassign" | "request_clarification") => {
      if (!selected) throw new Error("Заявка не выбрана");
      if (action === "start_triage") {
        return repository.performWorkOrderAction(selected.id, {
          action,
          ...commandMeta(selected.version, `${selected.id}:${selected.version}:start_triage`),
          payload: { comment: "Принято координатором в работу" },
        });
      }
      if (action === "finalize_priority") {
        return repository.performWorkOrderAction(selected.id, {
          action,
          ...commandMeta(selected.version, JSON.stringify([selected.id, selected.version, action, priority])),
          payload: { priority, slaPolicyId: `demo-${priority.toLowerCase()}` },
        });
      }
      if (action === "request_clarification") {
        return repository.performWorkOrderAction(selected.id, {
          action,
          ...commandMeta(selected.version, JSON.stringify([selected.id, selected.version, action, clarificationReason.trim()])),
          payload: { reason: clarificationReason.trim() },
        });
      }
      if (!selectedEngineer) throw new Error("Инженер не выбран");
      if (action === "reassign") {
        return repository.performWorkOrderAction(selected.id, {
          action,
          ...commandMeta(selected.version, JSON.stringify([selected.id, selected.version, action, selectedEngineer, reassignReason.trim()])),
          payload: { engineerId: selectedEngineer, reason: reassignReason.trim() },
        });
      }
      return repository.performWorkOrderAction(selected.id, {
        action,
        ...commandMeta(selected.version, JSON.stringify([selected.id, selected.version, action, selectedEngineer])),
        payload: { engineerId: selectedEngineer, comment: "Назначен по специализации и загрузке" },
      });
    },
    onSuccess: async () => {
      await invalidateAll();
      setClarificationReason("");
      setReassignReason("");
    },
  });

  if (ordersQuery.isPending) return <PageLoading label="Загружаем ремонтную очередь" />;
  if (ordersQuery.isError) return <PageError onRetry={() => void ordersQuery.refetch()} />;

  const candidates = candidatesQuery.data ?? [];
  const workload = candidates.reduce((sum, item) => sum + item.activeWorkOrderCount, 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Ремонтная очередь</h1>
          <p className="page-header__meta">
            Триаж, SLA и распределение заявок по инженерам
          </p>
        </div>
        <StatusBadge tone="info">Городская ремонтная служба, демо</StatusBadge>
      </header>

      <div className="metric-strip">
        <div className="metric-strip__item">
          <span className="metric-strip__value">{queueOrders.length}</span>
          <span className="metric-strip__label">{pluralizeRu(queueOrders.length, ["заявка в работе", "заявки в работе", "заявок в работе"])}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value tone-warning">
            {queueOrders.filter((order) => ["submitted", "triage"].includes(order.status)).length}
          </span>
          <span className="metric-strip__label">{pluralizeRu(queueOrders.filter((order) => ["submitted", "triage"].includes(order.status)).length, ["ожидает решения", "ожидают решения", "ожидают решения"])}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value">
            {queueOrders.filter(hasActiveEngineerAssignment).length}
          </span>
          <span className="metric-strip__label">{pluralizeRu(queueOrders.filter(hasActiveEngineerAssignment).length, ["назначена инженеру", "назначены инженерам", "назначены инженерам"])}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value">{workload}</span>
          <span className="metric-strip__label">{pluralizeRu(workload, ["активная работа у кандидатов", "активные работы у кандидатов", "активных работ у кандидатов"])}</span>
        </div>
      </div>

      <div className="queue-layout" style={{ marginTop: 16 }}>
        <section className="surface queue-list" aria-label="Список ремонтных заявок">
          <header className="surface__header">
            <div>
              <h2>Приоритетная очередь</h2>
              <p className="page-header__meta">Сначала аварийные и просроченные</p>
            </div>
          </header>
          <div className="surface__body surface__body--flush">
            {queueOrders.length ? (
              queueOrders.map((order) => (
                <button
                  className="queue-card"
                  type="button"
                  key={order.id}
                  aria-current={selected?.id === order.id ? "true" : undefined}
                  onClick={() => {
                    setSearchParams({ workOrder: order.id });
                  }}
                >
                  <span className="queue-card__top">
                    <strong>{order.number}</strong>
                    <StatusBadge tone={orderTone(order.status)}>{statusLabels[order.status]}</StatusBadge>
                  </span>
                  <span className="queue-card__meta">
                    <span>{order.target.displayName}</span>
                    <span>{priorityLabels[order.finalPriority ?? order.preliminaryPriority ?? "P4"]}</span>
                    {order.sla?.state === "breached" ? (
                      <span className="tone-danger">SLA нарушен</span>
                    ) : null}
                  </span>
                </button>
              ))
            ) : (
              <EmptyState title="Очередь пуста" description="Новые заявки появятся здесь после отправки" />
            )}
          </div>
        </section>

        <section className="surface">
          {selected ? (
            <>
              <header className="surface__header">
                <div>
                  <div className="inline-actions">
                    <StatusBadge tone={orderTone(selected.status)}>{statusLabels[selected.status]}</StatusBadge>
                    <StatusBadge tone={selected.sla?.state === "breached" ? "critical" : "info"}>
                      {selected.sla ? `SLA: ${slaLabel(selected.sla.state)}` : "SLA не назначен"}
                    </StatusBadge>
                  </div>
                  <h2 style={{ marginTop: 8 }}>{selected.number}</h2>
                  <p className="page-header__meta">{selected.target.displayName}</p>
                </div>
                <Link className="row-action" to={`/work-orders/${selected.id}`} aria-label="Открыть карточку заявки">
                  <ArrowRight size={20} />
                </Link>
              </header>
              <div className="surface__body content-stack">
                <dl className="definition-grid">
                  <dt>Объект</dt>
                  <dd>{selected.snapshot.facilityName}</dd>
                  <dt>Предварительный приоритет</dt>
                  <dd>{selected.preliminaryPriority ? priorityLabels[selected.preliminaryPriority] : "Не задан"}</dd>
                  <dt>Создана</dt>
                  <dd>{formatDateTime(selected.createdAt)}</dd>
                  <dt>Автор</dt>
                  <dd>{selected.creator.displayName}</dd>
                </dl>

                <div>
                  <strong>Описание</strong>
                  <p className="muted" style={{ marginTop: 4 }}>{selected.description}</p>
                </div>

                {selected.allowedActions.includes("start_triage") ? (
                  <InlineAlert
                    tone="info"
                    title="Заявка готова к триажу"
                    action={
                      <Button
                        startIcon={<Play size={18} />}
                        loading={actionMutation.isPending}
                        onClick={() => actionMutation.mutate("start_triage")}
                      >
                        Взять в работу
                      </Button>
                    }
                  >
                    Проверь цель, признаки и полноту технического контекста
                  </InlineAlert>
                ) : null}

                {selected.allowedActions.includes("finalize_priority") ? (
                  <div className="form-grid">
                    <div className="field">
                      <label htmlFor="final-priority">Финальный приоритет</label>
                      <select
                        id="final-priority"
                        value={priority}
                        onChange={(event) => setPriorityOverride(event.target.value as WorkOrderPriority)}
                      >
                        {(Object.keys(priorityLabels) as WorkOrderPriority[]).map((item) => (
                          <option value={item} key={item}>{priorityLabels[item]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field" style={{ alignSelf: "end" }}>
                      <Button
                        fullWidth
                        startIcon={<ShieldCheck size={18} />}
                        loading={actionMutation.isPending}
                        onClick={() => actionMutation.mutate("finalize_priority")}
                      >
                        Зафиксировать приоритет и SLA
                      </Button>
                    </div>
                  </div>
                ) : null}

                {selected.allowedActions.includes("request_clarification") ? (
                  <details className="details-box">
                    <summary>Запросить уточнение у диспетчера</summary>
                    <div className="field" style={{ marginTop: 12 }}>
                      <label htmlFor="clarification">Что нужно уточнить</label>
                      <textarea
                        id="clarification"
                        value={clarificationReason}
                        onChange={(event) => setClarificationReason(event.target.value)}
                      />
                      <Button
                        variant="secondary"
                        disabled={clarificationReason.trim().length < 5}
                        onClick={() => actionMutation.mutate("request_clarification")}
                      >
                        Вернуть на уточнение
                      </Button>
                    </div>
                  </details>
                ) : null}

                {selected.allowedActions.includes("assign") || selected.allowedActions.includes("reassign") ? (
                  <div>
                    <div className="inline-actions" style={{ justifyContent: "space-between" }}>
                      <h3>{selected.allowedActions.includes("reassign") ? "Переназначение инженера" : "Назначение инженера"}</h3>
                      <StatusBadge tone="info">{candidates.filter((item) => item.eligible).length} подходят</StatusBadge>
                    </div>
                    {candidatesQuery.isPending ? (
                      <PageLoading label="Подбираем инженеров" />
                    ) : candidatesQuery.isError ? (
                      <PageError
                        title="Не удалось подобрать инженеров"
                        message="Повтори запрос, данные заявки сохранятся"
                        onRetry={() => void candidatesQuery.refetch()}
                      />
                    ) : (
                      <div className="candidate-list" style={{ marginTop: 10 }}>
                        {candidates.map((candidate) => (
                          <label
                            className="candidate-card"
                            data-selected={selectedEngineer === candidate.user.id}
                            key={candidate.user.id}
                          >
                            <span className="candidate-card__avatar" aria-hidden="true">
                              {candidate.user.displayName.slice(0, 1)}
                            </span>
                            <span>
                              <strong>{candidate.user.displayName}</strong>
                              <small className="muted">
                                {candidate.eligibilityReason} · {candidate.activeWorkOrderCount} {pluralizeRu(candidate.activeWorkOrderCount, ["активная работа", "активные работы", "активных работ"])}
                              </small>
                            </span>
                            <input
                              type="radio"
                              name="engineer"
                              value={candidate.user.id}
                              checked={selectedEngineer === candidate.user.id}
                              disabled={!candidate.eligible}
                              aria-label={`${candidate.user.displayName}. ${candidate.eligibilityReason}. ${candidate.activeWorkOrderCount} ${pluralizeRu(candidate.activeWorkOrderCount, ["активная работа", "активные работы", "активных работ"])}`}
                              onChange={() => setSelectedEngineer(candidate.user.id)}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                    {selected.allowedActions.includes("reassign") ? (
                      <div className="field" style={{ marginTop: 12 }}>
                        <label htmlFor="reassign-reason">Причина переназначения</label>
                        <textarea
                          id="reassign-reason"
                          value={reassignReason}
                          onChange={(event) => setReassignReason(event.target.value)}
                          placeholder="Почему меняется исполнитель"
                        />
                      </div>
                    ) : null}
                    <Button
                      fullWidth
                      size="large"
                      startIcon={<UserPlus size={19} />}
                      disabled={
                        !selectedEngineer ||
                        selectedEngineer === selected.currentAssignment?.engineerId ||
                        (selected.allowedActions.includes("reassign") && reassignReason.trim().length < 5)
                      }
                      loading={actionMutation.isPending}
                      style={{ marginTop: 12 }}
                      onClick={() => actionMutation.mutate(selected.allowedActions.includes("reassign") ? "reassign" : "assign")}
                    >
                      {selected.allowedActions.includes("reassign") ? "Переназначить инженера" : "Назначить инженера"}
                    </Button>
                  </div>
                ) : null}

                {selected.currentAssignment && ["assigned", "accepted"].includes(selected.currentAssignment.status) ? (
                  <InlineAlert tone="success" title="Инженер назначен">
                    Доступ к техническому контексту выдан временно. Он будет отозван после закрытия,
                    отмены, отказа или переназначения заявки
                  </InlineAlert>
                ) : null}

                {actionMutation.isError ? (
                  <InlineAlert tone="critical" title="Действие не выполнено">
                    Версия заявки могла измениться. Данные формы сохранены, обнови карточку и повтори действие
                  </InlineAlert>
                ) : null}
              </div>
            </>
          ) : (
            <EmptyState title="Выбери заявку" description="Справа появятся детали и доступные действия" />
          )}
        </section>
      </div>
    </div>
  );
}

function orderTone(status: string) {
  if (["needs_clarification", "waiting_access", "waiting_parts", "rework"].includes(status)) return "warning" as const;
  if (["closed"].includes(status)) return "success" as const;
  if (["submitted", "triage", "completed_by_engineer", "verification"].includes(status)) return "forecast" as const;
  return "info" as const;
}

function slaLabel(state: string) {
  return {
    on_track: "в норме",
    at_risk: "под риском",
    breached: "нарушен",
    paused: "приостановлен",
    completed: "выполнен",
    not_applicable: "не применяется",
  }[state] ?? state;
}
