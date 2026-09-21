import { useQuery } from "@tanstack/react-query";
import type {
  Facility,
  RiskForecast,
  WorkOrderStatus,
} from "../domain";
import type {
  FacilityListParams,
  RiskListParams,
  WorkOrderListParams,
} from "../repositories";
import { useContour } from "./ContourProvider";
import { contourKeys } from "./queryKeys";

export function useFacilities(
  params?: FacilityListParams,
  options?: { keepPreviousData?: boolean },
) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.facilities(currentUser.id, params),
    queryFn: () => repository.listFacilities(params),
    placeholderData: options?.keepPreviousData
      ? (previousData) => previousData
      : undefined,
  });
}

export function useFacility(facilityId: string | undefined) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.facility(currentUser.id, facilityId ?? "missing"),
    queryFn: () => repository.getFacility(facilityId!),
    enabled: Boolean(facilityId),
  });
}

export function useFacilityContext(facilityId: string | undefined) {
  const { repository, currentUser } = useContour();
  const enabled = Boolean(facilityId);
  const hierarchy = useQuery({
    queryKey: contourKeys.hierarchy(currentUser.id, facilityId ?? "missing"),
    queryFn: () => repository.getFacilityHierarchy(facilityId!),
    enabled,
  });
  const equipment = useQuery({
    queryKey: contourKeys.equipment(currentUser.id, facilityId ?? "missing"),
    queryFn: () => repository.listEquipment(facilityId!),
    enabled,
  });
  const sensors = useQuery({
    queryKey: contourKeys.sensors(currentUser.id, facilityId ?? "missing"),
    queryFn: () => repository.listSensors(facilityId!),
    enabled,
  });
  return { hierarchy, equipment, sensors };
}

export function useRisks(params?: RiskListParams) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.risks(currentUser.id, params),
    queryFn: () => repository.listRisks(params),
  });
}

export function useIncidents(facilityId?: string) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.incidents(currentUser.id, facilityId),
    queryFn: () => repository.listIncidents(facilityId),
  });
}

export function useWorkOrders(params?: WorkOrderListParams) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.workOrders(currentUser.id, params),
    queryFn: () => repository.listWorkOrders(params),
  });
}

export function useWorkOrder(workOrderId: string | undefined) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.workOrder(currentUser.id, workOrderId ?? "missing"),
    queryFn: () => repository.getWorkOrder(workOrderId!),
    enabled: Boolean(workOrderId),
  });
}

export function useEngineerCandidates(workOrderId: string | undefined) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.engineers(currentUser.id, workOrderId ?? "missing"),
    queryFn: () => repository.listEngineerCandidates(workOrderId!),
    enabled: Boolean(workOrderId),
  });
}

export function useMaintenanceEngineers() {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.maintenanceEngineers(currentUser.id),
    queryFn: () => repository.listMaintenanceEngineers(),
  });
}

export function useFacilityDispatchers() {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.facilityDispatchers(currentUser.id),
    queryFn: () => repository.listFacilityDispatchers(),
  });
}

export function useNotifications() {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.notifications(currentUser.id),
    queryFn: () => repository.listNotifications(),
  });
}

export function useAuditTimeline(entityType: string, entityId: string | undefined) {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.audit(currentUser.id, entityType, entityId ?? "missing"),
    queryFn: () => repository.getAuditTimeline(entityType, entityId!),
    enabled: Boolean(entityId),
  });
}

export function useDashboardMetrics() {
  const { repository, currentUser } = useContour();
  return useQuery({
    queryKey: contourKeys.metrics(currentUser.id),
    queryFn: () => repository.getDashboardMetrics(),
  });
}

export function facilityHasUnresolvedForecast(
  facility: Facility,
  risks: RiskForecast[],
) {
  return risks.some(
    (risk) =>
      risk.facilityId === facility.id &&
      ["new", "acknowledged"].includes(risk.status) &&
      ["high", "critical"].includes(risk.severity),
  );
}

export const activeWorkOrderStatuses: WorkOrderStatus[] = [
  "draft",
  "submitted",
  "triage",
  "needs_clarification",
  "assigned",
  "accepted",
  "en_route",
  "in_progress",
  "waiting_access",
  "waiting_parts",
  "completed_by_engineer",
  "verification",
  "rework",
];
