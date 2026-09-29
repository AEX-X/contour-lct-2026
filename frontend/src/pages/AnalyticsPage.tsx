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
import { Button, InlineAlert, KpiCard, SegmentedControl, StatusBadge } from "../shared/ui";
import {
  useDashboardMetrics,
  useFacilities,
  useModelQuality,
  useRisks,
  useWorkOrders,
} from "../app/dataHooks";
import { formatDateTime, formatPercent } from "../app/labels";
import { PageError, PageLoading } from "../components/StateViews";
import { hasActiveEngineerAssignment, isRiskActiveAt } from "../domain";
import type { ModelQualityReport } from "../domain";
import { useContour } from "../app/ContourProvider";
import { RiskReportExport } from "../components/RiskReportExport";

type AnalyticsTab = "management" | "technical" | "model_quality" | "finance";

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
  const { currentUser, repository, runtime } = useContour();
  const [tab, setTab] = useState<AnalyticsTab>("management");
  const canReadModelQuality = currentUser.permissions.includes("analytics.technical.read") && Boolean(repository.getModelQuality);
  const canReadFinance = currentUser.permissions.includes("analytics.economy.read");
  const metricsQuery = useDashboardMetrics();
  const facilitiesQuery = useFacilities();
  const risksQuery = useRisks();
  const ordersQuery = useWorkOrders();
  const modelQualityQuery = useModelQuality(tab === "model_quality" && canReadModelQuality);

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
  const historicalDemoRisk = risks.find((risk) => risk.demoClock && risk.modelAsOf);
  const scenarioNow = metricsQuery.data[0]?.updatedAt ?? "";
  const facilitiesWithReadingCoverage = facilities.filter((facility) => facility.sensorAvailability !== null);
  const averageReadingCoverage = facilitiesWithReadingCoverage.length
    ? facilitiesWithReadingCoverage.reduce((sum, facility) => sum + facility.sensorAvailability!, 0)
      / facilitiesWithReadingCoverage.length
    : null;
  const facilityComparison = facilities.slice(0, 7).map((facility) => ({
    name: facility.name.replace("Объект ", "№"),
    coverage: facility.sensorAvailability === null
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
          <h1>{currentUser.role === "manager" ? "Аналитика руководителя" : "Операционная аналитика"}</h1>
          <p className="page-header__meta">
            {currentUser.role === "manager"
              ? "Управленческие, технические и финансовые показатели всей городской сети"
              : "Управленческие и технические показатели доступной эксплуатационной зоны"}
          </p>
        </div>
        <div className="page-actions">
          <RiskReportExport />
          <StatusBadge tone="forecast">{runtime.mode === "api" ? "Backend API" : "Синтетический демо-сценарий"}</StatusBadge>
        </div>
      </header>

      {historicalDemoRisk ? (
        <InlineAlert tone="warning" title="Исторический ML-демо">
          Технические прогнозы относятся к модельному срезу {formatDateTime(historicalDemoRisk.modelAsOf)}.
          Управленческие показатели заявок и SLA считаются в текущем операционном времени
        </InlineAlert>
      ) : null}

      <SegmentedControl
        label="Раздел аналитики"
        value={tab}
        onChange={(value) => setTab(value as AnalyticsTab)}
        items={[
          { value: "management", label: "Управленческие", icon: <ChartLineUp size={18} /> },
          { value: "technical", label: "Технические", icon: <Gauge size={18} /> },
          ...(canReadModelQuality ? [{ value: "model_quality", label: "Качество модели", icon: <Pulse size={18} /> }] : []),
          ...(canReadFinance ? [{ value: "finance", label: "Финансовые", icon: <CurrencyRub size={18} /> }] : []),
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
              detail={runtime.mode === "api" ? "по данным backend" : "по времени демо-сценария"}
            />
          </div>

          <div className="split-layout analytics-layout">
            <section className="surface">
              <header className="surface__header">
                <div>
                  <h2>Динамика событий и работ</h2>
                  <p className="page-header__meta">
                    {runtime.mode === "api" ? "Текущий операционный срез по данным API" : "Статичный демонстрационный ряд за 15-21 сентября"}
                  </p>
                </div>
              </header>
              {runtime.mode === "mock" ? <><div className="surface__body chart-frame" aria-hidden="true">
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
              </div></> : <div className="surface__body">
                <p className="muted">Текущие KPI выше рассчитаны по API. Временной ряд не подменяется демонстрационными точками</p>
              </div>}
            </section>

            <section className="surface">
              <header className="surface__header">
                <div>
                  <h2>{currentUser.role === "manager" ? "Решения руководителя" : "Операционный контроль"}</h2>
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
              label="Датчики с сохранённым показанием"
              value={averageReadingCoverage === null
                ? "Нет данных"
                : formatPercent(averageReadingCoverage)}
              icon={Gauge}
              tone={averageReadingCoverage === null ? "neutral" : "info"}
              detail="средняя доля по объектам, не свежесть потока"
            />
            <KpiCard
              label="Активные прогнозы"
              value={risks.filter(
                (risk) => ["new", "acknowledged"].includes(risk.status) && isRiskActiveAt(risk, scenarioNow),
              ).length}
              icon={Pulse}
              tone="forecast"
              detail={runtime.mode === "api" ? "прогнозы backend" : "демонстрационные прогнозы"}
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
                  <h2>Покрытие последними показаниями</h2>
                  <p className="page-header__meta">Доля датчиков с любым сохранённым показанием. Не отражает свежесть или текущую связь</p>
                </div>
              </header>
              <div className="surface__body chart-frame" aria-hidden="true">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={facilityComparison} margin={{ top: 8, right: 10, left: -8, bottom: 4 }}>
                    <CartesianGrid stroke="#e7ecf3" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tickFormatter={(value: number) => `${value}%`} tick={{ fill: "#66758f", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(value) => [`${String(value)}%`, "Покрытие"]} contentStyle={{ borderRadius: 8, borderColor: "#d8e1ed" }} />
                    <Bar dataKey="coverage" name="Покрытие" fill="#2467e8" radius={[4, 4, 0, 0]} />
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
              <div className="table-scroll"><table><thead><tr><th>Объект</th><th>С показанием, %</th><th>Открытые заявки</th></tr></thead><tbody>{facilityComparison.map((row) => <tr key={row.name}><td>{row.name}</td><td>{row.coverage ?? "Нет данных"}</td><td>{row.orders}</td></tr>)}</tbody></table></div>
            </div>
          </section>
        </div>
      ) : null}

      {tab === "model_quality" && canReadModelQuality ? (
        <ModelQualitySection
          report={modelQualityQuery.data}
          loading={modelQualityQuery.isPending}
          error={modelQualityQuery.isError
            ? modelQualityQuery.error instanceof Error
              ? modelQualityQuery.error.message
              : "Метрики качества модели недоступны"
            : null}
          onRetry={() => void modelQualityQuery.refetch()}
        />
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
        Показатели обновлены {formatDateTime(metricsQuery.data[0]?.updatedAt)}. Источник: {runtime.mode === "api" ? "расчёт по данным backend" : "синтетический сценарий Contour"}
      </p>
    </div>
  );
}

function detailedPercent(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function modelQualitySourceLabel(source: string) {
  if (source === "ml_service") return "ML-сервис";
  if (source === "file") return "Файл метрик в backend";
  return source;
}

function ModelQualitySection({
  report,
  loading,
  error,
  onRetry,
}: {
  report?: ModelQualityReport;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (loading) return <PageLoading label="Загружаем проверку качества моделей" />;
  if (error || !report) {
    return (
      <div className="content-stack" style={{ marginTop: 16 }}>
        <InlineAlert
          tone="warning"
          title="Метрики качества модели недоступны"
          action={<Button variant="secondary" onClick={onRetry}>Повторить запрос</Button>}
        >
          {error ?? "Backend не вернул ни ответ ML-сервиса, ни резервный файл метрик"}
        </InlineAlert>
      </div>
    );
  }

  return (
    <div className="content-stack model-quality" style={{ marginTop: 16 }}>
      <InlineAlert tone="info" title="Что означают показатели">
        Precision показывает долю верных предупреждений среди всех предупреждений модели. Recall показывает долю найденных событий среди всех фактически произошедших. Метрики рассчитаны ML-командой на тестовой выборке 2026 года
      </InlineAlert>
      {report.models.map((model) => {
        const precisionGain = model.ruleBaseline
          ? (model.total.precision - model.ruleBaseline.precision) * 100
          : null;
        const recallGain = model.ruleBaseline
          ? (model.total.recall - model.ruleBaseline.recall) * 100
          : null;
        return (
          <section className="surface" key={model.id}>
            <header className="surface__header">
              <div>
                <h2>{model.displayName}</h2>
                <p className="page-header__meta">Тестовая проверка устойчивости по месяцам 2026 года</p>
              </div>
              <StatusBadge tone="info">Источник: {modelQualitySourceLabel(report.source)}</StatusBadge>
            </header>
            <div className="surface__body content-stack">
              <div className="model-quality__metrics">
                <article>
                  <span>Precision</span>
                  <strong>{detailedPercent(model.total.precision)}</strong>
                  <small>точность предупреждений</small>
                </article>
                <article>
                  <span>Recall</span>
                  <strong>{detailedPercent(model.total.recall)}</strong>
                  <small>полнота обнаружения</small>
                </article>
                <article>
                  <span>F1</span>
                  <strong>{detailedPercent(model.total.f1)}</strong>
                  <small>баланс точности и полноты</small>
                </article>
                <article>
                  <span>Объектов под предупреждением в сутки</span>
                  <strong>{model.alertsPerDay ? model.alertsPerDay.mean.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "Нет данных"}</strong>
                  <small>{model.alertsPerDay ? `медиана ${model.alertsPerDay.median}, максимум ${model.alertsPerDay.max}` : "метрика не опубликована"}</small>
                </article>
              </div>
              {model.ruleBaseline ? (
                <InlineAlert tone="success" title="Сравнение с правилом alarm за 24 часа">
                  Precision модели {precisionGain !== null && precisionGain >= 0 ? "выше" : "ниже"} на {Math.abs(precisionGain ?? 0).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} п.п., recall {recallGain !== null && recallGain >= 0 ? "выше" : "ниже"} на {Math.abs(recallGain ?? 0).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} п.п.
                </InlineAlert>
              ) : null}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Месяц</th>
                      <th>Precision</th>
                      <th>Recall</th>
                      <th>F1</th>
                      <th>Предупреждений</th>
                      <th>Строк теста</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.months.map(({ month, metrics }) => (
                      <tr key={month}>
                        <td>{new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`))}</td>
                        <td>{detailedPercent(metrics.precision)}</td>
                        <td>{detailedPercent(metrics.recall)}</td>
                        <td>{detailedPercent(metrics.f1)}</td>
                        <td>{metrics.alerts.toLocaleString("ru-RU")}</td>
                        <td>{metrics.rows.toLocaleString("ru-RU")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="provenance-note">
                Всего строк теста: {model.total.rows.toLocaleString("ru-RU")}. Базовая частота события: {detailedPercent(model.total.baseRate)}
              </p>
            </div>
          </section>
        );
      })}
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
