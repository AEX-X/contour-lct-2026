import {
  ArrowRight,
  Buildings,
  CaretLeft,
  CaretRight,
  ClockCountdown,
  ListBullets,
  MapTrifold,
  MapPin,
  Sparkle,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  deriveFacilityOperationalState,
  isRiskActiveAt,
  type Facility,
  type FacilityOperationalState,
  type RiskForecast,
} from "../domain";
import {
  Button,
  KpiCard,
  InlineAlert,
  SegmentedControl,
  StatusBadge,
  IconButton,
} from "../shared/ui";
import { CityMap } from "../components/CityMap";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";
import {
  useDashboardMetrics,
  useFacilities,
  useIncidents,
  useRisks,
  useWorkOrders,
} from "../app/dataHooks";
import {
  facilityStatusLabels,
  formatDateTime,
  formatPercent,
} from "../app/labels";

type ViewMode = "map" | "list";

const FACILITY_LIST_PAGE_SIZE = 20;

interface CityPageProps {
  initialView?: ViewMode;
}

export function CityPage({ initialView = "map" }: CityPageProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const rawStatus = searchParams.get("status");
  const status: Facility["status"] | "all" = ["all", "normal", "attention", "critical", "no_data"].includes(
    rawStatus ?? "",
  )
    ? (rawStatus as Facility["status"] | "all")
    : "all";
  const incidentFilter = searchParams.get("incident");
  const riskFilter = searchParams.get("risk");
  const selectedId = searchParams.get("facility");
  const rawView = searchParams.get("view");
  const view: ViewMode = rawView === "map" || rawView === "list" ? rawView : initialView;

  const facilitiesQuery = useFacilities({
    query: query || undefined,
  }, { keepPreviousData: true });
  const allFacilitiesQuery = useFacilities();
  const risksQuery = useRisks();
  const incidentsQuery = useIncidents();
  const workOrdersQuery = useWorkOrders();
  const metricsQuery = useDashboardMetrics();

  const allFacilities = allFacilitiesQuery.data ?? [];
  const risks = risksQuery.data ?? [];
  const incidents = incidentsQuery.data ?? [];
  const workOrders = workOrdersQuery.data ?? [];
  const scenarioNow = metricsQuery.data?.[0]?.updatedAt ?? "";
  const activeRisks = risks.filter((risk) => isRiskActiveAt(risk, scenarioNow));
  const orderRiskIds = new Set(
    workOrders
      .filter((order) => order.source.type === "risk" && order.status !== "cancelled")
      .map((order) => order.source.id)
      .filter((id): id is string => Boolean(id)),
  );
  const highRisksWithoutAction = activeRisks.filter(
    (risk) =>
      ["new", "acknowledged"].includes(risk.status) &&
      ["high", "critical"].includes(risk.severity) &&
      !orderRiskIds.has(risk.id),
  );
  const semanticFacilityIds =
    incidentFilter === "critical_open"
      ? new Set(
          incidents
            .filter((incident) => incident.severity === "critical" && incident.status !== "resolved")
            .map((incident) => incident.facilityId),
        )
      : riskFilter === "high_without_action"
        ? new Set(highRisksWithoutAction.map((risk) => risk.facilityId))
        : null;
  const operationalByFacility = new Map(
    (facilitiesQuery.data ?? []).map((facility) => [
      facility.id,
      deriveFacilityOperationalState(facility, risks, incidents, scenarioNow),
    ]),
  );
  const facilities = (facilitiesQuery.data ?? []).filter((facility) => {
    if (semanticFacilityIds && !semanticFacilityIds.has(facility.id)) return false;
    const operationalState = operationalByFacility.get(facility.id)?.state ?? facility.status;
    if (status === "all") return true;
    if (status === "attention") return operationalState === "attention" || operationalState === "forecast";
    return operationalState === status;
  });
  const selected = facilities.find((item) => item.id === selectedId) ?? null;
  const requestedPage = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const listPageCount = Math.max(1, Math.ceil(facilities.length / FACILITY_LIST_PAGE_SIZE));
  const listPage = Math.min(
    Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1,
    listPageCount,
  );

  const allAttentionItems = (() => {
    const severityWeight = { low: 1, medium: 2, high: 3, critical: 4 } as const;
    const priorityWeight = { P4: 1, P3: 2, P2: 3, P1: 4 } as const;
    const incidentItems = incidents
      .filter((incident) => incident.status !== "resolved")
      .map((incident) => ({
        id: `incident-${incident.id}`,
        facilityId: incident.facilityId,
        title: allFacilities.find((item) => item.id === incident.facilityId)?.name ?? "Объект",
        subtitle: incident.title,
        value: "Инцидент",
        tone: "danger" as const,
        icon: Warning,
        urgency: 80 + severityWeight[incident.severity] * 10,
        occurredAt: incident.confirmedAt,
      }));
    const riskItems = highRisksWithoutAction
      .map((risk) => ({
        id: `risk-${risk.id}`,
        facilityId: risk.facilityId,
        title: allFacilities.find((item) => item.id === risk.facilityId)?.name ?? "Объект",
        subtitle: risk.predictedEvent,
        value: formatPercent(risk.probability),
        tone: "purple" as const,
        icon: Sparkle,
        urgency: 40 + severityWeight[risk.severity] * 10,
        occurredAt: risk.createdAt,
      }));
    const orderItems = workOrders
      .filter((order) => order.sla?.state === "breached" && !["closed", "cancelled"].includes(order.status))
      .map((order) => ({
        id: `order-${order.id}`,
        facilityId: order.target.facilityId,
        title: `Заявка ${order.number}`,
        subtitle: order.target.displayName,
        value: "SLA нарушен",
        tone: "warning" as const,
        icon: ClockCountdown,
        urgency: 100 + priorityWeight[order.finalPriority ?? order.preliminaryPriority ?? "P4"] * 10,
        occurredAt: order.sla?.currentStage === "acceptance"
          ? order.sla.acceptanceDueAt ?? order.updatedAt
          : order.sla?.currentStage === "arrival"
            ? order.sla.arrivalDueAt ?? order.updatedAt
            : order.sla?.resolutionDueAt ?? order.updatedAt,
      }));
    return [...incidentItems, ...riskItems, ...orderItems].sort(
      (left, right) =>
        right.urgency - left.urgency ||
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
    );
  })();
  const attentionItems = allAttentionItems.slice(0, 7);

  function updateParams(patch: Record<string, string | null>) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(patch).forEach(([key, value]) => {
        if (value) next.set(key, value);
        else next.delete(key);
      });
      if (patch.status !== undefined) {
        next.delete("incident");
        next.delete("risk");
      }
      if (["q", "status", "incident", "risk"].some((key) => key in patch)) {
        next.delete("page");
      }
      return next;
    });
  }

  if (
    facilitiesQuery.isPending ||
    allFacilitiesQuery.isPending ||
    risksQuery.isPending ||
    incidentsQuery.isPending ||
    workOrdersQuery.isPending ||
    metricsQuery.isPending
  ) {
    return <PageLoading label="Собираем оперативную картину Москвы" />;
  }

  if (
    facilitiesQuery.isError ||
    allFacilitiesQuery.isError ||
    risksQuery.isError ||
    incidentsQuery.isError ||
    workOrdersQuery.isError ||
    metricsQuery.isError
  ) {
    return <PageError onRetry={() => void Promise.all([
      facilitiesQuery.refetch(),
      allFacilitiesQuery.refetch(),
      risksQuery.refetch(),
      incidentsQuery.refetch(),
      workOrdersQuery.refetch(),
      metricsQuery.refetch(),
    ])} />;
  }

  const metricByCode = new Map(metricsQuery.data.map((metric) => [metric.code, metric]));
  const historicalDemoRisk = risks.find((risk) => risk.demoClock && risk.modelAsOf);
  const kpis = [
    {
      code: "critical_incidents_now",
      label: "Объекты с критическими инцидентами",
      tone: "critical" as const,
      icon: Warning,
      fallback: 0,
    },
    {
      code: "high_risks_without_action",
      label: "Объекты с высоким риском без заявки",
      tone: "forecast" as const,
      icon: Sparkle,
      fallback: 0,
    },
    {
      code: "overdue_work_orders",
      label: "Просрочено по SLA",
      tone: "warning" as const,
      icon: ClockCountdown,
      fallback: 0,
    },
  ];

  return (
    <div className="page page--flush city-page">
      <h1 className="sr-only">Оперативная картина Москвы</h1>

      {historicalDemoRisk ? (
        <InlineAlert tone="warning" title="Исторический ML-демо">
          Прогнозы рассчитаны на модельный срез {formatDateTime(historicalDemoRisk.modelAsOf)}.
          Операционные заявки и SLA продолжают учитывать текущее время
        </InlineAlert>
      ) : null}

      <section className="kpi-grid" aria-label="Ключевые показатели">
        {kpis.map((item) => {
          const metric = metricByCode.get(item.code);
          return (
            <KpiCard
              key={item.code}
              label={metric?.label ?? item.label}
              value={metric?.value ?? item.fallback}
              icon={item.icon}
              tone={item.tone}
              detail="за текущие 24 часа"
              onClick={() => {
                const drilldown = metric?.drilldown;
                if (!drilldown) return;
                const params = new URLSearchParams(drilldown.filters);
                navigate(`${drilldown.route}${params.size ? `?${params}` : ""}`);
              }}
              actionLabel={`Показать объекты: ${item.label}`}
            />
          );
        })}
      </section>

      <div className="city-toolbar">
        <div className="city-toolbar__search">
          <label className="sr-only" htmlFor="facility-search">
            Поиск объекта
          </label>
          <input
            id="facility-search"
            type="search"
            value={query}
            placeholder="Название, адрес или внутренний код"
            onChange={(event) => updateParams({ q: event.target.value || null })}
          />
        </div>
        <select
          aria-label="Фильтр статуса объекта"
          value={status}
          onChange={(event) => updateParams({ status: event.target.value })}
        >
          <option value="all">Все статусы</option>
          <option value="critical">Инциденты</option>
          <option value="attention">Требуют внимания</option>
          <option value="normal">Норма</option>
          <option value="no_data">Нет данных</option>
        </select>
        <SegmentedControl
          label="Представление объектов"
          value={view}
          onChange={(next) => updateParams({ view: next })}
          items={[
            { value: "map", label: "Карта", icon: <MapTrifold size={18} /> },
            { value: "list", label: "Список", icon: <ListBullets size={18} /> },
          ]}
        />
      </div>

      <div className="city-layout">
        <section className="city-stage" aria-label={view === "map" ? "Карта объектов" : "Список объектов"}>
          {facilities.length === 0 ? (
            <EmptyState
              title="Объекты не найдены"
              description="Измени поисковый запрос или сбрось фильтры"
            />
          ) : view === "map" ? (
            <CityMap
              facilities={facilities}
              risks={activeRisks}
              incidents={incidents}
              asOf={scenarioNow}
              selectedId={selectedId}
              onSelect={(facilityId) => updateParams({ facility: facilityId })}
            />
          ) : (
            <FacilityTable
              facilities={facilities}
              operationalByFacility={operationalByFacility}
              selectedId={selectedId}
              page={listPage}
              pageSize={FACILITY_LIST_PAGE_SIZE}
              onPageChange={(page) => updateParams({ page: page > 1 ? String(page) : null })}
              onSelect={(facilityId) => updateParams({ facility: facilityId })}
            />
          )}
        </section>

        <aside
          className={`city-context${selected ? " city-context--selected" : ""}`}
          aria-label={selected ? "Карточка объекта" : "Очередь внимания"}
        >
          {selected ? (
            <FacilityPreview
              facility={selected}
              risks={activeRisks.filter((risk) => risk.facilityId === selected.id)}
              operationalState={
                operationalByFacility.get(selected.id) ?? {
                  state: selected.status,
                  reason: selected.statusReason,
                }
              }
              openOrderCount={workOrders.filter(
                (order) =>
                  order.target.facilityId === selected.id &&
                  !["closed", "cancelled", "draft"].includes(order.status),
              ).length}
              onClose={() => updateParams({ facility: null })}
            />
          ) : (
            <>
              <div className="context-header">
                <h2>Требуют внимания</h2>
                <StatusBadge tone="critical">{allAttentionItems.length}</StatusBadge>
              </div>
              <div className="context-scroll">
                <ul className="attention-list">
                  {attentionItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.id}>
                        <button
                          className="attention-item"
                          type="button"
                          onClick={() =>
                            updateParams({
                              q: null,
                              status: null,
                              incident: null,
                              risk: null,
                              facility: item.facilityId,
                            })
                          }
                        >
                          <span className={`attention-item__icon bg-${item.tone}`} aria-hidden="true">
                            <Icon size={18} weight="fill" />
                          </span>
                          <span>
                            <strong>{item.title}</strong>
                            <small>{item.subtitle}</small>
                          </span>
                          <span className={`attention-item__value tone-${item.tone}`}>{item.value}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {allAttentionItems.length > attentionItems.length ? (
                  <p className="muted">
                    Показаны 7 самых срочных из {allAttentionItems.length}
                  </p>
                ) : null}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

export function FacilityTable({
  facilities,
  operationalByFacility,
  selectedId,
  page,
  pageSize,
  onPageChange,
  onSelect,
}: {
  facilities: Facility[];
  operationalByFacility: Map<string, { state: FacilityOperationalState; reason: string }>;
  selectedId: string | null;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onSelect: (facilityId: string) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(facilities.length / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const rangeStart = (safePage - 1) * pageSize;
  const visibleFacilities = facilities.slice(rangeStart, rangeStart + pageSize);

  return (
    <div className="facility-table-panel">
      <div className="data-table-wrap facility-table-scroll">
        <table className="data-table">
          <caption className="data-table__caption">
            Покрытие показывает долю датчиков с любым сохранённым показанием, а не свежесть данных или текущую связь
          </caption>
          <thead>
            <tr>
              <th>Объект</th>
              <th>Статус</th>
              <th>Датчики с показанием</th>
              <th>Обновлено</th>
              <th aria-label="Действия" />
            </tr>
          </thead>
          <tbody>
            {visibleFacilities.map((facility) => {
              const operationalState = operationalByFacility.get(facility.id)?.state ?? facility.status;
              return (
                <tr key={facility.id} aria-selected={selectedId === facility.id}>
                  <td>
                    <button className="text-action" type="button" onClick={() => onSelect(facility.id)}>
                      <strong>{facility.name}</strong>
                      <small>{facility.address}</small>
                    </button>
                  </td>
                  <td>
                    <StatusBadge tone={facilityTone(operationalState)}>
                      {operationalStateLabels[operationalState]}
                    </StatusBadge>
                  </td>
                  <td className="numeric">
                    {facility.sensorAvailability === null
                      ? "Нет данных"
                      : formatPercent(facility.sensorAvailability)}
                  </td>
                  <td>{formatDateTime(facility.updatedAt)}</td>
                  <td>
                    <IconButton
                      label={`Открыть ${facility.name}`}
                      icon={<ArrowRight size={18} />}
                      onClick={() => onSelect(facility.id)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <nav className="table-pagination" aria-label="Страницы списка объектов">
        <p aria-live="polite">
          {rangeStart + 1}-{rangeStart + visibleFacilities.length} из {facilities.length}
          <span>Страница {safePage} из {pageCount}</span>
        </p>
        <div>
          <Button
            variant="secondary"
            startIcon={<CaretLeft size={18} />}
            disabled={safePage === 1}
            onClick={() => onPageChange(safePage - 1)}
          >
            Назад
          </Button>
          <Button
            variant="secondary"
            endIcon={<CaretRight size={18} />}
            disabled={safePage === pageCount}
            onClick={() => onPageChange(safePage + 1)}
          >
            Далее
          </Button>
        </div>
      </nav>
    </div>
  );
}

function FacilityPreview({
  facility,
  risks,
  operationalState,
  openOrderCount,
  onClose,
}: {
  facility: Facility;
  risks: RiskForecast[];
  operationalState: { state: FacilityOperationalState; reason: string };
  openOrderCount: number;
  onClose: () => void;
}) {
  const topRisk = risks
    .filter((risk) => ["new", "acknowledged", "confirmed"].includes(risk.status))
    .sort((first, second) => second.probability - first.probability)[0];
  return (
    <div className="facility-preview">
      <div className="context-header">
        <StatusBadge tone={facilityTone(operationalState.state)}>
          {operationalStateLabels[operationalState.state]}
        </StatusBadge>
        <IconButton label="Закрыть карточку" icon={<X size={18} />} onClick={onClose} />
      </div>
      <div className="context-scroll facility-preview__body">
        <div className="facility-preview__title">
          <Buildings size={28} weight="duotone" aria-hidden="true" />
          <div>
            <h2>{facility.name}</h2>
            <p className="muted">{facility.internalCode}</p>
          </div>
        </div>
        <p className="facility-preview__address">
          <MapPin size={18} aria-hidden="true" />
          {facility.address}
        </p>
        <dl className="definition-grid">
          <dt>Текущая ситуация</dt>
          <dd>{operationalState.reason}</dd>
          <dt>Датчики с сохранённым показанием</dt>
          <dd>
            {facility.sensorAvailability === null
              ? "Нет данных"
              : formatPercent(facility.sensorAvailability)}
          </dd>
          <dt>Открытые заявки</dt>
          <dd>{openOrderCount}</dd>
          <dt>Высший прогнозный риск</dt>
          <dd className={topRisk ? "tone-purple" : undefined}>
            {topRisk ? formatPercent(topRisk.probability) : "Не выявлен"}
          </dd>
          <dt>Последнее обновление</dt>
          <dd>{formatDateTime(facility.updatedAt)}</dd>
        </dl>
        <p className="provenance-note">
          Источник: {facility.provenance.sourceLabel}
          {facility.provenance.note ? ` · ${facility.provenance.note}` : ""}
        </p>
      </div>
      <div className="facility-preview__footer">
        <Link className="ui-button ui-button--primary ui-button--medium ui-button--full-width" to={`/facilities/${facility.id}`}>
          Открыть объект
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

const operationalStateLabels: Record<FacilityOperationalState, string> = {
  ...facilityStatusLabels,
  forecast: "Прогнозный риск",
};

function facilityTone(status: FacilityOperationalState) {
  if (status === "critical") return "critical" as const;
  if (status === "forecast") return "forecast" as const;
  if (status === "attention") return "warning" as const;
  if (status === "normal") return "success" as const;
  return "neutral" as const;
}
