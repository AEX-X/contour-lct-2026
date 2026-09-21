import { ArrowsClockwise, Cloud, CloudSlash, UserCircle } from "@phosphor-icons/react";
import { useState } from "react";
import { Button, InlineAlert, Modal, StatusBadge } from "../shared/ui";
import { useContour } from "../app/ContourProvider";
import { roleLabels } from "../app/labels";

export function SettingsPage() {
  const { currentUser, isOnline, setIsOnline, resetDemo } = useContour();
  const [resetting, setResetting] = useState(false);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function handleReset() {
    setResetting(true);
    setResetError(null);
    try {
      await resetDemo();
      setResetConfirmationOpen(false);
    } catch {
      setResetError("Сброс выполнен не полностью. Повтори действие перед продолжением работы");
    } finally {
      setResetting(false);
    }
  }
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Профиль и демо-настройки</h1>
          <p className="page-header__meta">Параметры текущей демонстрационной сессии</p>
        </div>
      </header>
      <div className="split-layout">
        <section className="surface">
          <header className="surface__header"><h2>Текущий профиль</h2></header>
          <div className="surface__body content-stack">
            <div className="profile-summary">
              <span className="profile-menu__avatar"><UserCircle size={26} /></span>
              <div><strong>{currentUser.displayName}</strong><p className="muted">{roleLabels[currentUser.role]}</p></div>
            </div>
            <dl className="definition-grid">
              <dt>Организация</dt><dd>{currentUser.organization.displayName}</dd>
              <dt>Область доступа</dt><dd>{currentUser.scope.type}</dd>
              <dt>Часовой пояс</dt><dd>{currentUser.timezone}</dd>
              <dt>Разрешений</dt><dd>{currentUser.permissions.length}</dd>
            </dl>
          </div>
        </section>
        <aside className="content-stack">
          <section className="surface">
            <header className="surface__header"><h2>Имитация сети</h2></header>
            <div className="surface__body content-stack">
              <StatusBadge tone={isOnline ? "success" : "warning"}>
                {isOnline ? "Онлайн" : "Офлайн"}
              </StatusBadge>
              <p className="muted">Используется для проверки мобильного сценария инженера</p>
              <Button
                variant="secondary"
                startIcon={isOnline ? <CloudSlash size={18} /> : <Cloud size={18} />}
                onClick={() => setIsOnline(!isOnline)}
              >
                Переключить в {isOnline ? "офлайн" : "онлайн"}
              </Button>
            </div>
          </section>
          <InlineAlert tone="warning" title="Сброс демонстрации">
            Удалит изменения заявок и вернёт исходный сценарий. Это действие относится только к локальному прототипу
          </InlineAlert>
          {resetError ? (
            <InlineAlert tone="critical" title="Не удалось завершить сброс">
              {resetError}
            </InlineAlert>
          ) : null}
          <Button
            variant="danger"
            startIcon={<ArrowsClockwise size={18} />}
            loading={resetting}
            onClick={() => setResetConfirmationOpen(true)}
          >
            Сбросить сценарий
          </Button>
        </aside>
      </div>
      <Modal
        open={resetConfirmationOpen}
        onClose={() => !resetting && setResetConfirmationOpen(false)}
        title="Сбросить демонстрационный сценарий?"
        description="Действие нельзя отменить"
        closeOnBackdrop={!resetting}
        closeOnEscape={!resetting}
        footer={
          <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button variant="secondary" disabled={resetting} onClick={() => setResetConfirmationOpen(false)}>Отмена</Button>
            <Button variant="danger" loading={resetting} onClick={() => void handleReset()}>Удалить изменения и сбросить</Button>
          </div>
        }
      >
        <p>Будут удалены локальные изменения заявок, офлайн-пакеты и несинхронизированные отчёты инженера. Затем восстановятся исходные демо-данные</p>
      </Modal>
    </div>
  );
}
