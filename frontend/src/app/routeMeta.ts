const pageTitles: Array<[prefix: string, title: string]> = [
  ["/my-facility/analytics", "Аналитика объекта"],
  ["/my-facility/orders", "Заявки объекта"],
  ["/my-facility/plan", "План объекта"],
  ["/my-facility/risks", "Риски объекта"],
  ["/maintenance/engineers", "Загрузка инженеров"],
  ["/maintenance/queue", "Ремонтная очередь"],
  ["/my-work/sync", "Синхронизация"],
  ["/city/list", "Объекты"],
  ["/city", "Оперативная картина"],
  ["/analytics", "Аналитика"],
  ["/operations", "Операции"],
  ["/my-facility", "Мой объект"],
  ["/my-work", "Мои работы"],
  ["/work-orders", "Заявки"],
  ["/facilities", "Объект"],
  ["/notifications", "Уведомления"],
  ["/audit", "Журнал аудита"],
  ["/settings", "Настройки"],
  ["/access-denied", "Доступ ограничен"],
];

export function getPageTitle(pathname: string): string {
  return pageTitles.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "Contour";
}

export function getDocumentTitle(pathname: string): string {
  const pageTitle = getPageTitle(pathname);
  return pageTitle === "Contour" ? pageTitle : `${pageTitle} · Contour`;
}
