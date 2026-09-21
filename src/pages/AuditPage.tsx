import { FileMagnifyingGlass, ShieldCheck } from "@phosphor-icons/react";
import { useState } from "react";
import { StatusBadge } from "../shared/ui";
import { useAuditTimeline, useWorkOrders } from "../app/dataHooks";
import { formatDateTime } from "../app/labels";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";

export function AuditPage() {
  const ordersQuery = useWorkOrders();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const fallbackId = ordersQuery.data?.[0]?.id;
  const entityId = selectedId ?? fallbackId;
  const auditQuery = useAuditTimeline("work_order", entityId);

  if (ordersQuery.isPending) return <PageLoading label="Загружаем журнал аудита" />;
  if (ordersQuery.isError) return <PageError onRetry={() => void ordersQuery.refetch()} />;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Журнал аудита</h1>
          <p className="page-header__meta">Локальный синтетический журнал значимых действий демо-сценария</p>
        </div>
        <StatusBadge tone="info" icon={ShieldCheck}>Демо-журнал</StatusBadge>
      </header>

      <div className="split-layout">
        <section className="surface">
          <header className="surface__header"><h2>Выбери заявку</h2></header>
          <div className="surface__body surface__body--flush">
            <ul className="plain-list">
              {ordersQuery.data.map((order) => (
                <li key={order.id}>
                  <button
                    className="attention-item"
                    type="button"
                    aria-current={entityId === order.id ? "true" : undefined}
                    onClick={() => setSelectedId(order.id)}
                  >
                    <span className="attention-item__icon bg-success" aria-hidden="true">
                      <FileMagnifyingGlass size={18} />
                    </span>
                    <span><strong>{order.number}</strong><small>{order.target.displayName}</small></span>
                    <span className="muted">v{order.version}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="surface">
          <header className="surface__header"><h2>События</h2></header>
          <div className="surface__body">
            {auditQuery.isPending ? (
              <PageLoading label="Загружаем события" />
            ) : auditQuery.isError ? (
              <PageError title="События недоступны" onRetry={() => void auditQuery.refetch()} />
            ) : auditQuery.data?.length ? (
              <ol className="audit-list">
                {auditQuery.data
                  .slice()
                  .reverse()
                  .map((event) => (
                    <li key={event.id}>
                      <span className="audit-list__time">{formatDateTime(event.occurredAt)}</span>
                      <strong>{event.action.replaceAll("_", " ")}</strong>
                      <span>{event.actor.displayName}</span>
                      <small>Версия {event.beforeVersion ?? "-"} → {event.afterVersion ?? "-"}</small>
                    </li>
                  ))}
              </ol>
            ) : (
              <EmptyState title="Событий нет" description="Для выбранной заявки аудит пока пуст" />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
