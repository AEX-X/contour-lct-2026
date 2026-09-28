import { ArrowLeft, Compass, LockKey } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

export function AccessDeniedPage() {
  return (
    <div className="page">
      <div className="page-state page-state--large">
        <LockKey size={46} weight="duotone" aria-hidden="true" />
        <h1>Доступ ограничен</h1>
        <p>У текущей роли нет прав на этот раздел. Данные недоступного объекта не раскрываются</p>
        <Link className="ui-button ui-button--primary ui-button--medium" to="/">
          <ArrowLeft size={18} /> Вернуться на главную
        </Link>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <div className="page-state page-state--large">
        <Compass size={46} weight="duotone" aria-hidden="true" />
        <h1>Страница не найдена</h1>
        <p>Проверь адрес или вернись на рабочий экран своей роли</p>
        <Link className="ui-button ui-button--primary ui-button--medium" to="/">На главную</Link>
      </div>
    </div>
  );
}
