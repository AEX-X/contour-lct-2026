import {
  Bank,
  ChartLineUp,
  CheckCircle,
  CurrencyRub,
  Gauge,
  Pulse,
  Warning,
} from "@phosphor-icons/react";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { KpiCard, SegmentedControl, StatusBadge } from "../shared/ui";
import {
  useDashboardMetrics,
  useFacilities,
  useRisks,
  useWorkOrders,
} from "../app/dataHooks";
import { formatDateTime, formatPercent } from "../app/labels";
import { PageError, PageLoading } from "../components/StateViews";
import { hasActiveEngineerAssignment, isRiskActiveAt } from "../domain";

type AnalyticsTab = "management" | "technical" | "finance";

const trendData = [
  { day: "15 сен", incidents: 4, risks: 13, closed: 7 },
  { day: "16 сен", incidents: 3, risks: 15, closed: 8 },
  { day: "17 сен", incidents: 5, risks: 12, closed: 10 },
  { day: "18 сен", incidents: 2, risks: 10, closed: 11 },
  { day: "19 сен", incidents: 4, risks: 9, closed: 9 },
  { day: "20 сен", incidents: 3, risks: 8, closed: 12 },
  { day: "21 сен", incidents: 2, risks: 7, closed: 13 },
];

export function AnalyticsPage() {
  const [tab, setTab] = useState<AnalyticsTab>("management");
  const metricsQuery = useDashboardMetrics();
  const facilitiesQuery = useFacilities();
  const risksQuery = useRisks();
  const ordersQuery = useWorkOrders();

  if (
    metricsQuery.isPending ||
    facilitiesQuery.isPending ||
    risksQuery.isPending ||
    ordersQuery.isPending
  ) {
    return <PageLoading label="Рассчитываем аналитическую сводку" />;
  }
  if (
    metricsQuery.isError ||
    facilitiesQuery.isError ||
    risksQuery.isError ||
    ordersQuery.isError
  ) {
    return <PageError onRetry={() => void Promise.all([
      metricsQuery.refetch(),
      facilitiesQuery.refetch(),
      risksQuery.refetch(),
      ordersQuery.refetch(),
    ])} />;
  }

  const metrics = new Map(metricsQuery.data.map((metric) => [metric.code, metric]));
  const facilities = facilitiesQuery.data;
  const risks = risksQuery.data;
  const orders = ordersQuery.data;
  const scenarioNow = metricsQuery.data[0]?.updatedAt ?? "";
  const facilitiesWithTelemetry = facilities.filter((facility) => facility.sensorAvailability !== null);
  const averageTelemetryAvailability = facilitiesWithTelemetry.length
    ? facilitiesWithTelemetry.reduce((sum, facility) => sum + facility.sensorAvailability!, 0)
      / facilitiesWithTelemetry.length
    : null;
  const facilityComparison = facilities.slice(0, 7).map((facility) => ({
    name: facility.name.replace("Объект ", "№"),
    readiness: facility.sensorAvailability === null
      ? null
      : Math.round(facility.sensorAvailability * 100),
    orders: orders.filter(
      (order) =>
        order.target.facilityId === facility.id &&
        !["draft", "closed", "cancelled"].includes(order.status),
    ).length,
  }));

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Аналитика руководителя</h1>
          <p className="page-header__meta">
            Управленческие, технические и финансовые показатели всей городской сети
          </p>
        </div>
        <StatusBadge tone="forecast">Синтетический демо-сценарий</StatusBadge>
      </header>

      <SegmentedControl
        label="Раздел аналитики"
        value={tab}
        onChange={(value) => setTab(value as AnalyticsTab)}
        items={[
          { value: "management", label: "Управленческие", icon: <ChartLineUp size={18} /> },
          { value: "technical", label: "Технические", icon: <Gauge size={18} /> },
          { value: "finance", label: "Финансовые", icon: <CurrencyRub size={18} /> },
        ]}
      />

      {tab === "management" ? (
        <div className="content-stack" style={{ marginTop: 16 }}>
          <div className="kpi-grid">
            <KpiCard
              label={metrics.get("critical_incidents_now")?.label ?? "Критические объекты"}
              value={metrics.get("critical_incidents_now")?.value ?? 0}
              icon={Warning}
              tone="critical"
              detail="с открытым критическим инцидентом"
            />
            <KpiCard
              label="Открытые заявки"
              value={metrics.get("open_work_orders")?.value ?? 0}
              icon={Pulse}
              tone="info"
              detail="в текущем контуре"
            />
            <KpiCard
              label="Закрыто за 24 часа"
              value={metrics.get("closed_work_orders_24h")?.value ?? 0}
              icon={CheckCircle}
              tone="success"
              detail="по времени демо-сценария"
            />
          </div>

          <div className="split-layout analytics-layout">
            <section className="surface">
              <header className="surface__header">
                <div>
                  <h2>Динамика событий и работ</h2>
                  <p className="page-header__meta">Статичный демонстрационный ряд за 15-21 сентября</p>
                </div>
              </header>
              <div className="surface__body chart-frame" aria-hidden="true">
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                    <defs>
                      <linearGradient id="riskFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.24} />
                        <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e7ecf3" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 8, borderColor: "#d8e1ed" }} />
                    <Legend />
                    <Area type="monotone" name="Высокие риски" dataKey="risks" stroke="#7c3aed" fill="url(#riskFill)" strokeWidth={2} />
                    <Area type="monotone" name="Закрыто заявок" dataKey="closed" stroke="#20aa60" fill="transparent" strokeWidth={2} />
                    <Area type="monotone" name="Инциденты" dataKey="incidents" stroke="#d7263d" fill="transparent" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="surface__body chart-data-companion">
                <p>Этот сценарный ряд не пересчитывается после действий в текущей сессии. Актуальные значения показываются в KPI выше, точные точки ряда доступны в таблице</p>
                <details className="data-table-details">
                  <summary>Показать данные графика</summary>
                  <div className="table-scroll"><table><thead><tr><th>День</th><th>Высокие риски</th><th>Закрыто заявок</th><th>Инциденты</th></tr></thead><tbody>{trendData.map((row) => <tr key={row.day}><td>{row.day}</td><td>{row.risks}</td><td>{row.closed}</td><td>{row.incidents}</td></tr>)}</tbody></table></div>
                </details>
              </div>
            </section>

            <section className="surface">
              <header className="surface__header">
                <div>
                  <h2>Решения руководителя</h2>
                  <p className="page-header__meta">Показатели, требующие контроля</p>
                </div>
              </header>
              <div className="surface__body">
                <dl className="definition-grid">
                  <dt>Критические объекты</dt>
                  <dd>{metrics.get("critical_incidents_now")?.value ?? 0}</dd>
                  <dt>Высокие риски без заявки</dt>
                  <dd className="tone-purple">{metrics.get("high_risks_without_action")?.value ?? 0}</dd>
                  <dt>Нарушения SLA</dt>
                  <dd className="tone-warning">{metrics.get("overdue_work_orders")?.value ?? 0}</dd>
                  <dt>Объекты без актуальных данных</dt>
                  <dd>{facilities.filter((item) => item.status === "no_data").length}</dd>
                  <dt>Распределено инженерам</dt>
                  <dd>{orders.filter(hasActiveEngineerAssignment).length}</dd>
                </dl>
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {tab === "technical" ? (
        <div className="content-stack" style={{ marginTop: 16 }}>
          <div className="kpi-grid">
            <KpiCard
              label="Доступность телеметрии"
              value={averageTelemetryAvailability === null
                ? "Нет данных"
                : formatPercent(averageTelemetryAvailability)}
              icon={Gauge}
              tone={averageTelemetryAvailability === null ? "neutral" : "success"}
              detail="по объектам с данными"
            />
            <KpiCard
              label="Активные прогнозы"
              value={risks.filter(
                (risk) => ["new", "acknowledged"].includes(risk.status) && isRiskActiveAt(risk, scenarioNow),
              ).length}
              icon={Pulse}
              tone="forecast"
              detail="демонстрационные прогнозы"
            />
            <KpiCard
              label="Объекты без данных"
              value={facilities.filter((item) => item.status === "no_data").length}
              icon={Warning}
              tone="neutral"
              detail="нужна проверка источника"
            />
          </div>
          <div className="split-layout analytics-compare-layout">
            <section className="surface">
              <header className="surface__header">
                <div>
                  <h2>Доступность телеметрии</h2>
                  <p className="page-header__meta">Отдельная процентная шкала 0-100%</p>
                </div>
              </header>
              <div className="surface__body chart-frame" aria-hidden="true">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={facilityComparison} margin={{ top: 8, right: 10, left: -8, bottom: 4 }}>
                    <CartesianGrid stroke="#e7ecf3" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tickFormatter={(value: number) => `${value}%`} tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(value) => [`${String(value)}%`, "Доступность"]} contentStyle={{ borderRadius: 8, borderColor: "#d8e1ed" }} />
                    <Bar dataKey="readiness" name="Доступность" fill="#2467e8" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="surface">
              <header className="surface__header">
                <div>
                  <h2>Нагрузка по заявкам</h2>
                  <p className="page-header__meta">Количество открытых заявок по объектам</p>
                </div>
              </header>
              <div className="surface__body chart-frame" aria-hidden="true">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={facilityComparison} margin={{ top: 8, right: 10, left: -8, bottom: 4 }}>
                    <CartesianGrid stroke="#e7ecf3" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 8, borderColor: "#d8e1ed" }} />
                    <Bar dataKey="orders" name="Открытые заявки" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          <section className="surface">
            <header className="surface__header">
              <div>
                <h2>Точные значения по объектам</h2>
                <p className="page-header__meta">Проценты и количество заявок не смешиваются на одной шкале</p>
              </div>
            </header>
            <div className="surface__body chart-data-companion">
              <div className="table-scroll"><table><thead><tr><th>Объект</th><th>Доступность, %</th><th>Открытые заявки</th></tr></thead><tbody>{facilityComparison.map((row) => <tr key={row.name}><td>{row.name}</td><td>{row.readiness ?? "Нет данных"}</td><td>{row.orders}</td></tr>)}</tbody></table></div>
            </div>
          </section>
        </div>
      ) : null}

      {tab === "finance" ? (
        <div className="content-stack" style={{ marginTop: 16 }}>
          <div className="kpi-grid">
            <KpiCard label="Бюджет обслуживания" value="Нет данных" icon={Bank} tone="neutral" detail="источник не подключён" />
            <KpiCard label="Фактические затраты" value="Нет данных" icon={CurrencyRub} tone="neutral" detail="источник не подключён" />
            <KpiCard label="Стоимость предотвращённых аварий" value="Нет методики" icon={ChartLineUp} tone="neutral" detail="требуется согласованный расчёт" />
          </div>
          <InlineFinanceNote />
          <section className="surface">
            <header className="surface__header">
              <div>
                <h2>Что будет доступно после интеграции</h2>
                <p className="page-header__meta">Контракт на финансовые данные ещё не предоставлен</p>
              </div>
            </header>
            <div className="surface__body">
              <div className="metric-strip">
                <div className="metric-strip__item">
                  <span className="metric-strip__value">-</span>
                  <span className="metric-strip__label">план против факта</span>
                </div>
                <div className="metric-strip__item">
                  <span className="metric-strip__value">-</span>
                  <span className="metric-strip__label">стоимость по объектам</span>
                </div>
                <div className="metric-strip__item">
                  <span className="metric-strip__value">-</span>
                  <span className="metric-strip__label">запчасти и трудозатраты</span>
                </div>
                <div className="metric-strip__item">
                  <span className="metric-strip__value">-</span>
                  <span className="metric-strip__label">эффект предотвращения</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      <p className="provenance-note" style={{ marginTop: 16 }}>
        Показатели обновлены {formatDateTime(metricsQuery.data[0]?.updatedAt)}. Все значения в прототипе синтетические
      </p>
    </div>
  );
}

function InlineFinanceNote() {
  return (
    <div className="ui-inline-alert ui-inline-alert--info" role="status">
      <CurrencyRub className="ui-inline-alert__icon" size={22} />
      <div className="ui-inline-alert__content">
        <p className="ui-inline-alert__title">Финансовые показатели не выдуманы</p>
        <div className="ui-inline-alert__body">
          До подключения бюджета, смет и утверждённой методики интерфейс честно показывает отсутствие данных
        </div>
      </div>
    </div>
  );
}
