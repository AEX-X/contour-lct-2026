import {
  ArrowClockwise,
  CloudSlash,
  FolderOpen,
  LockKey,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

export function PageLoading({ label = "Загружаем данные" }: { label?: string }) {
  return (
    <div className="page-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <strong>{label}</strong>
      <span>Это займёт несколько секунд</span>
    </div>
  );
}

export function PageError({
  title = "Не удалось загрузить данные",
  message = "Попробуй повторить запрос. Уже введённые данные не потеряны",
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="page-state page-state--error" role="alert">
      <WarningCircle size={34} weight="duotone" aria-hidden="true" />
      <strong>{title}</strong>
      <span>{message}</span>
      {onRetry ? (
        <button className="ui-button ui-button--secondary ui-button--medium" type="button" onClick={onRetry}>
          <ArrowClockwise size={18} aria-hidden="true" />
          Повторить
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-state">
      <FolderOpen size={34} weight="duotone" aria-hidden="true" />
      <strong>{title}</strong>
      <span>{description}</span>
      {action}
    </div>
  );
}

export function AccessDenied() {
  return (
    <div className="page">
      <div className="page-state page-state--large">
        <LockKey size={42} weight="duotone" aria-hidden="true" />
        <h1>Доступ ограничен</h1>
        <p>У текущей роли нет прав на этот раздел или объект</p>
        <a className="ui-button ui-button--primary ui-button--medium" href="/">
          Вернуться на главную
        </a>
      </div>
    </div>
  );
}

export function OfflineNoCache() {
  return (
    <div className="page-state" role="status">
      <CloudSlash size={34} weight="duotone" aria-hidden="true" />
      <strong>Нет офлайн-пакета</strong>
      <span>Подключись к сети и подготовь данные заявки перед выездом</span>
    </div>
  );
}
