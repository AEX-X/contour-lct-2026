import {
  Broadcast,
  ChartLineUp,
  Cpu,
  Wrench,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  isRiskActiveAt,
  type Equipment,
  type Facility,
  type HierarchyNode,
  type RiskForecast,
  type Sensor,
  type WorkOrder,
  type WorkOrderTarget,
} from "../domain";
import { formatDateTime, formatPercent, pluralizeRu, statusLabels } from "../app/labels";
import { EmptyState } from "../components/StateViews";
import { Button, Modal, StatusBadge } from "../shared/ui";

type InspectableAsset =
  | { type: "equipment"; value: Equipment }
  | { type: "sensor"; value: Sensor };

type PlanNode =
  | { type: "equipment"; value: Equipment; position: HierarchyNode["planPosition"]; offset: number }
  | { type: "sensor"; value: Sensor; position: HierarchyNode["planPosition"]; offset: number };

function asInspectableAsset(node: PlanNode): InspectableAsset {
  return node.type === "sensor"
    ? { type: "sensor", value: node.value }
    : { type: "equipment", value: node.value };
}

interface FacilitySectionProps {
  facility: Facility;
  hierarchy: HierarchyNode[];
  equipment: Equipment[];
  sensors: Sensor[];
  risks: RiskForecast[];
  orders: WorkOrder[];
  canCreate: boolean;
  onCreateForTarget: (target: WorkOrderTarget) => void;
  targets: WorkOrderTarget[];
  asOf?: string;
}

export function FacilityPlanSection({
  facility,
  hierarchy,
  equipment,
  sensors,
  orders,
  canCreate,
  onCreateForTarget,
  targets,
}: FacilitySectionProps) {
  const [selected, setSelected] = useState<InspectableAsset | null>(null);
  const nodes = useMemo<PlanNode[]>(() => {
    const withPosition = (hierarchyNodeId: string) =>
      hierarchy.find((node) => node.id === hierarchyNodeId)?.planPosition ?? null;
    return [
      ...equipment.map((value, index) => ({
        type: "equipment" as const,
        value,
        position: withPosition(value.hierarchyNodeId),
        offset: index,
      })),
      ...sensors.map((value, index) => ({
        type: "sensor" as const,
        value,
        position: withPosition(value.hierarchyNodeId),
        offset: index,
      })),
    ];
  }, [equipment, hierarchy, sensors]);
  const positioned = nodes.filter((node) => node.position);

  return (
    <>
      <section className="surface facility-plan-card" aria-labelledby="facility-plan-title">
        <header className="surface__header">
          <div>
            <h2 id="facility-plan-title">План и датчики</h2>
            <p className="page-header__meta">Демонстрационная схема расположения оборудования на объекте</p>
          </div>
          <StatusBadge tone={positioned.length ? "info" : "neutral"}>
            {positioned.length} на плане
          </StatusBadge>
        </header>
        <div className="surface__body">
          {positioned.length ? (
            <div className="facility-plan" role="group" aria-label={`Интерактивная схема объекта ${facility.name}. Узлов: ${positioned.length}`}>
              <div className="facility-plan__corridor facility-plan__corridor--main" aria-hidden="true" />
              <div className="facility-plan__corridor facility-plan__corridor--branch" aria-hidden="true" />
              <span className="facility-plan__label facility-plan__label--entry">Вход</span>
              <span className="facility-plan__label facility-plan__label--section">Участок 1.2</span>
              {positioned.map((node) => {
                const x = Math.min(92, Math.max(8, (node.position?.x ?? 50) + (node.type === "sensor" ? (node.offset % 3) * 4 - 4 : 0)));
                const y = Math.min(88, Math.max(12, (node.position?.y ?? 50) + (node.type === "sensor" ? (node.offset % 2) * 7 - 3 : 0)));
                const tone = node.type === "sensor" ? sensorTone(node.value.status) : equipmentTone(node.value.status);
                return (
                  <button
                    className="facility-plan__node"
                    data-tone={tone}
                    key={`${node.type}:${node.value.id}`}
                    style={{ left: `${x}%`, top: `${y}%` }}
                    type="button"
                    aria-label={`${node.value.name}. ${node.type === "sensor" ? sensorStatus(node.value.status) : equipmentStatus(node.value.status)}`}
                    onClick={() => setSelected(asInspectableAsset(node))}
                  >
                    {node.type === "sensor" ? <Broadcast size={17} aria-hidden="true" /> : <Cpu size={17} aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="Схема объекта не загружена"
              description="Используй интерактивный реестр ниже. Координаты появятся после подключения плана"
            />
          )}
        </div>
      </section>

      <section className="surface" aria-labelledby="asset-registry-title">
        <header className="surface__header">
          <div>
            <h2 id="asset-registry-title">Реестр оборудования</h2>
            <p className="page-header__meta">Открой карточку узла для показаний, порогов и истории работ</p>
          </div>
        </header>
        <div className="surface__body surface__body--flush">
          {nodes.length ? (
            <ul className="hierarchy-list">
              {nodes.map((node) => (
                <li key={`${node.type}:${node.value.id}`}>
                  <button
                    className="hierarchy-item hierarchy-item--button"
                    type="button"
                    onClick={() => setSelected(asInspectableAsset(node))}
                  >
                    <span className="hierarchy-item__icon" aria-hidden="true">
                      {node.type === "sensor" ? <Broadcast size={19} /> : <Cpu size={19} />}
                    </span>
                    <span>
                      <strong>{node.value.name}</strong>
                      <small className="muted">
                        {node.type === "sensor"
                          ? `${node.value.lastReading?.value ?? "Нет данных"} ${node.value.unit}`
                          : node.value.model ?? "Модель не указана"}
                      </small>
                    </span>
                    <StatusBadge tone={node.type === "sensor" ? sensorTone(node.value.status) : equipmentTone(node.value.status)}>
                      {node.type === "sensor" ? sensorStatus(node.value.status) : equipmentStatus(node.value.status)}
                    </StatusBadge>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Реестр пока пуст" description="Оборудование появится после синхронизации с реестром ОЭ" />
          )}
        </div>
      </section>

      <AssetDetailsModal
        asset={selected}
        hierarchy={hierarchy}
        orders={orders}
        equipment={equipment}
        canCreate={canCreate}
        onClose={() => setSelected(null)}
        onCreate={() => {
          if (!selected) return;
          const target = targets.find((item) => item.type === selected.type && item.id === selected.value.id);
          if (target) {
            setSelected(null);
            onCreateForTarget(target);
          }
        }}
      />
    </>
  );
}

function AssetDetailsModal({
  asset,
  hierarchy,
  orders,
  equipment,
  canCreate,
  onClose,
  onCreate,
}: {
  asset: InspectableAsset | null;
  hierarchy: HierarchyNode[];
  orders: WorkOrder[];
  equipment: Equipment[];
  canCreate: boolean;
  onClose: () => void;
  onCreate: () => void;
}) {
  if (!asset) return null;
  const node = hierarchy.find((item) => item.id === asset.value.hierarchyNodeId);
  const relatedOrders = orders.filter((order) =>
    order.target.id === asset.value.id || order.affectedTargets.some((target) => target.id === asset.value.id),
  );
  const linkedEquipment = asset.type === "sensor"
    ? equipment.find((item) => item.id === asset.value.equipmentId)
    : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={asset.value.name}
      description={node?.path.join(" / ") ?? "Расположение в иерархии не указано"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Закрыть</Button>
          {canCreate ? <Button startIcon={<Wrench size={18} />} onClick={onCreate}>Создать заявку</Button> : null}
        </>
      }
    >
      <div className="asset-details">
        <div className="asset-details__status">
          <StatusBadge tone={asset.type === "sensor" ? sensorTone(asset.value.status) : equipmentTone(asset.value.status)}>
            {asset.type === "sensor" ? sensorStatus(asset.value.status) : equipmentStatus(asset.value.status)}
          </StatusBadge>
          <span className="muted">ID: {asset.value.id}</span>
        </div>
        <dl className="definition-grid definition-grid--stable">
          {asset.type === "equipment" ? (
            <>
              <dt>Модель</dt><dd>{asset.value.model ?? "Не указана"}</dd>
              <dt>Серийный номер</dt><dd>{asset.value.serialNumber ?? "Не указан"}</dd>
              <dt>Ввод в эксплуатацию</dt><dd>{formatDateTime(asset.value.commissionedAt)}</dd>
              <dt>Последнее ТО</dt><dd>{formatDateTime(asset.value.lastMaintenanceAt)}</dd>
            </>
          ) : (
            <>
              <dt>Текущее показание</dt><dd>{asset.value.lastReading ? `${asset.value.lastReading.value} ${asset.value.unit}` : "Нет данных"}</dd>
              <dt>Порог внимания</dt><dd>{asset.value.warningThreshold === null ? "Не задан" : `${asset.value.warningThreshold} ${asset.value.unit}`}</dd>
              <dt>Аварийный порог</dt><dd>{asset.value.alarmThreshold === null ? "Не задан" : `${asset.value.alarmThreshold} ${asset.value.unit}`}</dd>
              <dt>Качество данных</dt><dd>{asset.value.lastReading ? readingQuality(asset.value.lastReading.quality) : "Нет данных"}</dd>
              <dt>Связано с</dt><dd>{linkedEquipment?.name ?? "Самостоятельный датчик"}</dd>
              <dt>Обновлено</dt><dd>{formatDateTime(asset.value.updatedAt)}</dd>
            </>
          )}
        </dl>
        <div>
          <h3>История заявок</h3>
          {relatedOrders.length ? (
            <ul className="plain-list asset-order-list">
              {relatedOrders.slice(0, 5).map((order) => (
                <li key={order.id}>
                  <Link to={`/work-orders/${order.id}`} onClick={onClose}>
                    <strong>{order.number}</strong>
                    <span>{statusLabels[order.status]} · {formatDateTime(order.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <p className="muted">Связанных ремонтов и неисправностей пока нет</p>}
        </div>
      </div>
    </Modal>
  );
}

export function FacilityAnalyticsSection({ facility, sensors, risks, orders, asOf = "" }: FacilitySectionProps) {
  const activeRisks = risks.filter((risk) => isRiskActiveAt(risk, asOf));
  const troubledSensors = sensors.filter((sensor) => sensor.status !== "normal");
  const openOrders = orders.filter((order) => !["draft", "closed", "cancelled"].includes(order.status));
  const slaAtRisk = openOrders.filter((order) => order.sla && ["at_risk", "breached"].includes(order.sla.state));
  const telemetryGroups = sensors
    .map((sensor) => {
      const points = [...sensor.readings]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .slice(-8);
      return {
        sensor: sensor.name,
        unit: sensor.unit,
        points,
        maximum: Math.max(...points.map((point) => Math.abs(point.value)), 1),
      };
    })
    .filter((group) => group.points.length > 0);
  const recentPoints = telemetryGroups
    .flatMap((group) => group.points.map((reading) => ({ ...reading, sensor: group.sensor, unit: group.unit })))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-24);

  return (
    <div className="content-stack">
      <section className="analytics-kpi-grid" aria-label="Аналитика объекта">
        <article className="metric-card"><span>Доступность телеметрии</span><strong>{facility.sensorAvailability === null ? "Нет данных" : formatPercent(facility.sensorAvailability)}</strong><small>агрегированный показатель СМВУ</small></article>
        <article className="metric-card"><span>Активные риски</span><strong>{activeRisks.length}</strong><small>{activeRisks.filter((risk) => risk.severity === "critical").length} критических</small></article>
        <article className="metric-card"><span>Датчики с отклонениями</span><strong>{troubledSensors.length}</strong><small>из {sensors.length || "не загружено"}</small></article>
        <article className="metric-card"><span>SLA требует внимания</span><strong>{slaAtRisk.length}</strong><small>из {openOrders.length} {pluralizeRu(openOrders.length, ["открытой заявки", "открытых заявок", "открытых заявок"])}</small></article>
      </section>

      <section className="surface" aria-labelledby="telemetry-trend-title">
        <header className="surface__header">
          <div>
            <h2 id="telemetry-trend-title">Последние показания</h2>
            <p className="page-header__meta">Отдельная шкала для каждого датчика и единицы измерения</p>
          </div>
          <ChartLineUp size={24} aria-hidden="true" />
        </header>
        <div className="surface__body">
          {recentPoints.length ? (
            <>
              <p className="analytics-summary">Показано {telemetryGroups.length} независимых рядов. Высота столбца сравнима только внутри своего ряда</p>
              <div className="telemetry-series-list">
                {telemetryGroups.map((group) => (
                  <article className="telemetry-series" key={`${group.sensor}:${group.unit}`}>
                    <header><strong>{group.sensor}</strong><span>{group.points.at(-1)?.value} {group.unit}</span></header>
                    <div className="telemetry-bars" aria-hidden="true">
                      {group.points.map((point, index) => (
                        <span key={`${group.sensor}:${point.at}:${index}`} style={{ height: `${Math.max(12, Math.abs(point.value) / group.maximum * 100)}%` }} />
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              <details className="data-table-details">
                <summary>Показать точные значения</summary>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Время</th><th>Датчик</th><th>Значение</th><th>Качество</th></tr></thead>
                    <tbody>
                      {recentPoints.map((point, index) => (
                        <tr key={`${point.sensor}:${point.at}:row:${index}`}>
                          <td>{formatDateTime(point.at)}</td><td>{point.sensor}</td><td>{point.value} {point.unit}</td><td>{readingQuality(point.quality)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          ) : <EmptyState title="Нет телеметрии для тренда" description="Раздел заполнится после подключения потоковых показаний" />}
        </div>
      </section>

      <section className="surface" aria-labelledby="risk-distribution-title">
        <header className="surface__header"><h2 id="risk-distribution-title">Контур риска и работ</h2></header>
        <div className="surface__body analytics-distribution">
          <DistributionRow label="Критические риски" value={activeRisks.filter((risk) => risk.severity === "critical").length} total={activeRisks.length} tone="critical" />
          <DistributionRow label="Датчики требуют внимания" value={troubledSensors.length} total={sensors.length} tone="warning" />
          <DistributionRow label="Заявки под риском SLA" value={slaAtRisk.length} total={openOrders.length} tone="forecast" />
        </div>
      </section>
    </div>
  );
}

export function FacilityOrdersSection({ orders }: Pick<FacilitySectionProps, "orders">) {
  const sorted = [...orders].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return (
    <section className="surface" aria-labelledby="facility-orders-title">
      <header className="surface__header">
        <div><h2 id="facility-orders-title">Заявки объекта</h2><p className="page-header__meta">Полный журнал текущих и завершённых работ</p></div>
        <StatusBadge tone="info">{orders.length}</StatusBadge>
      </header>
      <div className="surface__body surface__body--flush">
        {sorted.length ? (
          <ul className="plain-list facility-order-list">
            {sorted.map((order) => (
              <li key={order.id}>
                <Link className="attention-item" to={`/work-orders/${order.id}`}>
                  <span className="attention-item__icon bg-warning" aria-hidden="true"><Wrench size={18} /></span>
                  <span><strong>{order.number}</strong><small>{order.target.displayName} · {formatDateTime(order.updatedAt)}</small></span>
                  <StatusBadge tone={order.status === "closed" ? "success" : "info"}>{statusLabels[order.status]}</StatusBadge>
                </Link>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="Заявок пока нет" description="Новая заявка появится здесь после регистрации" />}
      </div>
    </section>
  );
}

function DistributionRow({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const hasData = total > 0;
  const percent = hasData ? Math.round(value / total * 100) : 0;
  return (
    <div className="distribution-row">
      <div><strong>{label}</strong><span>{hasData ? `${value} из ${total}` : "Нет данных"}</span></div>
      <div className="distribution-row__track" aria-label={`${label}: ${hasData ? `${value} из ${total}` : "нет данных"}`} role={hasData ? "progressbar" : undefined} aria-valuemin={hasData ? 0 : undefined} aria-valuemax={hasData ? total : undefined} aria-valuenow={hasData ? value : undefined}>
        <span data-tone={tone} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function readingQuality(value: Sensor["lastReading"] extends infer _ ? "good" | "uncertain" | "bad" : never) {
  return { good: "Хорошее", uncertain: "Сомнительное", bad: "Плохое" }[value];
}

function sensorStatus(status: Sensor["status"]) {
  return { normal: "Норма", attention: "Внимание", alarm: "Тревога", offline: "Нет связи" }[status];
}

function sensorTone(status: Sensor["status"]) {
  if (status === "alarm") return "critical" as const;
  if (status === "attention" || status === "offline") return "warning" as const;
  return "success" as const;
}

function equipmentStatus(status: Equipment["status"]) {
  return { operational: "Работает", attention: "Внимание", fault: "Неисправно", unknown: "Нет данных" }[status];
}

function equipmentTone(status: Equipment["status"]) {
  if (status === "fault") return "critical" as const;
  if (status === "attention") return "warning" as const;
  if (status === "operational") return "success" as const;
  return "neutral" as const;
}
