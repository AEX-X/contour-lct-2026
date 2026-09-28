import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  Info,
  Warning,
  WarningOctagon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, InlineAlert, SegmentedControl, StatusBadge } from "../shared/ui";
import { useNotifications } from "../app/dataHooks";
import { useContour } from "../app/ContourProvider";
import { formatDateTime } from "../app/labels";
import { EmptyState, PageError, PageLoading } from "../components/StateViews";
import { RepositoryError } from "../domain";

export function NotificationsPage() {
  const navigate = useNavigate();
  const { repository, invalidateAll } = useContour();
  const notificationsQuery = useNotifications();
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const [openError, setOpenError] = useState<string | null>(null);
  const readMutation = useMutation({
    mutationFn: (notificationId: string) => repository.markNotificationRead(notificationId),
    onSuccess: () => invalidateAll(),
    retry: (failureCount, error) =>
      failureCount < 2 && error instanceof RepositoryError && error.code === "SOURCE_UNAVAILABLE",
  });

  const notifications = useMemo(
    () =>
      [...(notificationsQuery.data ?? [])]
        .filter((item) => filter === "all" || !item.readAt)
        .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt)),
    [filter, notificationsQuery.data],
  );

  if (notificationsQuery.isPending) return <PageLoading label="Загружаем уведомления" />;
  if (notificationsQuery.isError) return <PageError onRetry={() => void notificationsQuery.refetch()} />;

  async function openNotification(notificationId: string, deepLink: string, alreadyRead: boolean) {
    setOpenError(null);
    if (!deepLink.startsWith("/") || deepLink.startsWith("//") || deepLink.includes("\\")) {
      setOpenError("Ссылка из уведомления некорректна");
      return;
    }
    navigate(deepLink);
    if (!alreadyRead) void readMutation.mutateAsync(notificationId).catch(() => undefined);
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Уведомления</h1>
          <p className="page-header__meta">События, требующие внимания текущей роли</p>
        </div>
        <SegmentedControl
          label="Фильтр уведомлений"
          value={filter}
          onChange={(value) => setFilter(value as "unread" | "all")}
          items={[
            { value: "unread", label: "Непрочитанные" },
            { value: "all", label: "Все" },
          ]}
        />
      </header>

      {openError ? <InlineAlert tone="critical" title="Уведомление не открыто" onDismiss={() => setOpenError(null)}>{openError}</InlineAlert> : null}

      <section className="surface notification-center">
        {notifications.length ? (
          <ul className="plain-list">
            {notifications.map((notification) => {
              const Icon = notification.priority === "critical" ? WarningOctagon : notification.priority === "warning" ? Warning : Info;
              return (
                <li key={notification.id}>
                  <button
                    className="notification-row"
                    type="button"
                    data-unread={!notification.readAt}
                    onClick={() => void openNotification(notification.id, notification.deepLink, Boolean(notification.readAt))}
                  >
                    <span className={`notification-row__icon bg-${notification.priority === "critical" ? "danger" : notification.priority}`}>
                      <Icon size={20} weight="fill" aria-hidden="true" />
                    </span>
                    <span>
                      <span className="notification-row__top">
                        <strong>{notification.title}</strong>
                        {!notification.readAt ? <StatusBadge tone="info">Новое</StatusBadge> : null}
                      </span>
                      <span className="muted">{notification.body}</span>
                      <small>{formatDateTime(notification.createdAt)}</small>
                    </span>
                    <ArrowRight size={19} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            title={filter === "unread" ? "Новых уведомлений нет" : "Уведомлений пока нет"}
            description="Здесь появятся назначения, изменения SLA и решения по заявкам"
            action={
              filter === "unread" ? (
                <Button variant="secondary" onClick={() => setFilter("all")}>Показать прочитанные</Button>
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}
