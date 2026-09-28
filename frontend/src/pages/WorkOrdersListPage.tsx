import { ArrowRight } from "@phosphor-icons/react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { WorkOrderStatus } from "../domain";
import { SegmentedControl, StatusBadge } from "../shared/ui";
import { useWorkOrders } from "../app/dataHooks";
import { formatDateTime, priorityLabels, statusLabels } from "../app/labels";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";

type OrderPreset = "active" | "attention" | "closed" | "all";

export function WorkOrdersListPage() {
  const ordersQuery = useWorkOrders();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawPreset = searchParams.get("preset");
  const preset: OrderPreset = ["active", "attention", "closed", "all"].includes(rawPreset ?? "")
    ? (rawPreset as OrderPreset)
    : "active";
  const query = searchParams.get("q") ?? "";
  const sla = searchParams.get("sla");
  const closedFrom = searchParams.get("closedFrom");
  const closedTo = searchParams.get("closedTo");

  const updateParams = (patch: { q?: string | null; preset?: OrderPreset | null }) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(patch).forEach(([key, value]) => {
        if (value && !(key === "preset" && value === "active")) next.set(key, value);
        else next.delete(key);
      });
      if (patch.preset !== undefined) {
        next.delete("sla");
        next.delete("closedFrom");
        next.delete("closedTo");
      }
      return next;
    });
  };

  const filtered = useMemo(() => {
    const source = ordersQuery.data ?? [];
    const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
    return source.filter((order) => {
      const matchesPreset =
        preset === "all" ||
        (preset === "active" && !["draft", "closed", "cancelled"].includes(order.status)) ||
        (preset === "attention" &&
          (["needs_clarification", "waiting_access", "waiting_parts", "rework"].includes(order.status) ||
            order.sla?.state === "breached")) ||
        (preset === "closed" && ["closed", "cancelled"].includes(order.status));
      const matchesQuery =
        !normalizedQuery ||
        order.number.toLocaleLowerCase("ru-RU").includes(normalizedQuery) ||
        order.target.displayName.toLocaleLowerCase("ru-RU").includes(normalizedQuery) ||
        order.snapshot.facilityName.toLocaleLowerCase("ru-RU").includes(normalizedQuery);
      const matchesSla = !sla || order.sla?.state === sla;
      const closedAt = order.closedAt ? Date.parse(order.closedAt) : Number.NaN;
      const matchesClosedWindow =
        (!closedFrom || (Number.isFinite(closedAt) && closedAt >= Date.parse(closedFrom))) &&
        (!closedTo || (Number.isFinite(closedAt) && closedAt <= Date.parse(closedTo)));
      return matchesPreset && matchesQuery && matchesSla && matchesClosedWindow;
    });
  }, [closedFrom, closedTo, ordersQuery.data, preset, query, sla]);

  if (ordersQuery.isPending) return <PageLoading label="Загружаем заявки" />;
  if (ordersQuery.isError) return <PageError onRetry={() => void ordersQuery.refetch()} />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Заявки и работы</h1>
          <p className="page-header__meta">Единая очередь в рамках доступной области ответственности</p>
        </div>
        <StatusBadge tone="info">{filtered.length} показано</StatusBadge>
      </header>

      <div className="city-toolbar" style={{ borderRadius: 10, marginBottom: 12 }}>
        <div className="city-toolbar__search">
          <label className="sr-only" htmlFor="orders-search">Поиск заявки</label>
          <input
            id="orders-search"
            type="search"
            value={query}
            onChange={(event) => updateParams({ q: event.target.value || null })}
            placeholder="Номер, объект или оборудование"
          />
        </div>
        <SegmentedControl
          label="Фильтр заявок"
          value={preset}
          onChange={(value) => updateParams({ preset: value as OrderPreset })}
          items={[
            { value: "active", label: "Активные" },
            { value: "attention", label: "Требуют решения" },
            { value: "closed", label: "Завершённые" },
            { value: "all", label: "Все" },
          ]}
        />
      </div>

      {filtered.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Заявка</th>
                <th>Объект и цель</th>
                <th>Статус</th>
                <th>Приоритет</th>
                <th>SLA</th>
                <th>Обновлена</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((order) => (
                <tr key={order.id}>
                  <td>
                    <Link to={`/work-orders/${order.id}`}>{order.number}</Link>
                    <small className="muted">{categoryLabel(order.categoryCode)}</small>
                  </td>
                  <td>
                    <strong>{order.snapshot.facilityName}</strong>
                    <small className="muted">{order.target.displayName}</small>
                  </td>
                  <td>
                    <StatusBadge tone={orderTone(order.status)}>{statusLabels[order.status]}</StatusBadge>
                  </td>
                  <td>
                    {order.finalPriority || order.preliminaryPriority
                      ? priorityLabels[order.finalPriority ?? order.preliminaryPriority!]
                      : "Не задан"}
                  </td>
                  <td>
                    <StatusBadge tone={order.sla?.state === "breached" ? "critical" : "neutral"}>
                      {order.sla ? slaLabel(order.sla.state) : "Не назначен"}
                    </StatusBadge>
                  </td>
                  <td>{formatDateTime(order.updatedAt)}</td>
                  <td>
                    <Link className="row-action" to={`/work-orders/${order.id}`} aria-label={`Открыть ${order.number}`}>
                      <ArrowRight size={18} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="Заявки не найдены"
          description="Измени фильтр или поисковый запрос"
          action={
            <button className="ui-button ui-button--secondary ui-button--medium" type="button" onClick={() => setSearchParams({ preset: "all" })}>
              Сбросить фильтры
            </button>
          }
        />
      )}
    </div>
  );
}

function orderTone(status: WorkOrderStatus) {
  if (status === "closed") return "success" as const;
  if (status === "cancelled") return "neutral" as const;
  if (["needs_clarification", "waiting_access", "waiting_parts", "rework"].includes(status)) return "warning" as const;
  if (["submitted", "triage", "completed_by_engineer", "verification"].includes(status)) return "forecast" as const;
  return "info" as const;
}

function slaLabel(state: string) {
  return { on_track: "В норме", at_risk: "Под риском", breached: "Нарушен", paused: "Пауза", completed: "Выполнен", not_applicable: "Не применяется" }[state] ?? state;
}

function categoryLabel(code: string) {
  return { predictive_maintenance: "Предиктивное ТО", sensor_failure: "Отказ датчика", equipment_fault: "Оборудование", manual_inspection: "Осмотр" }[code] ?? code;
}
