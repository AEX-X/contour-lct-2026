import { Check } from "@phosphor-icons/react";
import type { AuditEvent, WorkOrder } from "../domain";
import { formatDateTime, statusLabels } from "../app/labels";

export function WorkOrderTimeline({ workOrder, events }: { workOrder: WorkOrder; events: AuditEvent[] }) {
  const sorted = [...events].sort(
    (first, second) => new Date(second.occurredAt).getTime() - new Date(first.occurredAt).getTime(),
  );

  return (
    <ol className="timeline" aria-label={`История заявки ${workOrder.number}`}>
      {sorted.length ? (
        sorted.map((event) => (
          <li className="timeline__item" key={event.id}>
            <span className="timeline__marker" aria-hidden="true">
              <Check size={11} color="white" weight="bold" />
            </span>
            <div className="timeline__content">
              <strong>{getAuditActionLabel(event.action)}</strong>
              <small>
                {event.actor.displayName} · {formatDateTime(event.occurredAt)}
              </small>
              {event.reason ? <small>Причина: {event.reason}</small> : null}
            </div>
          </li>
        ))
      ) : (
        <li className="timeline__item">
          <span className="timeline__marker" aria-hidden="true" />
          <div className="timeline__content">
            <strong>Текущий статус: {statusLabels[workOrder.status]}</strong>
            <small>{formatDateTime(workOrder.updatedAt)}</small>
          </div>
        </li>
      )}
    </ol>
  );
}

function getAuditActionLabel(action: string) {
  const labels: Record<string, string> = {
    create: "Заявка создана",
    work_order_created: "Заявка создана",
    submit: "Заявка отправлена",
    start_triage: "Начат триаж",
    finalize_priority: "Зафиксированы приоритет и SLA",
    assign: "Назначен инженер",
    accept: "Инженер принял заявку",
    mark_en_route: "Инженер выехал",
    start_work: "Работа начата",
    submit_result: "Результат передан",
    start_verification: "Начата проверка",
    return_for_rework: "Возвращено на доработку",
    close: "Заявка закрыта",
    cancel: "Заявка отменена",
  };
  return labels[action] ?? action.replaceAll("_", " ");
}
