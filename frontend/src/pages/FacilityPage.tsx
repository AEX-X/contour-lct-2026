import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  ClockCountdown,
  CheckCircle,
  ClipboardText,
  Cpu,
  Gauge,
  Plus,
  Broadcast,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import {
  RepositoryError,
  deriveFacilityOperationalState,
  isRiskActiveAt,
  type RiskForecast,
  type ReferenceConfig,
  type ReferenceOption,
  type ReferenceRejectReason,
  type WorkOrder,
  type WorkOrderPriority,
  type WorkOrderTarget,
} from "../domain";
import {
  Button,
  InlineAlert,
  Modal,
  Progress,
  StatusBadge,
} from "../shared/ui";
import {
  activeWorkOrderStatuses,
  useFacility,
  useFacilityContext,
  useIncidents,
  useReferenceConfig,
  useRisks,
  useWorkOrders,
} from "../app/dataHooks";
import { useContour, useRepositoryCommandMeta } from "../app/ContourProvider";
import { createClientId } from "../app/clientId";
import {
  facilityStatusLabels,
  formatDateTime,
  formatPercent,
  pluralizeRu,
  priorityLabels,
  riskSeverityLabels,
  statusLabels,
} from "../app/labels";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";
import { RiskReportExport } from "../components/RiskReportExport";
import {
  FacilityAnalyticsSection,
  FacilityOrdersSection,
  FacilityPlanSection,
} from "./FacilitySections";

const createOrderSchema = z.object({
  targetKey: z.string().min(1, "Выбери цель заявки"),
  description: z.string().trim().min(15, "Опиши проблему минимум в 15 символах"),
  symptoms: z.string().trim().min(3, "Укажи хотя бы один симптом"),
  categoryCode: z.string().min(1, "Выбери категорию"),
  preliminaryPriority: z.enum(["P1", "P2", "P3", "P4"]),
});

type CreateOrderValues = z.infer<typeof createOrderSchema>;

type RiskDecisionConflict =
  | { action: "confirm"; currentRisk: RiskForecast; comment: string }
  | { action: "reject"; currentRisk: RiskForecast; reasonCode: string; comment: string }
  | { action: "defer"; currentRisk: RiskForecast };

export function FacilityPage({
  facilityId: explicitFacilityId,
  section = "overview",
}: {
  facilityId?: string;
  section?: "overview" | "plan" | "analytics" | "orders" | "risks";
}) {
  const params = useParams();
  const navigate = useNavigate();
  const { currentUser, profiles, repository, runtime, invalidateAll } = useContour();
  const commandMeta = useRepositoryCommandMeta();
  const facilityId = explicitFacilityId ?? params.facilityId;
  const facilityQuery = useFacility(facilityId);
  const context = useFacilityContext(facilityId);
  const risksQuery = useRisks({ facilityId });
  const incidentsQuery = useIncidents(facilityId);
  const ordersQuery = useWorkOrders({ facilityId });
  const referenceConfigQuery = useReferenceConfig();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRiskId, setSelectedRiskId] = useState<string | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);
  const [confirmRiskId, setConfirmRiskId] = useState<string | null>(null);
  const [rejectRiskId, setRejectRiskId] = useState<string | null>(null);
  const [deferRiskId, setDeferRiskId] = useState<string | null>(null);
  const [decisionConflict, setDecisionConflict] = useState<RiskDecisionConflict | null>(null);
  const pendingCreationRef = useRef<{
    signature: string;
    createIdempotencyKey: string;
    submitIdempotencyKey: string;
    clientOccurredAt: string;
    workOrderId?: string;
  } | null>(null);
  const confirmRiskMutation = useMutation({
    mutationFn: ({ risk, comment }: { risk: RiskForecast; comment: string }) => repository.confirmRisk(risk.id, {
      ...commandMeta(risk.version, `${risk.id}:${risk.version}:confirm`),
      comment,
    }),
    onSuccess: async () => {
      setConfirmRiskId(null);
      setDecisionConflict(null);
      await invalidateAll();
    },
    onError: async (error, variables) => {
      if (error instanceof RepositoryError && error.code === "VERSION_CONFLICT" && error.currentRisk) {
        setConfirmRiskId(null);
        setDecisionConflict({
          action: "confirm",
          currentRisk: error.currentRisk,
          comment: variables.comment,
        });
        await invalidateAll();
      }
    },
  });
  const acknowledgeRiskMutation = useMutation({
    mutationFn: (risk: RiskForecast) => {
      if (!repository.acknowledgeRisk) throw new Error("Принятие прогноза в работу недоступно");
      return repository.acknowledgeRisk(risk.id, {
        ...commandMeta(risk.version, `${risk.id}:${risk.version}:acknowledge`),
        comment: "Прогноз принят диспетчером в работу",
      });
    },
    onSuccess: () => invalidateAll(),
  });
  const rejectRiskMutation = useMutation({
    mutationFn: ({ risk, reasonCode, comment }: { risk: RiskForecast; reasonCode: string; comment: string }) => {
      if (!repository.rejectRisk) throw new Error("Отклонение прогноза недоступно");
      return repository.rejectRisk(risk.id, {
        ...commandMeta(risk.version, `${risk.id}:${risk.version}:reject:${reasonCode}`),
        reasonCode,
        comment,
      });
    },
    onSuccess: async () => {
      setRejectRiskId(null);
      setDecisionConflict(null);
      await invalidateAll();
    },
    onError: async (error, variables) => {
      if (error instanceof RepositoryError && error.code === "VERSION_CONFLICT" && error.currentRisk) {
        setRejectRiskId(null);
        setDecisionConflict({
          action: "reject",
          currentRisk: error.currentRisk,
          reasonCode: variables.reasonCode,
          comment: variables.comment,
        });
        await invalidateAll();
      }
    },
  });
  const deferRiskMutation = useMutation({
    mutationFn: (risk: RiskForecast) => {
      if (!repository.deferRisk) throw new Error("Откладывание прогноза недоступно");
      return repository.deferRisk(risk.id, {
        ...commandMeta(risk.version, `${risk.id}:${risk.version}:defer`),
        comment: "Решение по прогнозу отложено",
      });
    },
    onSuccess: async () => {
      setDeferRiskId(null);
      setDecisionConflict(null);
      await invalidateAll();
    },
    onError: async (error) => {
      if (error instanceof RepositoryError && error.code === "VERSION_CONFLICT" && error.currentRisk) {
        setDeferRiskId(null);
        setDecisionConflict({ action: "defer", currentRisk: error.currentRisk });
        await invalidateAll();
      }
    },
  });

  const risks = risksQuery.data ?? [];
  const incidents = incidentsQuery.data ?? [];
  const orders = ordersQuery.data ?? [];
  const facility = facilityQuery.data;
  const equipment = context.equipment.data;
  const sensors = context.sensors.data;
  const hierarchy = context.hierarchy.data;
  const activeRisks = risks
    .filter((risk) =>
      isRiskActiveAt(risk, repository.getSnapshot().demoClockIso),
    )
    .sort((first, second) => second.probability - first.probability);
  const topRisk = activeRisks[0];
  const retryAllQueries = () => Promise.all([
    facilityQuery.refetch(),
    context.hierarchy.refetch(),
    context.equipment.refetch(),
    context.sensors.refetch(),
    risksQuery.refetch(),
    incidentsQuery.refetch(),
    ordersQuery.refetch(),
  ]);

  if (
    facilityQuery.isPending ||
    context.hierarchy.isPending ||
    context.equipment.isPending ||
    context.sensors.isPending ||
    risksQuery.isPending ||
    incidentsQuery.isPending ||
    ordersQuery.isPending
  ) {
    return <PageLoading label="Загружаем технический контекст объекта" />;
  }

  if (!facility || !equipment || !sensors || !hierarchy ||
    risksQuery.data === undefined || incidentsQuery.data === undefined || ordersQuery.data === undefined) {
    return (
      <PageError
        title="Объект недоступен"
        message="Проверь права текущей роли или повтори запрос"
        onRetry={() => void retryAllQueries()}
      />
    );
  }

  const staleSections = [
    facilityQuery.isError ? "паспорт объекта" : null,
    context.hierarchy.isError ? "иерархия" : null,
    context.equipment.isError ? "оборудование" : null,
    context.sensors.isError ? "датчики" : null,
    risksQuery.isError ? "риски" : null,
    incidentsQuery.isError ? "инциденты" : null,
    ordersQuery.isError ? "заявки" : null,
  ].filter((item): item is string => Boolean(item));
  const activeOrders = orders.filter((order) => activeWorkOrderStatuses.includes(order.status));
  const alarms = sensors.filter((sensor) => ["alarm", "attention", "offline"].includes(sensor.status));
  const canCreate = currentUser.permissions.includes("work_order.create");
  const referenceConfig = referenceConfigQuery.data;
  const operationalState = deriveFacilityOperationalState(
    facility,
    risks,
    incidents,
    repository.getSnapshot().demoClockIso,
  );
  const facilityTarget = makeFacilityTarget(facility.id, facility.name, facility.address, facility.position);
  const selectableTargets: WorkOrderTarget[] = [
    facilityTarget,
    ...hierarchy
      .filter((node) => ["building", "collector", "section"].includes(node.entityType))
      .map((node) => makeRegistryTarget(
        node.entityType as WorkOrderTarget["type"],
        node.entityId ?? node.id,
        facility,
        node.displayName,
        node.path,
        node.planPosition,
      )),
    ...equipment.map((item) => {
      const node = hierarchy.find((candidate) => candidate.id === item.hierarchyNodeId);
      return makeRegistryTarget(
        "equipment",
        item.id,
        facility,
        item.name,
        node?.path ?? [item.name],
        node?.planPosition ?? null,
      );
    }),
    ...sensors.map((sensor) => {
      const node = hierarchy.find((candidate) => candidate.id === sensor.hierarchyNodeId);
      return makeRegistryTarget(
        "sensor",
        sensor.id,
        facility,
        sensor.name,
        [...(node?.path ?? []), sensor.name],
        node?.planPosition ?? null,
      );
    }),
  ];
  const facilityBasePath = explicitFacilityId ? "/my-facility" : `/facilities/${facility.id}`;
  const sectionTitles = {
    overview: facility.name,
    plan: `План: ${facility.name}`,
    analytics: `Аналитика: ${facility.name}`,
    orders: `Заявки: ${facility.name}`,
    risks: `Риски: ${facility.name}`,
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <Link className="back-link" to={currentUser.role === "manager" ? "/city" : currentUser.homeRoute}>
            <ArrowLeft size={16} />
            Назад
          </Link>
          <h1>{sectionTitles[section]}</h1>
          <p className="page-header__meta">
            {facility.address} · {facility.internalCode}
          </p>
        </div>
        <div className="page-actions">
          <StatusBadge tone={facilityTone(operationalState.state)}>
            {operationalState.state === "forecast"
              ? "Прогнозный риск"
              : facilityStatusLabels[operationalState.state]}
          </StatusBadge>
          <RiskReportExport compact />
          {canCreate ? (
            <Button
              startIcon={<Plus size={18} weight="bold" />}
              onClick={() => {
                setSelectedRiskId(null);
                setSelectedTargetKey(`${facilityTarget.type}:${facilityTarget.id}`);
                setCreateOpen(true);
              }}
            >
              Создать заявку
            </Button>
          ) : null}
        </div>
      </header>

      <div className="metric-strip" aria-label="Сводка объекта">
        <div className="metric-strip__item">
          <span className="metric-strip__value">{sensors.length || "-"}</span>
          <span className="metric-strip__label">{sensors.length ? "датчиков в контуре" : "реестр датчиков не загружен"}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value tone-warning">{alarms.length}</span>
          <span className="metric-strip__label">требуют внимания</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value">{activeOrders.length}</span>
          <span className="metric-strip__label">{pluralizeRu(activeOrders.length, ["открытая заявка", "открытые заявки", "открытых заявок"])}</span>
        </div>
        <div className="metric-strip__item">
          <span className="metric-strip__value tone-purple">
            {topRisk ? formatPercent(topRisk.probability) : "-"}
          </span>
          <span className="metric-strip__label">максимальный прогнозный риск</span>
        </div>
      </div>

      <nav className="facility-tabs" aria-label="Разделы объекта">
        {[
          { key: "overview", label: "Обзор", to: facilityBasePath },
          { key: "plan", label: "План и датчики", to: `${facilityBasePath}/plan` },
          { key: "analytics", label: "Аналитика", to: `${facilityBasePath}/analytics` },
          { key: "orders", label: "Заявки", to: `${facilityBasePath}/orders` },
          { key: "risks", label: "Риски", to: `${facilityBasePath}/risks` },
        ].map((item) => (
          <NavLink key={item.key} to={item.to} end={item.key === "overview"} className={({ isActive }) => isActive ? "facility-tabs__item is-active" : "facility-tabs__item"}>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {staleSections.length ? (
        <InlineAlert
          tone="warning"
          title="Часть данных не обновилась"
          action={<Button variant="secondary" onClick={() => void retryAllQueries()}>Повторить</Button>}
        >
          Показана последняя успешно загруженная версия. Не обновились: {staleSections.join(", ")}
        </InlineAlert>
      ) : null}

      <div className="split-layout" style={{ marginTop: 16 }}>
        <div className="content-stack">
          {confirmRiskMutation.isError && !(
            confirmRiskMutation.error instanceof RepositoryError &&
            confirmRiskMutation.error.code === "VERSION_CONFLICT"
          ) ? (
            <InlineAlert tone="critical" title="Не удалось подтвердить прогноз">
              {confirmRiskMutation.error instanceof Error
                ? confirmRiskMutation.error.message
                : "Повтори действие"}
            </InlineAlert>
          ) : null}
          {acknowledgeRiskMutation.isError ? (
            <InlineAlert tone="critical" title="Не удалось принять прогноз в работу">
              {acknowledgeRiskMutation.error instanceof Error
                ? acknowledgeRiskMutation.error.message
                : "Повтори действие"}
            </InlineAlert>
          ) : null}
          {rejectRiskMutation.isError && !(
            rejectRiskMutation.error instanceof RepositoryError &&
            rejectRiskMutation.error.code === "VERSION_CONFLICT"
          ) ? (
            <InlineAlert tone="critical" title="Не удалось отклонить прогноз">
              {rejectRiskMutation.error instanceof Error ? rejectRiskMutation.error.message : "Повтори действие"}
            </InlineAlert>
          ) : null}
          {deferRiskMutation.isError && !(
            deferRiskMutation.error instanceof RepositoryError &&
            deferRiskMutation.error.code === "VERSION_CONFLICT"
          ) ? (
            <InlineAlert tone="critical" title="Не удалось отложить прогноз">
              {deferRiskMutation.error instanceof Error ? deferRiskMutation.error.message : "Повтори действие"}
            </InlineAlert>
          ) : null}
          {decisionConflict ? (
            <InlineAlert
              tone="warning"
              title="Прогноз изменил другой пользователь"
              action={!['confirmed', 'rejected', 'resolved'].includes(decisionConflict.currentRisk.status) ? (
                <Button
                  variant="secondary"
                  loading={confirmRiskMutation.isPending || rejectRiskMutation.isPending || deferRiskMutation.isPending}
                  onClick={() => {
                    if (decisionConflict.action === "confirm") {
                      confirmRiskMutation.mutate({
                        risk: decisionConflict.currentRisk,
                        comment: decisionConflict.comment,
                      });
                    } else if (decisionConflict.action === "reject") {
                      rejectRiskMutation.mutate({
                        risk: decisionConflict.currentRisk,
                        reasonCode: decisionConflict.reasonCode,
                        comment: decisionConflict.comment,
                      });
                    } else {
                      deferRiskMutation.mutate(decisionConflict.currentRisk);
                    }
                  }}
                >
                  Повторить с версией {decisionConflict.currentRisk.version}
                </Button>
              ) : undefined}
            >
              Актуальный статус: {decisionConflict.currentRisk.status === "acknowledged" ? "принят в работу" : decisionConflict.currentRisk.status}.
              Вероятность: {formatPercent(decisionConflict.currentRisk.probability)}. Карточка на странице уже обновляется
            </InlineAlert>
          ) : null}
          {["overview", "risks"].includes(section) && (activeRisks.length ? (
            section === "risks" ? (
              <div className="content-stack" aria-label="Прогнозные риски объекта">
                {activeRisks.map((risk) => (
                  <RiskPanel
                    key={risk.id}
                    risk={risk}
                    canCreate={canCreate}
                    canConfirm={currentUser.permissions.includes("risk.confirm")}
                    canAcknowledge={Boolean(repository.acknowledgeRisk) && currentUser.permissions.includes("risk.acknowledge")}
                    canReject={Boolean(repository.rejectRisk) && currentUser.permissions.includes("risk.reject")}
                    canDefer={Boolean(repository.deferRisk) && currentUser.permissions.includes("risk.defer")}
                    confirming={confirmRiskMutation.isPending && confirmRiskMutation.variables?.risk.id === risk.id}
                    acknowledging={acknowledgeRiskMutation.isPending && acknowledgeRiskMutation.variables?.id === risk.id}
                    rejecting={rejectRiskMutation.isPending && rejectRiskMutation.variables?.risk.id === risk.id}
                    deferring={deferRiskMutation.isPending && deferRiskMutation.variables?.id === risk.id}
                    hasIncident={incidents.some((incident) => incident.sourceRiskId === risk.id && incident.status !== "resolved")}
                    linkedOrders={orders.filter((order) => order.source.type === "risk" && order.source.id === risk.id)}
                    onConfirm={() => {
                      confirmRiskMutation.reset();
                      setConfirmRiskId(risk.id);
                    }}
                    onAcknowledge={() => acknowledgeRiskMutation.mutate(risk)}
                    onReject={() => {
                      rejectRiskMutation.reset();
                      setRejectRiskId(risk.id);
                    }}
                    onDefer={() => {
                      deferRiskMutation.reset();
                      setDeferRiskId(risk.id);
                    }}
                    riskLevelLabel={referenceConfig?.riskLevels.find((level) => level.id === risk.severity)?.displayName}
                    modelAlertRule={referenceConfig?.modelAlertRule}
                    onCreate={() => {
                      setSelectedRiskId(risk.id);
                      setSelectedTargetKey(`${risk.target.type}:${risk.target.id}`);
                      setCreateOpen(true);
                    }}
                  />
                ))}
              </div>
            ) : topRisk ? (
              <RiskPanel
                risk={topRisk}
                canCreate={canCreate}
                canConfirm={currentUser.permissions.includes("risk.confirm")}
                canAcknowledge={Boolean(repository.acknowledgeRisk) && currentUser.permissions.includes("risk.acknowledge")}
                canReject={Boolean(repository.rejectRisk) && currentUser.permissions.includes("risk.reject")}
                canDefer={Boolean(repository.deferRisk) && currentUser.permissions.includes("risk.defer")}
                confirming={confirmRiskMutation.isPending && confirmRiskMutation.variables?.risk.id === topRisk.id}
                acknowledging={acknowledgeRiskMutation.isPending && acknowledgeRiskMutation.variables?.id === topRisk.id}
                rejecting={rejectRiskMutation.isPending && rejectRiskMutation.variables?.risk.id === topRisk.id}
                deferring={deferRiskMutation.isPending && deferRiskMutation.variables?.id === topRisk.id}
                hasIncident={incidents.some((incident) => incident.sourceRiskId === topRisk.id && incident.status !== "resolved")}
                linkedOrders={orders.filter((order) => order.source.type === "risk" && order.source.id === topRisk.id)}
                onConfirm={() => {
                  confirmRiskMutation.reset();
                  setConfirmRiskId(topRisk.id);
                }}
                onAcknowledge={() => acknowledgeRiskMutation.mutate(topRisk)}
                onReject={() => {
                  rejectRiskMutation.reset();
                  setRejectRiskId(topRisk.id);
                }}
                onDefer={() => {
                  deferRiskMutation.reset();
                  setDeferRiskId(topRisk.id);
                }}
                riskLevelLabel={referenceConfig?.riskLevels.find((level) => level.id === topRisk.severity)?.displayName}
                modelAlertRule={referenceConfig?.modelAlertRule}
                onCreate={() => {
                  setSelectedRiskId(topRisk.id);
                  setSelectedTargetKey(`${topRisk.target.type}:${topRisk.target.id}`);
                  setCreateOpen(true);
                }}
              />
            ) : null
          ) : (
            <InlineAlert tone="success" title="Высоких прогнозных рисков не выявлено">
              Данные актуальны на {formatDateTime(facility.updatedAt)}
            </InlineAlert>
          ))}

          {section === "overview" ? <section className="surface">
            <header className="surface__header">
              <div>
                <h2>Оборудование и датчики</h2>
                <p className="page-header__meta">Иерархия объекта и текущие состояния</p>
              </div>
              <StatusBadge tone="info">{hierarchy.length} узлов</StatusBadge>
            </header>
            <div className="surface__body surface__body--flush">
              <ul className="hierarchy-list">
                {equipment.map((item) => {
                  const linkedSensors = sensors.filter((sensor) => sensor.equipmentId === item.id);
                  return (
                    <li className="hierarchy-item" key={item.id}>
                      <span className="hierarchy-item__icon" aria-hidden="true">
                        <Cpu size={19} />
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small className="muted">
                          {item.model ?? "Модель не указана"} · {linkedSensors.length} датч.
                        </small>
                      </span>
                      <StatusBadge tone={equipmentTone(item.status)}>{equipmentStatus(item.status)}</StatusBadge>
                    </li>
                  );
                })}
                {sensors.filter((sensor) => !sensor.equipmentId).map((sensor) => (
                  <li className="hierarchy-item" key={sensor.id}>
                    <span className="hierarchy-item__icon" aria-hidden="true">
                      <Broadcast size={19} />
                    </span>
                    <span>
                      <strong>{sensor.name}</strong>
                      <small className="muted">
                        {sensor.lastReading
                          ? `${sensor.lastReading.value}${sensor.unit ? ` ${sensor.unit}` : ""}`
                          : sensor.lastValueText ?? "Нет данных"}
                      </small>
                    </span>
                    <StatusBadge tone={sensorTone(sensor.status)}>{sensorStatus(sensor.status)}</StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
          </section> : null}

          {section === "plan" ? (
            <FacilityPlanSection
              facility={facility}
              hierarchy={hierarchy}
              equipment={equipment}
              sensors={sensors}
              risks={risks}
              orders={orders}
              canCreate={canCreate}
              targets={selectableTargets}
              onCreateForTarget={(target) => {
                setSelectedRiskId(null);
                setSelectedTargetKey(`${target.type}:${target.id}`);
                setCreateOpen(true);
              }}
            />
          ) : null}

          {section === "analytics" ? (
            <FacilityAnalyticsSection
              facility={facility}
              hierarchy={hierarchy}
              equipment={equipment}
              sensors={sensors}
              risks={risks}
              orders={orders}
              canCreate={canCreate}
              targets={selectableTargets}
              asOf={repository.getSnapshot().demoClockIso}
              onCreateForTarget={() => undefined}
            />
          ) : null}

          {section === "orders" ? <FacilityOrdersSection orders={orders} /> : null}
        </div>

        <aside className="content-stack">
          <section className="surface">
            <header className="surface__header">
              <h2>Паспорт объекта</h2>
            </header>
            <div className="surface__body">
              <dl className="definition-grid">
                <dt>Адрес</dt>
                <dd>{facility.address}</dd>
                <dt>Подразделение</dt>
                <dd>{operationalUnitLabel(facility.operationalUnitId)}</dd>
                <dt>Ответственный</dt>
                <dd>{profiles.find((profile) => profile.id === facility.responsibleDispatcherId)?.displayName ?? "Не назначен"}</dd>
                <dt>ROSTA</dt>
                <dd>{facility.rostaCode ?? "Нет данных"}</dd>
                <dt>Обновлено</dt>
                <dd>{formatDateTime(facility.updatedAt)}</dd>
              </dl>
              <div style={{ marginTop: 18 }}>
                {sensors.length ? (
                  <Progress
                    label="Датчики с сохранённым показанием"
                    value={Math.round((facility.sensorAvailability ?? 0) * 100)}
                    tone={facility.sensorAvailability === null ? "neutral" : "info"}
                    showValue={facility.sensorAvailability !== null}
                  />
                ) : (
                  <p className="muted">Покрытие последними показаниями: {facility.sensorAvailability === null ? "нет данных" : formatPercent(facility.sensorAvailability)}. Детализация реестра не загружена</p>
                )}
                <p className="muted" style={{ marginTop: 8 }}>Доля датчиков с любым последним показанием. Не показывает свежесть или текущую связь</p>
              </div>
              <p className="provenance-note" style={{ marginTop: 16 }}>
                Источник: {facility.provenance.sourceLabel}
                {facility.provenance.note ? ` · ${facility.provenance.note}` : ""}
              </p>
            </div>
          </section>

          <section className="surface">
            <header className="surface__header">
              <h2>Активные заявки</h2>
              <StatusBadge tone={activeOrders.length ? "warning" : "success"}>{activeOrders.length}</StatusBadge>
            </header>
            <div className="surface__body surface__body--flush">
              {activeOrders.length ? (
                <ul className="plain-list">
                  {activeOrders.slice(0, 5).map((order) => (
                    <li key={order.id}>
                      <Link className="attention-item" to={`/work-orders/${order.id}`}>
                        <span className="attention-item__icon bg-warning" aria-hidden="true">
                          <ClipboardText size={18} />
                        </span>
                        <span>
                          <strong>{order.number}</strong>
                          <small>{order.target.displayName}</small>
                        </span>
                        <StatusBadge tone="info">{statusLabels[order.status]}</StatusBadge>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="Открытых заявок нет" description="Все зарегистрированные работы завершены" />
              )}
            </div>
          </section>
        </aside>
      </div>

      <CreateWorkOrderModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        risk={risks.find((risk) => risk.id === selectedRiskId) ?? null}
        facilityTarget={facilityTarget}
        availableTargets={selectableTargets}
        initialTargetKey={selectedTargetKey}
        duplicate={orders.find(
          (order) =>
            activeWorkOrderStatuses.includes(order.status) &&
            order.target.id === (
              risks.find((risk) => risk.id === selectedRiskId)?.target.id ??
              selectableTargets.find((target) => `${target.type}:${target.id}` === selectedTargetKey)?.id ??
              facility.id
            ),
        )}
        workTypes={referenceConfig?.workTypes}
        onCreate={async (values, sourceRisk, target) => {
          const sourceIncident = sourceRisk
            ? incidents.find((incident) => incident.sourceRiskId === sourceRisk.id && incident.status !== "resolved")
            : null;
          const input = {
            source: sourceRisk
              ? runtime.mode === "api"
                ? { type: "risk" as const, id: sourceRisk.id }
                : { type: "incident" as const, id: sourceIncident?.id ?? null }
              : { type: "manual" as const, id: null },
            target,
            categoryCode: values.categoryCode,
            symptoms: values.symptoms
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
            description: values.description,
            preliminaryPriority: values.preliminaryPriority,
          };
          const signature = JSON.stringify(input);
          if (!pendingCreationRef.current || pendingCreationRef.current.signature !== signature) {
            pendingCreationRef.current = {
              signature,
              createIdempotencyKey: createClientId("work-order-create"),
              submitIdempotencyKey: createClientId("work-order-submit"),
              clientOccurredAt: repository.getSnapshot().demoClockIso,
            };
          }
          const pending = pendingCreationRef.current;
          const created = pending.workOrderId
            ? await repository.getWorkOrder(pending.workOrderId)
            : await repository.createWorkOrder(input, {
                idempotencyKey: pending.createIdempotencyKey,
                clientOccurredAt: pending.clientOccurredAt,
              });
          pending.workOrderId = created.id;
          const submitted = created.allowedActions.includes("submit")
            ? await repository.performWorkOrderAction(created.id, {
                action: "submit",
                expectedVersion: created.version,
                idempotencyKey: pending.submitIdempotencyKey,
                clientOccurredAt: pending.clientOccurredAt,
                payload: { comment: "Отправлено из карточки объекта" },
              })
            : { workOrder: created };
          pendingCreationRef.current = null;
          await invalidateAll();
          setCreateOpen(false);
          navigate(`/work-orders/${submitted.workOrder.id}`);
        }}
      />
      <ConfirmRiskModal
        key={confirmRiskId ?? "closed"}
        open={Boolean(confirmRiskId)}
        risk={risks.find((risk) => risk.id === confirmRiskId) ?? null}
        submitting={confirmRiskMutation.isPending}
        error={confirmRiskMutation.isError && confirmRiskMutation.error instanceof Error
          ? confirmRiskMutation.error.message
          : null}
        onClose={() => {
          if (!confirmRiskMutation.isPending) setConfirmRiskId(null);
        }}
        onConfirm={(comment) => {
          const risk = risks.find((item) => item.id === confirmRiskId);
          if (risk) confirmRiskMutation.mutate({ risk, comment });
        }}
      />
      <RejectRiskModal
        key={rejectRiskId ?? "closed"}
        open={Boolean(rejectRiskId)}
        risk={risks.find((risk) => risk.id === rejectRiskId) ?? null}
        reasons={referenceConfig?.rejectReasons ?? []}
        referenceLoading={referenceConfigQuery.isPending}
        referenceError={referenceConfigQuery.isError}
        submitting={rejectRiskMutation.isPending}
        error={rejectRiskMutation.isError && rejectRiskMutation.error instanceof Error
          ? rejectRiskMutation.error.message
          : null}
        onRetryReference={() => void referenceConfigQuery.refetch()}
        onClose={() => {
          if (!rejectRiskMutation.isPending) setRejectRiskId(null);
        }}
        onSubmit={(reasonCode, comment) => {
          const risk = risks.find((item) => item.id === rejectRiskId);
          if (risk) rejectRiskMutation.mutate({ risk, reasonCode, comment });
        }}
      />
      <DeferRiskModal
        open={Boolean(deferRiskId)}
        risk={risks.find((risk) => risk.id === deferRiskId) ?? null}
        submitting={deferRiskMutation.isPending}
        error={deferRiskMutation.isError && deferRiskMutation.error instanceof Error
          ? deferRiskMutation.error.message
          : null}
        onClose={() => {
          if (!deferRiskMutation.isPending) setDeferRiskId(null);
        }}
        onConfirm={() => {
          const risk = risks.find((item) => item.id === deferRiskId);
          if (risk) deferRiskMutation.mutate(risk);
        }}
      />
    </div>
  );
}

function RiskPanel({
  risk,
  canCreate,
  canConfirm,
  canAcknowledge,
  canReject,
  canDefer,
  confirming,
  acknowledging,
  rejecting,
  deferring,
  hasIncident,
  linkedOrders,
  onConfirm,
  onAcknowledge,
  onReject,
  onDefer,
  onCreate,
  riskLevelLabel,
  modelAlertRule,
}: {
  risk: RiskForecast;
  canCreate: boolean;
  canConfirm: boolean;
  canAcknowledge: boolean;
  canReject: boolean;
  canDefer: boolean;
  confirming: boolean;
  acknowledging: boolean;
  rejecting: boolean;
  deferring: boolean;
  hasIncident: boolean;
  linkedOrders: WorkOrder[];
  onConfirm: () => void;
  onAcknowledge: () => void;
  onReject: () => void;
  onDefer: () => void;
  onCreate: () => void;
  riskLevelLabel?: string;
  modelAlertRule?: ReferenceConfig["modelAlertRule"];
}) {
  const canResolve = ["new", "acknowledged"].includes(risk.status);
  const canConfirmTransition = ["new", "acknowledged", "deferred"].includes(risk.status);
  return (
    <section className="surface risk-panel">
      <header className="surface__header">
        <div>
          <div className="inline-actions">
            <StatusBadge tone="forecast">Прогноз ML</StatusBadge>
            {risk.demoClock ? <StatusBadge tone="warning">Исторический ML-демо</StatusBadge> : null}
          </div>
          <h2 style={{ marginTop: 8 }}>{risk.predictedEvent}</h2>
          <p className="page-header__meta">Горизонт прогноза: {risk.horizonHours} ч</p>
          {risk.modelAsOf ? (
            <p className="page-header__meta">
              Модельный срез: {formatDateTime(risk.modelAsOf)}
              {risk.demoClock ? ` · запрошено backend: ${formatDateTime(risk.demoClock.requestedAsOfUtc)}` : ""}
            </p>
          ) : null}
        </div>
        <div className="risk-score">
          <span className="risk-score__value">{formatPercent(risk.probability)}</span>
        </div>
      </header>
      <div className="surface__body">
        {risk.verdict ? (
          <div className="risk-verdict">
            <span>Вывод модели</span>
            <strong>{risk.verdict}</strong>
          </div>
        ) : null}
        {risk.blindSpots?.length ? (
          <InlineAlert tone="warning" title="Слепые зоны модели" className="risk-blind-spots">
            <p>Низкая вероятность при слепых зонах означает, что модель не видит часть факторов, а не то, что риска нет</p>
            <ul>
              {risk.blindSpots.map((blindSpot) => <li key={blindSpot}>{blindSpot}</li>)}
            </ul>
          </InlineAlert>
        ) : null}
        <div className="risk-panel__summary">
          <div>
            <strong>{riskLevelLabel ?? riskSeverityLabels[risk.severity]} риск</strong>
            <p className="muted">{risk.recommendation}</p>
          </div>
          <div className="risk-panel__actions">
            {((risk.status === "confirmed" && hasIncident) || risk.status === "acknowledged") && canCreate ? (
              <Button startIcon={<Plus size={18} />} onClick={onCreate}>Создать заявку</Button>
            ) : null}
            {risk.status === "new" && canAcknowledge ? (
              <Button startIcon={<CheckCircle size={18} />} loading={acknowledging} onClick={onAcknowledge}>
                Принять в работу
              </Button>
            ) : null}
            {canConfirmTransition && canConfirm ? (
              <Button startIcon={<CheckCircle size={18} />} loading={confirming} onClick={onConfirm}>
                Подтвердить прогноз
              </Button>
            ) : null}
            {canResolve && canDefer ? (
              <Button variant="secondary" startIcon={<ClockCountdown size={18} />} loading={deferring} onClick={onDefer}>
                Отложить
              </Button>
            ) : null}
            {canResolve && canReject ? (
              <Button variant="danger" startIcon={<XCircle size={18} />} loading={rejecting} onClick={onReject}>
                Ложное срабатывание
              </Button>
            ) : null}
            {risk.status === "acknowledged" ? <StatusBadge tone="info">Принят в работу</StatusBadge> : null}
            {risk.status === "confirmed" ? <StatusBadge tone="success">Инцидент зарегистрирован</StatusBadge> : null}
          </div>
        </div>
        {risk.modelAlert !== null && risk.modelAlert !== undefined && modelAlertRule ? (
          <details className="details-box risk-rule-note">
            <summary>Как рассчитан уровень риска</summary>
            <p>{modelAlertRule.description}</p>
          </details>
        ) : null}
        <ul className="factor-list" aria-label="Факторы прогноза">
          {risk.topFactors.slice(0, 4).map((factor) => (
            <li key={factor.label}>
              <span>{factor.label}</span>
              {factor.contribution === null ? (
                <span className="muted">Без числовой оценки вклада</span>
              ) : (
                <>
                  <span className="factor-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(factor.contribution * 100)}%` }} />
                  </span>
                  <strong>{formatPercent(factor.contribution)}</strong>
                </>
              )}
            </li>
          ))}
        </ul>
        {linkedOrders.length ? (
          <div className="content-stack" aria-label="Связанные заявки">
            {linkedOrders.map((order) => (
              <InlineAlert
                key={order.id}
                tone={order.status === "closed" ? "success" : order.status === "cancelled" ? "warning" : "info"}
                title={`Связанная заявка ${order.number}`}
              >
                <span>Статус: {statusLabels[order.status]}. </span>
                <Link to={`/work-orders/${order.id}`}>Открыть заявку</Link>
                {order.status === "closed" ? (
                  <span> · Ремонт завершён, но решение по прогнозу остаётся отдельным действием диспетчера</span>
                ) : null}
              </InlineAlert>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ConfirmRiskModal({
  open,
  risk,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  risk: RiskForecast | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = () => {
    const normalizedComment = comment.trim();
    if (!normalizedComment) {
      setLocalError("Опиши результат проверки, чтобы инженер и диспетчеры понимали основание решения");
      return;
    }
    setLocalError(null);
    onConfirm(normalizedComment);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Подтвердить прогноз как инцидент?"
      description={risk ? `${risk.predictedEvent}, вероятность ${formatPercent(risk.probability)}` : undefined}
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>Отмена</Button>
          <Button
            startIcon={<CheckCircle size={18} />}
            loading={submitting}
            disabled={!risk}
            onClick={submit}
          >
            Зарегистрировать инцидент
          </Button>
        </div>
      }
    >
      <div className="form-grid">
        {risk ? (
          <div className="risk-decision-preview field--full">
            <strong>{risk.predictedEvent}</strong>
            <span>{formatPercent(risk.probability)} · версия {risk.version}</span>
          </div>
        ) : null}
        <div className="field field--full">
          <label htmlFor="confirm-comment">Результат проверки *</label>
          <textarea
            id="confirm-comment"
            value={comment}
            required
            disabled={submitting}
            aria-describedby="confirm-comment-hint"
            onChange={(event) => {
              setComment(event.target.value);
              setLocalError(null);
            }}
          />
          <p className="field__hint" id="confirm-comment-hint">
            Укажи наблюдение диспетчера и рекомендуемое следующее действие. Комментарий попадёт в журнал инцидентов
          </p>
        </div>
        {localError ? <InlineAlert className="field--full" tone="critical" title="Добавь результат проверки">{localError}</InlineAlert> : null}
        {error ? <InlineAlert className="field--full" tone="critical" title="Backend не зарегистрировал инцидент">{error}</InlineAlert> : null}
      </div>
    </Modal>
  );
}

function RejectRiskModal({
  open,
  risk,
  reasons,
  referenceLoading,
  referenceError,
  submitting,
  error,
  onRetryReference,
  onClose,
  onSubmit,
}: {
  open: boolean;
  risk: RiskForecast | null;
  reasons: ReferenceRejectReason[];
  referenceLoading: boolean;
  referenceError: boolean;
  submitting: boolean;
  error: string | null;
  onRetryReference: () => void;
  onClose: () => void;
  onSubmit: (reasonCode: string, comment: string) => void;
}) {
  const [reasonCode, setReasonCode] = useState("");
  const [comment, setComment] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const effectiveReasonCode = reasonCode || reasons[0]?.id || "";
  const selectedReason = reasons.find((reason) => reason.id === effectiveReasonCode);

  const submit = () => {
    if (!effectiveReasonCode) {
      setLocalError("Выбери причину из справочника backend");
      return;
    }
    if (selectedReason?.requiresComment && !comment.trim()) {
      setLocalError("Для выбранной причины нужен комментарий");
      return;
    }
    setLocalError(null);
    onSubmit(effectiveReasonCode, comment.trim());
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Отметить ложное срабатывание"
      description={risk ? `${risk.predictedEvent}, вероятность ${formatPercent(risk.probability)}` : undefined}
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>Отмена</Button>
          <Button
            variant="danger"
            startIcon={<XCircle size={18} />}
            loading={submitting}
            disabled={!risk || referenceLoading || referenceError || !reasons.length}
            onClick={submit}
          >
            Отклонить прогноз
          </Button>
        </div>
      }
    >
      <div className="form-grid">
        {referenceLoading ? (
          <InlineAlert className="field--full" tone="info" title="Загружаем причины">
            Список причин запрашивается из конфигурации backend
          </InlineAlert>
        ) : null}
        {referenceError ? (
          <InlineAlert
            className="field--full"
            tone="critical"
            title="Справочник причин недоступен"
            action={<Button variant="secondary" onClick={onRetryReference}>Повторить</Button>}
          >
            Отклонение заблокировано, чтобы не отправить неподдерживаемый код причины
          </InlineAlert>
        ) : null}
        {!referenceLoading && !referenceError ? (
          <div className="field field--full">
            <label htmlFor="reject-reason">Причина</label>
            <select id="reject-reason" value={effectiveReasonCode} onChange={(event) => {
              setReasonCode(event.target.value);
              setLocalError(null);
            }}>
              {reasons.map((reason) => <option key={reason.id} value={reason.id}>{reason.displayName}</option>)}
            </select>
          </div>
        ) : null}
        <div className="field field--full">
          <label htmlFor="reject-comment">
            Комментарий{selectedReason?.requiresComment ? " *" : ""}
          </label>
          <textarea
            id="reject-comment"
            value={comment}
            disabled={referenceLoading || referenceError}
            required={selectedReason?.requiresComment}
            aria-describedby="reject-comment-hint"
            onChange={(event) => {
              setComment(event.target.value);
              setLocalError(null);
            }}
          />
          <p className="field__hint" id="reject-comment-hint">
            {selectedReason?.requiresComment
              ? "Обязателен для выбранной причины"
              : "Необязательно. Добавь наблюдения, если они помогут дальнейшей проверке модели"}
          </p>
        </div>
        {localError ? <InlineAlert className="field--full" tone="critical" title="Проверь решение">{localError}</InlineAlert> : null}
        {error ? <InlineAlert className="field--full" tone="critical" title="Backend не принял решение">{error}</InlineAlert> : null}
      </div>
    </Modal>
  );
}

function DeferRiskModal({
  open,
  risk,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  risk: RiskForecast | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Отложить решение по прогнозу?"
      description="Прогноз выйдет из активной очереди. Решение фиксируется в журнале"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>Отмена</Button>
          <Button
            startIcon={<ClockCountdown size={18} />}
            loading={submitting}
            disabled={!risk}
            onClick={onConfirm}
          >
            Отложить
          </Button>
        </div>
      }
    >
      {risk ? (
        <div className="risk-decision-preview">
          <strong>{risk.predictedEvent}</strong>
          <span>{formatPercent(risk.probability)} · версия {risk.version}</span>
        </div>
      ) : null}
      {error ? <InlineAlert tone="critical" title="Backend не принял решение">{error}</InlineAlert> : null}
    </Modal>
  );
}

function CreateWorkOrderModal({
  open,
  onClose,
  risk,
  facilityTarget,
  availableTargets,
  initialTargetKey,
  duplicate,
  workTypes,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  risk: RiskForecast | null;
  facilityTarget: WorkOrderTarget;
  availableTargets: WorkOrderTarget[];
  initialTargetKey: string | null;
  duplicate?: { number: string; id: string };
  workTypes?: ReferenceOption[];
  onCreate: (
    values: CreateOrderValues,
    risk: RiskForecast | null,
    target: WorkOrderTarget,
  ) => Promise<void>;
}) {
  const form = useForm<CreateOrderValues>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      targetKey: risk ? `${risk.target.type}:${risk.target.id}` : initialTargetKey ?? `${facilityTarget.type}:${facilityTarget.id}`,
      description: risk?.recommendation ?? "",
      symptoms: risk?.predictedEvent ?? "",
      categoryCode: risk ? "maintenance" : "inspection",
      preliminaryPriority: risk?.severity === "critical" ? "P1" : "P2",
    },
  });
  const { reset } = form;
  const riskId = risk?.id;
  useEffect(() => {
    if (!open) return;
    reset({
      targetKey: risk ? `${risk.target.type}:${risk.target.id}` : initialTargetKey ?? `${facilityTarget.type}:${facilityTarget.id}`,
      description: risk?.recommendation ?? "",
      symptoms: risk?.predictedEvent ?? "",
      categoryCode: risk ? "maintenance" : "inspection",
      preliminaryPriority: risk?.severity === "critical" ? "P1" : "P2",
    });
  }, [facilityTarget.id, facilityTarget.type, initialTargetKey, open, reset, risk, riskId]);
  const createMutation = useMutation({
    mutationFn: (values: CreateOrderValues) => {
      const target = risk?.target ?? availableTargets.find(
        (candidate) => `${candidate.type}:${candidate.id}` === values.targetKey,
      );
      if (!target) throw new Error("Цель заявки не найдена");
      return onCreate(values, risk, target);
    },
  });
  const errorMessages = Object.values(form.formState.errors)
    .map((error) => error?.message)
    .filter(Boolean);
  const formId = "create-work-order-form";
  const closeModal = () => {
    if (createMutation.isPending) return;
    createMutation.reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title="Новая заявка"
      description="Заявка будет привязана к конкретному оборудованию или датчику"
      size="large"
      closeOnBackdrop={!createMutation.isPending}
      closeOnEscape={!createMutation.isPending}
      footer={
        <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button variant="secondary" disabled={createMutation.isPending} onClick={closeModal}>
            Отмена
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={createMutation.isPending}
            startIcon={<CheckCircle size={18} />}
          >
            Создать и отправить
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        className="form-grid"
        onSubmit={form.handleSubmit((values) => createMutation.mutate(values))}
      >
        {errorMessages.length ? (
          <div className="error-summary field--full" role="alert" tabIndex={-1}>
            <strong>Проверь поля формы</strong>
            <ul>
              {errorMessages.map((message) => (
                <li key={String(message)}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {duplicate ? (
          <InlineAlert tone="warning" title="Возможный дубликат" className="field--full">
            По этой цели уже открыта заявка {duplicate.number}. Новая заявка всё равно может быть создана
          </InlineAlert>
        ) : null}
        <div className="field field--full">
          {risk ? <span className="field__label">Цель заявки</span> : <label htmlFor="order-target">Цель заявки</label>}
          {risk ? (
            <div className="target-summary">
              <Gauge size={20} aria-hidden="true" />
              <div>
                <strong>{risk.target.displayName}</strong>
                <small>{risk.target.hierarchyPath.map((item) => item.displayName).join(" / ")}</small>
              </div>
            </div>
          ) : (
            <select
              id="order-target"
              aria-invalid={Boolean(form.formState.errors.targetKey)}
              aria-describedby={form.formState.errors.targetKey ? "order-target-error" : undefined}
              {...form.register("targetKey")}
            >
              {availableTargets.map((target) => (
                <option key={`${target.type}:${target.id}`} value={`${target.type}:${target.id}`}>
                  {targetTypeLabel(target.type)}: {target.displayName}
                </option>
              ))}
            </select>
          )}
          {form.formState.errors.targetKey ? (
            <p className="field__error" id="order-target-error">{form.formState.errors.targetKey.message}</p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="order-category">Категория</label>
          <select
            id="order-category"
            aria-invalid={Boolean(form.formState.errors.categoryCode)}
            aria-describedby={form.formState.errors.categoryCode ? "order-category-error" : undefined}
            {...form.register("categoryCode")}
          >
            {(workTypes?.length ? workTypes : [
              { id: "inspection", displayName: "Осмотр и диагностика" },
              { id: "repair", displayName: "Ремонт оборудования" },
              { id: "replacement", displayName: "Замена оборудования или датчика" },
              { id: "maintenance", displayName: "Плановое или предиктивное обслуживание" },
            ]).map((workType) => (
              <option key={workType.id} value={workType.id}>{workType.displayName}</option>
            ))}
          </select>
          {form.formState.errors.categoryCode ? (
            <p className="field__error" id="order-category-error">{form.formState.errors.categoryCode.message}</p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="order-priority">Предварительный приоритет</label>
          <select id="order-priority" {...form.register("preliminaryPriority")}>
            {(Object.keys(priorityLabels) as WorkOrderPriority[]).map((priority) => (
              <option value={priority} key={priority}>
                {priorityLabels[priority]}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--full">
          <label htmlFor="order-symptoms">Наблюдаемые признаки</label>
          <input
            id="order-symptoms"
            aria-invalid={Boolean(form.formState.errors.symptoms)}
            aria-describedby={`symptoms-hint${form.formState.errors.symptoms ? " order-symptoms-error" : ""}`}
            {...form.register("symptoms")}
          />
          <p className="field__hint" id="symptoms-hint">Несколько признаков можно разделить запятыми</p>
          {form.formState.errors.symptoms ? (
            <p className="field__error" id="order-symptoms-error">{form.formState.errors.symptoms.message}</p>
          ) : null}
        </div>
        <div className="field field--full">
          <label htmlFor="order-description">Описание</label>
          <textarea
            id="order-description"
            aria-invalid={Boolean(form.formState.errors.description)}
            aria-describedby={form.formState.errors.description ? "order-description-error" : undefined}
            {...form.register("description")}
          />
          {form.formState.errors.description ? (
            <p className="field__error" id="order-description-error">{form.formState.errors.description.message}</p>
          ) : null}
        </div>
        {createMutation.isError ? (
          <InlineAlert tone="critical" title="Заявку не удалось создать" className="field--full">
            <p>
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Backend не принял заявку"}. Данные формы сохранены
            </p>
            {createMutation.error instanceof RepositoryError && createMutation.error.fieldErrors.length ? (
              <ul>
                {createMutation.error.fieldErrors.map((item) => (
                  <li key={`${item.field}:${item.code}`}>{item.message}</li>
                ))}
              </ul>
            ) : null}
            {createMutation.error instanceof RepositoryError ? (
              <small>Trace ID: {createMutation.error.correlationId}</small>
            ) : null}
          </InlineAlert>
        ) : null}
      </form>
    </Modal>
  );
}

function makeFacilityTarget(
  facilityId: string,
  name: string,
  address: string,
  position: { lat: number; lon: number } | null,
): WorkOrderTarget {
  return {
    type: "facility",
    id: facilityId,
    facilityId,
    displayName: name,
    hierarchyPath: [{ type: "facility", id: facilityId, displayName: name }],
    locationSnapshot: { text: address, geo: position, planPosition: null },
  };
}

function makeRegistryTarget(
  type: WorkOrderTarget["type"],
  id: string,
  facility: { id: string; name: string; address: string; position: { lat: number; lon: number } | null },
  displayName: string,
  path: string[],
  planPosition: WorkOrderTarget["locationSnapshot"]["planPosition"],
): WorkOrderTarget {
  return {
    type,
    id,
    facilityId: facility.id,
    displayName,
    hierarchyPath: path.map((item, index) => ({ type: index === path.length - 1 ? type : "path", id: `${id}-${index}`, displayName: item })),
    locationSnapshot: { text: facility.address, geo: facility.position, planPosition },
  };
}

function targetTypeLabel(type: WorkOrderTarget["type"]) {
  return {
    facility: "Объект",
    building: "Сооружение",
    collector: "Коллектор",
    section: "Участок",
    equipment: "Оборудование",
    sensor: "Датчик",
  }[type];
}

function operationalUnitLabel(unitId: string) {
  return {
    "unit-central": "Центральное эксплуатационное управление",
    "unit-north": "Северное эксплуатационное управление",
    "unit-south": "Южное эксплуатационное управление",
  }[unitId] ?? unitId;
}

function facilityTone(status: "normal" | "attention" | "critical" | "no_data" | "forecast") {
  if (status === "critical") return "critical" as const;
  if (status === "attention" || status === "forecast") return "warning" as const;
  if (status === "normal") return "success" as const;
  return "neutral" as const;
}

function equipmentTone(status: string) {
  if (status === "fault") return "critical" as const;
  if (status === "attention") return "warning" as const;
  if (status === "operational") return "success" as const;
  return "neutral" as const;
}

function equipmentStatus(status: string) {
  return { operational: "Исправно", attention: "Внимание", fault: "Неисправно", unknown: "Нет данных" }[status] ?? status;
}

function sensorTone(status: string) {
  if (status === "alarm") return "critical" as const;
  if (status === "attention" || status === "offline") return "warning" as const;
  if (status === "normal") return "success" as const;
  return "neutral" as const;
}

function sensorStatus(status: string) {
  return {
    normal: "Норма",
    attention: "Внимание",
    alarm: "Тревога",
    offline: "Нет связи",
    unknown: "Состояние не рассчитано",
  }[status] ?? status;
}
