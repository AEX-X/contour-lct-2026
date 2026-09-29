export const contourKeys = {
  all: ["contour"] as const,
  session: () => [...contourKeys.all, "session"] as const,
  profiles: () => [...contourKeys.all, "profiles"] as const,
  facilities: (actorId: string, params?: unknown) =>
    [...contourKeys.all, actorId, "facilities", params ?? {}] as const,
  facility: (actorId: string, facilityId: string) =>
    [...contourKeys.all, actorId, "facility", facilityId] as const,
  hierarchy: (actorId: string, facilityId: string) =>
    [...contourKeys.all, actorId, "hierarchy", facilityId] as const,
  equipment: (actorId: string, facilityId: string) =>
    [...contourKeys.all, actorId, "equipment", facilityId] as const,
  sensors: (actorId: string, facilityId: string) =>
    [...contourKeys.all, actorId, "sensors", facilityId] as const,
  risks: (actorId: string, params?: unknown) =>
    [...contourKeys.all, actorId, "risks", params ?? {}] as const,
  incidents: (actorId: string, facilityId?: string) =>
    [...contourKeys.all, actorId, "incidents", facilityId ?? "all"] as const,
  workOrders: (actorId: string, params?: unknown) =>
    [...contourKeys.all, actorId, "work-orders", params ?? {}] as const,
  workOrder: (actorId: string, workOrderId: string) =>
    [...contourKeys.all, actorId, "work-order", workOrderId] as const,
  engineers: (actorId: string, workOrderId: string) =>
    [...contourKeys.all, actorId, "engineers", workOrderId] as const,
  maintenanceEngineers: (actorId: string) =>
    [...contourKeys.all, actorId, "maintenance-engineers"] as const,
  facilityDispatchers: (actorId: string) =>
    [...contourKeys.all, actorId, "facility-dispatchers"] as const,
  notifications: (actorId: string) =>
    [...contourKeys.all, actorId, "notifications"] as const,
  audit: (actorId: string, entityType: string, entityId: string) =>
    [...contourKeys.all, actorId, "audit", entityType, entityId] as const,
  metrics: (actorId: string) => [...contourKeys.all, actorId, "metrics"] as const,
  referenceConfig: () => [...contourKeys.all, "reference-config"] as const,
  modelQuality: (actorId: string) => [...contourKeys.all, actorId, "model-quality"] as const,
  sourceHealth: (actorId: string) => [...contourKeys.all, actorId, "source-health"] as const,
};
