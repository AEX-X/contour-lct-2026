import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle,
  ClipboardText,
  Cpu,
  Gauge,
  Plus,
  Broadcast,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import {
  deriveFacilityOperationalState,
  isRiskActiveAt,
  type RiskForecast,
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

export function FacilityPage({
  facilityId: explicitFacilityId,
  section = "overview",
}: {
  facilityId?: string;
  section?: "overview" | "plan" | "analytics" | "orders" | "risks";
}) {
  const params = useParams();
  const navigate = useNavigate();
  const { currentUser, profiles, repository, invalidateAll } = useContour();
  const commandMeta = useRepositoryCommandMeta();
  const facilityId = explicitFacilityId ?? params.facilityId;
  const facilityQuery = useFacility(facilityId);
  const context = useFacilityContext(facilityId);
  const risksQuery = useRisks({ facilityId });
  const incidentsQuery = useIncidents(facilityId);
  const ordersQuery = useWorkOrders({ facilityId });
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRiskId, setSelectedRiskId] = useState<string | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);
  const pendingCreationRef = useRef<{
    signature: string;
    createIdempotencyKey: string;
    submitIdempotencyKey: string;
    clientOccurredAt: string;
    workOrderId?: string;
  } | null>(null);
  const confirmRiskMutation = useMutation({
    mutationFn: (risk: RiskForecast) => repository.confirmRisk(risk.id, {
      ...commandMeta(risk.version, `${risk.id}:${risk.version}:confirm`),
      comment: "Прогноз проверен диспетчером. Требуется выезд и инструментальная диагностика",
    }),
    onSuccess: () => invalidateAll(),
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

  const risks = risksQuery.data ?? [];
  const incidents = incidentsQuery.data ?? [];
  const orders = ordersQuery.data ?? [];
  const activeRisks = risks
    .filter((risk) =>
      isRiskActiveAt(risk, repository.getSnapshot().demoClockIso),
    )
    .sort((first, second) => second.probability - first.probability);
  const topRisk = activeRisks[0];

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

  if (
    facilityQuery.isError ||
    context.hierarchy.isError ||
    context.equipment.isError ||
    context.sensors.isError ||
    risksQuery.isError ||
    incidentsQuery.isError ||
    ordersQuery.isError
  ) {
    return (
      <PageError
        title="Объект недоступен"
        message="Проверь права текущей роли или повтори запрос"
        onRetry={() => void Promise.all([
          facilityQuery.refetch(),
          context.hierarchy.refetch(),
          context.equipment.refetch(),
          context.sensors.refetch(),
          risksQuery.refetch(),
          incidentsQuery.refetch(),
          ordersQuery.refetch(),
        ])}
      />
    );
  }

  const facility = facilityQuery.data;
  const equipment = context.equipment.data;
  const sensors = context.sensors.data;
  const hierarchy = context.hierarchy.data;
  const activeOrders = orders.filter((order) => activeWorkOrderStatuses.includes(order.status));
  const alarms = sensors.filter((sensor) => ["alarm", "attention", "offline"].includes(sensor.status));
  const canCreate = currentUser.permissions.includes("work_order.create");
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

      <div className="split-layout" style={{ marginTop: 16 }}>
        <div className="content-stack">
          {confirmRiskMutation.isError ? (
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
                    confirming={confirmRiskMutation.isPending && confirmRiskMutation.variables?.id === risk.id}
                    acknowledging={acknowledgeRiskMutation.isPending && acknowledgeRiskMutation.variables?.id === risk.id}
                    hasIncident={incidents.some((incident) => incident.sourceRiskId === risk.id && incident.status !== "resolved")}
                    onConfirm={() => confirmRiskMutation.mutate(risk)}
                    onAcknowledge={() => acknowledgeRiskMutation.mutate(risk)}
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
                confirming={confirmRiskMutation.isPending && confirmRiskMutation.variables?.id === topRisk.id}
                acknowledging={acknowledgeRiskMutation.isPending && acknowledgeRiskMutation.variables?.id === topRisk.id}
                hasIncident={incidents.some((incident) => incident.sourceRiskId === topRisk.id && incident.status !== "resolved")}
                onConfirm={() => confirmRiskMutation.mutate(topRisk)}
                onAcknowledge={() => acknowledgeRiskMutation.mutate(topRisk)}
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
                      <small className="muted">{sensor.lastReading?.value ?? "Нет данных"} {sensor.unit}</small>
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
                    label="Доступность датчиков"
                    value={Math.round((facility.sensorAvailability ?? 0) * 100)}
                    tone={facility.sensorAvailability === null ? "neutral" : facility.sensorAvailability >= 0.9 ? "success" : "warning"}
                    showValue={facility.sensorAvailability !== null}
                  />
                ) : (
                  <p className="muted">Агрегированная доступность СМВУ: {facility.sensorAvailability === null ? "нет данных" : formatPercent(facility.sensorAvailability)}. Детализация реестра не загружена</p>
                )}
              </div>
              <p className="provenance-note" style={{ marginTop: 16 }}>
                Демонстрационные данные. Реальные схемы и реквизиты не подключены
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
        onCreate={async (values, sourceRisk, target) => {
          const sourceIncident = sourceRisk
            ? incidents.find((incident) => incident.sourceRiskId === sourceRisk.id && incident.status !== "resolved")
            : null;
          const input = {
            source: sourceRisk
              ? { type: "incident" as const, id: sourceIncident?.id ?? null }
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
    </div>
  );
}

function RiskPanel({
  risk,
  canCreate,
  canConfirm,
  canAcknowledge,
  confirming,
  acknowledging,
  hasIncident,
  onConfirm,
  onAcknowledge,
  onCreate,
}: {
  risk: RiskForecast;
  canCreate: boolean;
  canConfirm: boolean;
  canAcknowledge: boolean;
  confirming: boolean;
  acknowledging: boolean;
  hasIncident: boolean;
  onConfirm: () => void;
  onAcknowledge: () => void;
  onCreate: () => void;
}) {
  return (
    <section className="surface risk-panel">
      <header className="surface__header">
        <div>
          <StatusBadge tone="forecast">Демонстрационный прогноз</StatusBadge>
          <h2 style={{ marginTop: 8 }}>{risk.predictedEvent}</h2>
          <p className="page-header__meta">Горизонт прогноза: {risk.horizonHours} ч</p>
        </div>
        <div className="risk-score">
          <span className="risk-score__value">{formatPercent(risk.probability)}</span>
        </div>
      </header>
      <div className="surface__body">
        <div className="inline-actions" style={{ justifyContent: "space-between" }}>
          <div>
            <strong>{riskSeverityLabels[risk.severity]} риск</strong>
            <p className="muted">{risk.recommendation}</p>
          </div>
          {((risk.status === "confirmed" && hasIncident) || risk.status === "acknowledged") && canCreate ? (
            <Button startIcon={<Plus size={18} />} onClick={onCreate}>
              Создать заявку
            </Button>
          ) : risk.status === "new" && canAcknowledge ? (
            <Button
              startIcon={<CheckCircle size={18} />}
              loading={acknowledging}
              onClick={onAcknowledge}
            >
              Принять в работу
            </Button>
          ) : risk.status !== "confirmed" && canConfirm ? (
            <Button
              startIcon={<CheckCircle size={18} />}
              loading={confirming}
              onClick={onConfirm}
            >
              Подтвердить прогноз
            </Button>
          ) : risk.status === "acknowledged" ? (
            <StatusBadge tone="info">Принят в работу</StatusBadge>
          ) : risk.status === "confirmed" ? (
            <StatusBadge tone="success">Инцидент зарегистрирован</StatusBadge>
          ) : null}
        </div>
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
      </div>
    </section>
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
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  risk: RiskForecast | null;
  facilityTarget: WorkOrderTarget;
  availableTargets: WorkOrderTarget[];
  initialTargetKey: string | null;
  duplicate?: { number: string; id: string };
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
      categoryCode: risk ? "predictive_maintenance" : "manual_inspection",
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
      categoryCode: risk ? "predictive_maintenance" : "manual_inspection",
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Новая заявка"
      description="Заявка будет привязана к конкретному оборудованию или датчику"
      size="large"
      footer={
        <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
          <Button variant="secondary" onClick={onClose}>
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
            <option value="predictive_maintenance">Предиктивное обслуживание</option>
            <option value="sensor_failure">Отказ датчика</option>
            <option value="equipment_fault">Неисправность оборудования</option>
            <option value="manual_inspection">Осмотр и диагностика</option>
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
            Данные формы сохранены. Повтори отправку после проверки соединения
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
  if (status === "attention") return "warning" as const;
  if (status === "normal") return "success" as const;
  return "neutral" as const;
}

function sensorStatus(status: string) {
  return { normal: "Норма", attention: "Внимание", alarm: "Тревога", offline: "Нет связи" }[status] ?? status;
}
