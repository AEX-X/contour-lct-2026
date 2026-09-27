import {
  ArrowsClockwise,
  Bell,
  Buildings,
  CaretDown,
  ChartLineUp,
  Check,
  ClipboardText,
  DotsThree,
  GearSix,
  HardHat,
  House,
  MagnifyingGlass,
  Pulse,
  SignOut,
  SquaresFour,
  UserCircle,
  UsersThree,
  Wrench,
} from "@phosphor-icons/react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { DemoRole } from "../domain";
import { Button, Modal } from "../shared/ui";
import { useNotifications } from "./dataHooks";
import { useContour } from "./ContourProvider";
import { roleLabels } from "./labels";
import { getPageTitle } from "./routeMeta";

interface NavigationItem {
  label: string;
  to: string;
  icon: typeof House;
  end?: boolean;
}

const navigationByRole: Record<DemoRole, NavigationItem[]> = {
  manager: [
    { label: "Обзор", to: "/city", icon: House, end: true },
    { label: "Объекты", to: "/city/list", icon: Buildings },
    { label: "Операции", to: "/operations", icon: SquaresFour },
    { label: "Ремонты", to: "/maintenance/queue", icon: Wrench },
    { label: "Заявки", to: "/work-orders", icon: ClipboardText },
    { label: "Аналитика", to: "/analytics", icon: ChartLineUp },
    { label: "Аудит", to: "/audit", icon: Pulse },
  ],
  senior_dispatcher: [
    { label: "Операции", to: "/operations", icon: SquaresFour, end: true },
    { label: "Объекты", to: "/city/list", icon: Buildings },
    { label: "Заявки", to: "/work-orders", icon: ClipboardText },
    { label: "Уведомления", to: "/notifications", icon: Bell },
  ],
  facility_dispatcher: [
    { label: "Мой объект", to: "/my-facility", icon: Buildings, end: true },
    { label: "Риски", to: "/my-facility/risks", icon: Pulse },
    { label: "Заявки", to: "/work-orders", icon: ClipboardText },
    { label: "Уведомления", to: "/notifications", icon: Bell },
  ],
  maintenance_coordinator: [
    { label: "Очередь", to: "/maintenance/queue", icon: ClipboardText, end: true },
    { label: "Инженеры", to: "/maintenance/engineers", icon: UsersThree },
    { label: "Заявки", to: "/work-orders", icon: Wrench },
    { label: "Уведомления", to: "/notifications", icon: Bell },
  ],
  engineer: [
    { label: "Мои работы", to: "/my-work", icon: HardHat, end: true },
    { label: "Синхронизация", to: "/my-work/sync", icon: ArrowsClockwise },
    { label: "Уведомления", to: "/notifications", icon: Bell },
  ],
};

function Brand() {
  return (
    <NavLink className="brand" to="/" aria-label="Contour, главная">
      <span className="brand__mark" aria-hidden="true">
        <Pulse size={22} weight="bold" />
      </span>
      <span className="brand__copy">
        <span className="brand__name">Contour</span>
        <span className="brand__tagline">Инженерная инфраструктура</span>
      </span>
    </NavLink>
  );
}

function ProfileMenu() {
  const { currentUser, profiles, runtime, switchUser, resetDemo, signOut } = useContour();
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [resetConfirmationOpen, setResetConfirmationOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  async function handleSwitchUser(userId: string) {
    setPendingAction(`user:${userId}`);
    setMenuError(null);
    try {
      await switchUser(userId);
      setOpen(false);
    } catch {
      setMenuError("Не удалось переключить роль. Повтори попытку");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleResetDemo() {
    setPendingAction("reset");
    setMenuError(null);
    try {
      await resetDemo();
      setOpen(false);
      setResetConfirmationOpen(false);
    } catch {
      setMenuError("Сброс выполнен не полностью. Повтори действие перед продолжением работы");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleSignOut() {
    setPendingAction("sign-out");
    setMenuError(null);
    try {
      await signOut();
    } catch {
      setMenuError("Не удалось завершить backend-сессию. Обнови страницу и повтори попытку");
      setPendingAction(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!resetConfirmationOpen && !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !resetConfirmationOpen) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, resetConfirmationOpen]);

  return (
    <div className="profile-menu" ref={rootRef}>
      <button
        className="profile-menu__trigger"
        type="button"
        aria-expanded={open}
        aria-controls="profile-options"
        aria-label={runtime.supportsDemoRoleSwitch
          ? `Профиль: ${roleLabels[currentUser.role]}. Переключить роль`
          : `Профиль: ${roleLabels[currentUser.role]}. Открыть меню сессии`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="profile-menu__avatar" aria-hidden="true">
          <UserCircle size={24} weight="fill" />
        </span>
        <span>{roleLabels[currentUser.role]}</span>
        <CaretDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="profile-popover" id="profile-options" aria-label="Профиль и сессия">
          <p className="profile-popover__title">
            {runtime.supportsDemoRoleSwitch ? "Переключить демо-роль" : runtime.label}
          </p>
          {runtime.supportsDemoRoleSwitch ? profiles.map((profile) => (
              <button
                key={profile.id}
                className="profile-popover__option"
                type="button"
                disabled={pendingAction !== null}
                aria-busy={pendingAction === `user:${profile.id}` || undefined}
                aria-pressed={profile.id === currentUser.id}
                aria-current={profile.id === currentUser.id ? "true" : undefined}
                onClick={() => void handleSwitchUser(profile.id)}
              >
                <span className="profile-menu__avatar" aria-hidden="true">
                  <UserCircle size={22} />
                </span>
                <span>
                  <strong>{profile.displayName}</strong>
                  <small>{roleLabels[profile.role]}</small>
                </span>
                {profile.id === currentUser.id ? <Check size={18} weight="bold" /> : null}
              </button>
            )) : (
              <div className="profile-popover__session">
                <strong>{currentUser.displayName}</strong>
                <small>{runtime.description}</small>
              </div>
            )}
          {runtime.supportsDemoReset ? (
            <button
              className="profile-popover__option"
              type="button"
              disabled={pendingAction !== null}
              aria-busy={pendingAction === "reset" || undefined}
              onClick={() => setResetConfirmationOpen(true)}
            >
              <span className="profile-menu__avatar" aria-hidden="true">
                <ArrowsClockwise size={20} />
              </span>
              <span>
                <strong>Сбросить сценарий</strong>
                <small>Вернуть исходные демо-данные</small>
              </span>
            </button>
          ) : (
            <button
              className="profile-popover__option"
              type="button"
              disabled={pendingAction !== null}
              aria-busy={pendingAction === "sign-out" || undefined}
              onClick={() => void handleSignOut()}
            >
              <span className="profile-menu__avatar" aria-hidden="true"><SignOut size={20} /></span>
              <span><strong>Выйти</strong><small>Завершить backend-сессию</small></span>
            </button>
          )}
          {menuError ? (
            <p className="profile-popover__error" role="alert">
              {menuError}
            </p>
          ) : null}
          {runtime.supportsDemoReset ? <Modal
            open={resetConfirmationOpen}
            onClose={() => pendingAction !== "reset" && setResetConfirmationOpen(false)}
            title="Сбросить демонстрационный сценарий?"
            description="Действие нельзя отменить"
            closeOnBackdrop={pendingAction !== "reset"}
            closeOnEscape={pendingAction !== "reset"}
            footer={
              <div className="inline-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
                <Button variant="secondary" disabled={pendingAction === "reset"} onClick={() => setResetConfirmationOpen(false)}>Отмена</Button>
                <Button variant="danger" loading={pendingAction === "reset"} onClick={() => void handleResetDemo()}>Удалить изменения и сбросить</Button>
              </div>
            }
          >
            <p>Будут удалены локальные изменения заявок, офлайн-пакеты и несинхронизированные отчёты инженера. Затем восстановятся исходные демо-данные</p>
          </Modal> : null}
        </div>
      ) : null}
    </div>
  );
}

function SideNavigation() {
  const { currentUser, runtime } = useContour();
  const items = navigationByRole[currentUser.role].filter(
    (item) => runtime.mode !== "api" || !["/maintenance/queue", "/notifications"].includes(item.to),
  );
  return (
    <aside className="side-navigation">
      <Brand />
      <nav aria-label="Основная навигация">
        <ul className="side-navigation__list">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <NavLink
                  className="side-navigation__link"
                  to={item.to}
                  end={item.end}
                  title={item.label}
                >
                  <Icon size={21} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="side-navigation__footer">
        <NavLink className="side-navigation__link" to="/settings" title="Настройки">
          <GearSix size={21} aria-hidden="true" />
          <span>Настройки</span>
        </NavLink>
      </div>
    </aside>
  );
}

function AppHeader() {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentUser, repository, runtime } = useContour();
  const [search, setSearch] = useState("");
  const notifications = useNotifications();
  const unreadCount = notifications.data?.filter((item) => !item.readAt).length ?? 0;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = search.trim();
    const encoded = encodeURIComponent(value);
    const looksLikeWorkOrder = /^wo[-\s]/i.test(value);
    if (currentUser.role === "engineer") {
      navigate(value ? `/my-work?q=${encoded}` : "/my-work");
      return;
    }
    if (["facility_dispatcher", "maintenance_coordinator"].includes(currentUser.role) || looksLikeWorkOrder) {
      navigate(value ? `/work-orders?q=${encoded}` : "/work-orders");
      return;
    }
    navigate(value ? `/city/list?q=${encoded}` : "/city/list");
  };

  useEffect(() => {
    const routeQuery = new URLSearchParams(location.search).get("q") ?? "";
    queueMicrotask(() => setSearch(routeQuery));
  }, [location.search]);

  const searchLabel = currentUser.role === "engineer"
    ? "Найти назначенную работу"
    : ["facility_dispatcher", "maintenance_coordinator"].includes(currentUser.role)
      ? "Найти заявку"
      : "Найти объект, адрес или заявку";
  const snapshotTime = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(repository.getSnapshot().demoClockIso));

  return (
    <header className="app-header">
      <NavLink className="mobile-brand" to="/" aria-label="Contour, главная">
        <span className="mobile-brand__mark" aria-hidden="true">
          <Pulse size={20} weight="bold" />
        </span>
        <span>Contour</span>
      </NavLink>
      <form className="header-search" role="search" onSubmit={onSubmit}>
        <MagnifyingGlass size={19} aria-hidden="true" />
        <label className="sr-only" htmlFor="global-search">
          {searchLabel}
        </label>
        <input
          id="global-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={searchLabel}
        />
      </form>
      <div className="header-spacer" />
      <span className="demo-badge" data-mode={runtime.mode}>
        {runtime.mode === "api" ? "Backend API" : "Демо-данные"}
      </span>
      <div className="freshness">
        <span className="freshness__dot" aria-hidden="true" />
        <span>
          {runtime.mode === "api" ? "Время запроса" : "Время сценария"}
          <br />{snapshotTime}
        </span>
      </div>
      {runtime.mode === "mock" ? (
        <NavLink
          className="icon-button app-header__desktop-only"
          to="/notifications"
          aria-label={`Уведомления: ${unreadCount} непрочитанных`}
        >
          <Bell size={21} aria-hidden="true" />
          {unreadCount ? <span className="notification-count">{unreadCount}</span> : null}
        </NavLink>
      ) : null}
      <ProfileMenu />
    </header>
  );
}

function MobileNavigation({ role }: { role: DemoRole }) {
  const location = useLocation();
  const { runtime } = useContour();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const items: NavigationItem[] = navigationByRole[role].filter(
    (item) => runtime.mode !== "api" || !["/maintenance/queue", "/notifications"].includes(item.to),
  );
  if (runtime.mode === "mock" && !items.some((item) => item.to === "/notifications")) {
    items.push({ to: "/notifications", label: "Уведомления", icon: Bell });
  }
  items.push({ to: "/settings", label: "Настройки", icon: GearSix });
  const primaryItems = items.slice(0, 4);
  const overflowItems = items.slice(4);
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [location.pathname]);
  return (
    <nav className="mobile-bottom-nav" aria-label="Основная мобильная навигация">
      {primaryItems.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink key={item.to} to={item.to} end={item.end}>
            <Icon size={21} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
      {overflowItems.length ? (
        <details className="mobile-more" ref={detailsRef}>
          <summary>
            <DotsThree size={22} aria-hidden="true" />
            <span>Ещё</span>
          </summary>
          <div className="mobile-more__menu">
            {overflowItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  <Icon size={20} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>
        </details>
      ) : null}
    </nav>
  );
}

function RouteFocus() {
  const location = useLocation();
  const liveText = `Открыта страница ${getPageTitle(location.pathname)}`;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname]);
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {liveText}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { currentUser } = useContour();
  return (
    <div className="app-shell" data-role={currentUser.role}>
      <a className="skip-link" href="#main-content">
        Перейти к основному содержимому
      </a>
      <SideNavigation />
      <AppHeader />
      <main className="app-main" id="main-content" tabIndex={-1}>
        <RouteFocus />
        {children}
      </main>
      <MobileNavigation role={currentUser.role} />
    </div>
  );
}
