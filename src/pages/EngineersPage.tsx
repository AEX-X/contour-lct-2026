import { MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useMaintenanceEngineers } from "../app/dataHooks";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";
import { StatusBadge } from "../shared/ui";

type AvailabilityFilter = "all" | "available" | "busy" | "off_shift";

const availabilityLabels = {
  available: "Доступен",
  busy: "Занят",
  off_shift: "Не на смене",
} as const;

export function EngineersPage() {
  const engineersQuery = useMaintenanceEngineers();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const rawAvailability = searchParams.get("availability");
  const availability: AvailabilityFilter = ["available", "busy", "off_shift"].includes(rawAvailability ?? "")
    ? (rawAvailability as AvailabilityFilter)
    : "all";

  const engineers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru-RU");
    return (engineersQuery.data ?? []).filter(({ user }) => {
      const matchesQuery = !normalized || [user.displayName, ...(user.specializationCodes ?? [])]
        .join(" ")
        .toLocaleLowerCase("ru-RU")
        .includes(normalized);
      return matchesQuery && (availability === "all" || user.availability === availability);
    });
  }, [availability, engineersQuery.data, query]);

  function updateParams(patch: Record<string, string | null>) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(patch).forEach(([key, value]) => {
        if (value && value !== "all") next.set(key, value);
        else next.delete(key);
      });
      return next;
    });
  }

  if (engineersQuery.isPending) return <PageLoading label="Загружаем команду инженеров" />;
  if (engineersQuery.isError) return <PageError onRetry={() => void engineersQuery.refetch()} />;

  const all = engineersQuery.data ?? [];
  const activeLoad = all.reduce((sum, engineer) => sum + engineer.activeWorkOrderCount, 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Загрузка инженеров</h1>
          <p className="page-header__meta">Доступность, специализации и текущие назначения ремонтной службы</p>
        </div>
        <StatusBadge tone="info">{engineers.length} показано</StatusBadge>
      </header>

      <div className="metric-strip" aria-label="Сводка по инженерам">
        <div className="metric-strip__item">
          <span className="metric-strip__value">{all.length}</span>
          <span className="metric-strip__label">инженеров в команде</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value tone-success">{all.filter(({ user }) => user.availability === "available").length}</span>
          <span className="metric-strip__label">доступны сейчас</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value tone-warning">{all.filter(({ user }) => user.availability === "busy").length}</span>
          <span className="metric-strip__label">заняты</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value">{activeLoad}</span>
          <span className="metric-strip__label">активных назначений</span>
        </div>
      </div>

      <div className="city-toolbar" style={{ borderRadius: 10, margin: "16px 0 12px" }}>
        <div className="city-toolbar__search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <label className="sr-only" htmlFor="engineer-search">Найти инженера</label>
          <input
            id="engineer-search"
            type="search"
            value={query}
            placeholder="ФИО или специализация"
            onChange={(event) => updateParams({ q: event.target.value || null })}
          />
        </div>
        <select
          aria-label="Фильтр доступности инженера"
          value={availability}
          onChange={(event) => updateParams({ availability: event.target.value })}
        >
          <option value="all">Все статусы</option>
          <option value="available">Доступны</option>
          <option value="busy">Заняты</option>
          <option value="off_shift">Не на смене</option>
        </select>
      </div>

      {engineers.length ? (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Инженер</th>
                <th>Статус</th>
                <th>Специализации</th>
                <th>Активные работы</th>
                <th>Готовность к назначению</th>
              </tr>
            </thead>
            <tbody>
              {engineers.map((engineer) => (
                <tr key={engineer.user.id}>
                  <td>
                    <strong>{engineer.user.displayName}</strong>
                    <small className="muted">Городская ремонтная служба</small>
                  </td>
                  <td>
                    <StatusBadge tone={availabilityTone(engineer.user.availability)}>
                      {availabilityLabels[engineer.user.availability ?? "off_shift"]}
                    </StatusBadge>
                  </td>
                  <td>{(engineer.user.specializationCodes ?? []).join(", ") || "Не указаны"}</td>
                  <td className="numeric">{engineer.activeWorkOrderCount}</td>
                  <td>{engineer.eligibilityReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="Инженеры не найдены" description="Измени поиск или фильтр доступности" />
      )}
    </div>
  );
}

function availabilityTone(availability: "available" | "busy" | "off_shift" | undefined) {
  if (availability === "available") return "success" as const;
  if (availability === "busy") return "warning" as const;
  return "neutral" as const;
}
