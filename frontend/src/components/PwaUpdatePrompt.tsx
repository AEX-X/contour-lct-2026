import { ArrowClockwise, CheckCircle, X } from "@phosphor-icons/react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button, IconButton } from "../shared/ui";

export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh && !offlineReady) return null;

  return (
    <aside className="pwa-update" role="status" aria-live="polite" aria-label="Состояние приложения">
      <div className="pwa-update__icon" aria-hidden="true">
        {needRefresh ? <ArrowClockwise size={22} /> : <CheckCircle size={22} />}
      </div>
      <div className="pwa-update__copy">
        <strong>{needRefresh ? "Доступна новая версия" : "Приложение готово к работе без сети"}</strong>
        <p>
          {needRefresh
            ? "Перед обновлением сохрани открытую форму и синхронизируй локальные отчёты"
            : "Основные экраны закешированы на этом устройстве"}
        </p>
      </div>
      {needRefresh ? (
        <div className="pwa-update__actions">
          <Button variant="secondary" onClick={() => setNeedRefresh(false)}>
            Позже
          </Button>
          <Button onClick={() => void updateServiceWorker(true)}>Обновить</Button>
        </div>
      ) : (
        <IconButton
          label="Закрыть сообщение"
          icon={<X size={18} />}
          onClick={() => setOfflineReady(false)}
        />
      )}
    </aside>
  );
}
