import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle,
  ClockCountdown,
  UserPlus,
  Warning,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, InlineAlert, Modal, StatusBadge } from "../shared/ui";
import { useFacilities, useFacilityDispatchers, useWorkOrders } from "../app/dataHooks";
import { useContour, useRepositoryCommandMeta } from "../app/ContourProvider";
import { facilityStatusLabels, pluralizeRu, statusLabels } from "../app/labels";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";

export function OperationsPage() {
  const { repository, invalidateAll } = useContour();
  const commandMeta = useRepositoryCommandMeta();
  const facilitiesQuery = useFacilities();
  const ordersQuery = useWorkOrders();
  const dispatchersQuery = useFacilityDispatchers();
  const [assignFacilityId, setAssignFacilityId] = useState<string | null>(null);
  const [dispatcherId, setDispatcherId] = useState("");

  const facilities = facilitiesQuery.data ?? [];
  const orders = ordersQuery.data ?? [];
  const dispatchers = dispatchersQuery.data ?? [];
  const facilityToAssign = facilities.find((facility) => facility.id === assignFacilityId) ?? null;

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!facilityToAssign || !dispatcherId) throw new Error("Выбери диспетчера");
      const startsAt = repository.getSnapshot().demoClockIso;
      const endsAt = new Date(Date.parse(startsAt) + 12 * 60 * 60 * 1000).toISOString();
      return repository.assignFacilityDispatcher({
        facilityId: facilityToAssign.id,
        dispatcherId,
        startsAt,
        endsAt,
        expectedVersion: facilityToAssign.version,
        ...commandMeta(JSON.stringify([
          "assign_dispatcher",
          facilityToAssign.id,
          facilityToAssign.version,
          dispatcherId,
          startsAt,
          endsAt,
        ])),
      });
    },
    onSuccess: async () => {
      await invalidateAll();
      setAssignFacilityId(null);
      setDispatcherId("");
    },
  });

  const openOrders = orders.filter((order) => !["draft", "closed", "cancelled"].includes(order.status));
  const breached = openOrders.filter((order) => order.sla?.state === "breached");
  const unassignedFacilities = facilities.filter((facility) => !facility.responsibleDispatcherId);
  const urgentOrders = [...openOrders]
    .sort((first, second) => {
      if (first.sla?.state === "breached" && second.sla?.state !== "breached") return -1;
      if (second.sla?.state === "breached" && first.sla?.state !== "breached") return 1;
      return Date.parse(first.updatedAt) - Date.parse(second.updatedAt);
    })
    .slice(0, 6);

  if (facilitiesQuery.isPending || ordersQuery.isPending || dispatchersQuery.isPending) {
    return <PageLoading label="Собираем оперативную сводку зоны" />;
  }
  if (facilitiesQuery.isError || ordersQuery.isError || dispatchersQuery.isError) {
    return <PageError onRetry={() => void Promise.all([
      facilitiesQuery.refetch(),
      ordersQuery.refetch(),
      dispatchersQuery.refetch(),
    ])} />;
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Операции эксплуатационной зоны</h1>
          <p className="page-header__meta">Объекты, смены диспетчеров и контроль SLA</p>
        </div>
        <StatusBadge tone="info">Смены по индивидуальным интервалам</StatusBadge>
      </header>

      {unassignedFacilities.length ? (
        <InlineAlert
          tone="warning"
          title={`${unassignedFacilities.length} ${objectWord(unassignedFacilities.length)} без дежурного диспетчера`}
          action={
            <Button
              variant="secondary"
              size="medium"
              startIcon={<UserPlus size={18} />}
              onClick={() => setAssignFacilityId(unassignedFacilities[0]!.id)}
            >
              Назначить смену
            </Button>
          }
        >
          Назначь ответственного до начала следующего контрольного интервала
        </InlineAlert>
      ) : null}

      <div className="metric-strip" style={{ marginTop: 16 }}>
        <div className="metric-strip__item">
          <span className="metric-strip__value">{facilities.length}</span>
          <span className="metric-strip__label">{pluralizeRu(facilities.length, ["объект", "объекта", "объектов"])} в зоне</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value">{openOrders.length}</span>
          <span className="metric-strip__label">{pluralizeRu(openOrders.length, ["открытая заявка", "открытые заявки", "открытых заявок"])}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value tone-warning">{breached.length}</span>
          <span className="metric-strip__label">{pluralizeRu(breached.length, ["нарушение SLA", "нарушения SLA", "нарушений SLA"])}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value">{facilities.length - unassignedFacilities.length}</span>
          <span className="metric-strip__label">{pluralizeRu(facilities.length - unassignedFacilities.length, ["смена укомплектована", "смены укомплектованы", "смен укомплектовано"])}</span>
        </div>
      </div>

      <div className="split-layout" style={{ marginTop: 16 }}>
        <section className="surface">
          <header className="surface__header">
            <div>
              <h2>Объекты зоны</h2>
              <p className="page-header__meta">Текущий статус и ответственные</p>
            </div>
          </header>
          <div className="surface__body surface__body--flush">
            <div className="data-table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Объект</th>
                    <th>Статус</th>
                    <th>Диспетчер</th>
                    <th>Заявки</th>
                    <th aria-label="Действия" />
                  </tr>
                </thead>
                <tbody>
                  {facilities.map((facility) => {
                    const facilityOrders = openOrders.filter(
                      (order) => order.target.facilityId === facility.id,
                    );
                    return (
                      <tr key={facility.id}>
                        <td>
                          <Link to={`/facilities/${facility.id}`}>
                            {facility.name}
                          </Link>
                          <small className="muted">{facility.address}</small>
                        </td>
                        <td>
                          <StatusBadge tone={facilityTone(facility.status)}>
                            {facilityStatusLabels[facility.status]}
                          </StatusBadge>
                        </td>
                        <td>
                          {facility.responsibleDispatcherId ? (
                            <span className="inline-person">
                              <CheckCircle size={17} className="tone-success" /> Назначен
                            </span>
                          ) : (
                            <button
                              className="text-action tone-warning"
                              type="button"
                              onClick={() => setAssignFacilityId(facility.id)}
                            >
                              Назначить
                            </button>
                          )}
                        </td>
                        <td>{facilityOrders.length}</td>
                        <td>
                          <Link className="row-action" to={`/facilities/${facility.id}`} aria-label={`Открыть ${facility.name}`}>
                            <ArrowRight size={18} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <aside className="surface">
          <header className="surface__header">
            <div>
              <h2>Контроль смены</h2>
              <p className="page-header__meta">Приоритетные заявки</p>
            </div>
          </header>
          <div className="surface__body surface__body--flush">
            {urgentOrders.length ? (
              <ul className="plain-list">
                {urgentOrders.map((order) => (
                  <li key={order.id}>
                    <Link className="attention-item" to={`/work-orders/${order.id}`}>
                      <span
                        className={`attention-item__icon ${order.sla?.state === "breached" ? "bg-danger" : "bg-warning"}`}
                        aria-hidden="true"
                      >
                        {order.sla?.state === "breached" ? (
                          <Warning size={18} weight="fill" />
                        ) : (
                          <ClockCountdown size={18} />
                        )}
                      </span>
                      <span>
                        <strong>{order.number}</strong>
                        <small>{order.target.displayName}</small>
                      </span>
                      <StatusBadge tone={order.sla?.state === "breached" ? "critical" : "info"}>
                        {statusLabels[order.status]}
                      </StatusBadge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Очередь пуста" description="Приоритетных заявок в зоне нет" />
            )}
          </div>
        </aside>
      </div>

      <Modal
        open={Boolean(facilityToAssign)}
        onClose={() => setAssignFacilityId(null)}
        title="Назначить диспетчера на смену"
        description={facilityToAssign?.name}
        footer={
          <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button variant="secondary" onClick={() => setAssignFacilityId(null)}>
              Отмена
            </Button>
            <Button
              loading={assignMutation.isPending}
              disabled={!dispatcherId}
              startIcon={<CalendarCheck size={18} />}
              onClick={() => assignMutation.mutate()}
            >
              Назначить на 12 часов
            </Button>
          </div>
        }
      >
        <div className="field">
          <label htmlFor="dispatcher-select">Диспетчер объекта</label>
          <select
            id="dispatcher-select"
            value={dispatcherId}
            onChange={(event) => setDispatcherId(event.target.value)}
          >
            <option value="">Выбери сотрудника</option>
            {dispatchers.map((dispatcher) => (
              <option key={dispatcher.id} value={dispatcher.id}>
                {dispatcher.displayName}
              </option>
            ))}
          </select>
          <p className="field__hint">После назначения диспетчер получит доступ только к этому объекту</p>
        </div>
        {assignMutation.isError ? (
          <InlineAlert tone="critical" title="Назначение не сохранено" style={{ marginTop: 12 }}>
            Возможно, объект уже изменён другим пользователем. Закрой окно и повтори действие
          </InlineAlert>
        ) : null}
      </Modal>
    </div>
  );
}

function facilityTone(status: "normal" | "attention" | "critical" | "no_data") {
  if (status === "critical") return "critical" as const;
  if (status === "attention") return "warning" as const;
  if (status === "normal") return "success" as const;
  return "neutral" as const;
}

function objectWord(count: number) {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "объектов";
  const last = count % 10;
  if (last === 1) return "объект";
  if (last >= 2 && last <= 4) return "объекта";
  return "объектов";
}
