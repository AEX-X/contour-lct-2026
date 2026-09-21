import type {
  DemoRole,
  FacilityStatus,
  RiskSeverity,
  WorkOrderAction,
  WorkOrderPriority,
  WorkOrderStatus,
} from "../domain";

export const roleLabels: Record<DemoRole, string> = {
  manager: "Руководитель",
  senior_dispatcher: "Старший диспетчер",
  facility_dispatcher: "Диспетчер объекта",
  maintenance_coordinator: "Координатор ремонтов",
  engineer: "Инженер",
};

export const statusLabels: Record<WorkOrderStatus, string> = {
  draft: "Черновик",
  submitted: "Отправлена",
  triage: "Триаж",
  needs_clarification: "Нужно уточнение",
  assigned: "Назначена",
  accepted: "Принята",
  en_route: "Инженер в пути",
  in_progress: "В работе",
  waiting_access: "Ожидает доступа",
  waiting_parts: "Ожидает запчастей",
  completed_by_engineer: "Работа выполнена",
  verification: "На проверке",
  rework: "На доработке",
  closed: "Закрыта",
  cancelled: "Отменена",
};

export const facilityStatusLabels: Record<FacilityStatus, string> = {
  normal: "Норма",
  attention: "Требует внимания",
  critical: "Инцидент",
  no_data: "Нет данных",
};

export const priorityLabels: Record<WorkOrderPriority, string> = {
  P1: "P1 - аварийная",
  P2: "P2 - срочная",
  P3: "P3 - плановая",
  P4: "P4 - низкая",
};

export const riskSeverityLabels: Record<RiskSeverity, string> = {
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  critical: "Критический",
};

export const actionLabels: Record<WorkOrderAction, string> = {
  edit: "Изменить",
  submit: "Отправить заявку",
  start_triage: "Начать триаж",
  request_clarification: "Запросить уточнение",
  resubmit_clarification: "Отправить повторно",
  finalize_priority: "Зафиксировать приоритет",
  assign: "Назначить инженера",
  reassign: "Переназначить",
  accept: "Принять работу",
  decline: "Отказаться",
  mark_en_route: "Выехать",
  start_work: "Начать работу",
  wait_access: "Ожидать доступ",
  wait_parts: "Ожидать запчасти",
  resume_work: "Продолжить работу",
  submit_result: "Передать результат",
  start_verification: "Начать проверку",
  return_for_rework: "Вернуть на доработку",
  close: "Принять и закрыть",
  cancel: "Отменить",
  override: "Управленческое решение",
};

export function getStatusTone(status: WorkOrderStatus) {
  if (["closed"].includes(status)) return "success" as const;
  if (["cancelled"].includes(status)) return "neutral" as const;
  if (["needs_clarification", "waiting_access", "waiting_parts", "rework"].includes(status)) {
    return "warning" as const;
  }
  if (["submitted", "triage", "verification", "completed_by_engineer"].includes(status)) {
    return "purple" as const;
  }
  return "info" as const;
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "Нет данных";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

export function formatPercent(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

export function pluralizeRu(count: number, forms: readonly [one: string, few: string, many: string]) {
  const absolute = Math.abs(count) % 100;
  const lastDigit = absolute % 10;
  if (absolute >= 11 && absolute <= 14) return forms[2];
  if (lastDigit === 1) return forms[0];
  if (lastDigit >= 2 && lastDigit <= 4) return forms[1];
  return forms[2];
}
