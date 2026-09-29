import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router-dom";
import type { DemoRole } from "../domain";
import { AccessDeniedPage, NotFoundPage } from "../pages/SystemPages";
import { PageLoading } from "../components/StateViews";
import { AppShell } from "./AppShell";
import { useContour } from "./ContourProvider";
import { getDocumentTitle } from "./routeMeta";

const AnalyticsPage = lazy(() =>
  import("../pages/AnalyticsPage").then((module) => ({ default: module.AnalyticsPage })),
);
const AuditPage = lazy(() => import("../pages/AuditPage").then((module) => ({ default: module.AuditPage })));
const CityPage = lazy(() => import("../pages/CityPage").then((module) => ({ default: module.CityPage })));
const FacilityPage = lazy(() => import("../pages/FacilityPage").then((module) => ({ default: module.FacilityPage })));
const MaintenancePage = lazy(() => import("../pages/MaintenancePage").then((module) => ({ default: module.MaintenancePage })));
const EngineersPage = lazy(() => import("../pages/EngineersPage").then((module) => ({ default: module.EngineersPage })));
const NotificationsPage = lazy(() => import("../pages/NotificationsPage").then((module) => ({ default: module.NotificationsPage })));
const OperationsPage = lazy(() => import("../pages/OperationsPage").then((module) => ({ default: module.OperationsPage })));
const SettingsPage = lazy(() => import("../pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));
const WorkOrderPage = lazy(() => import("../pages/WorkOrderPage").then((module) => ({ default: module.WorkOrderPage })));
const WorkOrdersListPage = lazy(() => import("../pages/WorkOrdersListPage").then((module) => ({ default: module.WorkOrdersListPage })));
const EngineerWorkspace = lazy(() =>
  import("../pages/engineer").then((module) => ({ default: module.EngineerWorkspace })),
);

function DocumentTitle() {
  const location = useLocation();
  useEffect(() => {
    document.title = getDocumentTitle(location.pathname);
  }, [location.pathname]);
  return null;
}

function RoleGuard({ roles, children }: { roles: DemoRole[]; children: ReactNode }) {
  const { currentUser } = useContour();
  if (roles.includes(currentUser.role)) return children;
  return <Navigate to="/access-denied" replace />;
}

type FacilitySection = "overview" | "plan" | "analytics" | "orders" | "risks";

function FacilityGuard({ section = "overview" }: { section?: FacilitySection }) {
  const { facilityId } = useParams();
  const { currentUser } = useContour();
  const roleAllowed = ["manager", "senior_dispatcher", "facility_dispatcher", "maintenance_coordinator"].includes(currentUser.role);
  const capabilityAllowed = currentUser.permissions.includes("facility.technical_context.read");
  const scopeAllowed =
    ["manager", "maintenance_coordinator"].includes(currentUser.role) ||
    (facilityId ? currentUser.scope.facilityIds.includes(facilityId) : false);
  if (!roleAllowed || !capabilityAllowed || !scopeAllowed) return <Navigate to="/access-denied" replace />;
  return <FacilityPage section={section} />;
}

function HomeRedirect() {
  const { currentUser } = useContour();
  return <Navigate to={currentUser.homeRoute} replace />;
}

function MyFacilityPage({ section = "overview" }: { section?: FacilitySection }) {
  const { currentUser } = useContour();
  const facilityId = currentUser.scope.facilityIds[0];
  if (!facilityId) return <Navigate to="/access-denied" replace />;
  return <FacilityPage facilityId={facilityId} section={section} />;
}

function EngineerRoute() {
  const { currentUser, repository, invalidateAll, isOnline, setIsOnline } = useContour();
  return (
    <EngineerWorkspace
      currentUser={currentUser}
      repository={repository}
      onInvalidateQueries={invalidateAll}
      isOnline={isOnline}
      onOnlineChange={setIsOnline}
    />
  );
}

function WorkOrderRoute() {
  const { workOrderId } = useParams();
  return <WorkOrderPage key={workOrderId ?? "missing"} />;
}

function MaintenanceRoute() {
  const [searchParams] = useSearchParams();
  return <MaintenancePage key={searchParams.get("workOrder") ?? "queue"} />;
}

export function App() {
  return (
    <AppShell>
      <DocumentTitle />
      <Suspense fallback={<PageLoading label="Открываем рабочий экран" />}>
        <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route
          path="/city"
          element={
            <RoleGuard roles={["manager"]}>
              <CityPage />
            </RoleGuard>
          }
        />
        <Route
          path="/city/list"
          element={
            <RoleGuard roles={["manager", "senior_dispatcher"]}>
              <CityPage initialView="list" />
            </RoleGuard>
          }
        />
        <Route path="/facilities/:facilityId" element={<FacilityGuard />} />
        <Route path="/facilities/:facilityId/plan" element={<FacilityGuard section="plan" />} />
        <Route path="/facilities/:facilityId/analytics" element={<FacilityGuard section="analytics" />} />
        <Route path="/facilities/:facilityId/orders" element={<FacilityGuard section="orders" />} />
        <Route path="/facilities/:facilityId/risks" element={<FacilityGuard section="risks" />} />
        <Route
          path="/my-facility"
          element={
            <RoleGuard roles={["facility_dispatcher"]}>
              <MyFacilityPage />
            </RoleGuard>
          }
        />
        <Route
          path="/my-facility/risks"
          element={
            <RoleGuard roles={["facility_dispatcher"]}>
              <MyFacilityPage section="risks" />
            </RoleGuard>
          }
        />
        <Route
          path="/my-facility/plan"
          element={
            <RoleGuard roles={["facility_dispatcher"]}>
              <MyFacilityPage section="plan" />
            </RoleGuard>
          }
        />
        <Route
          path="/my-facility/analytics"
          element={
            <RoleGuard roles={["facility_dispatcher"]}>
              <MyFacilityPage section="analytics" />
            </RoleGuard>
          }
        />
        <Route
          path="/my-facility/orders"
          element={
            <RoleGuard roles={["facility_dispatcher"]}>
              <MyFacilityPage section="orders" />
            </RoleGuard>
          }
        />
        <Route
          path="/operations"
          element={
            <RoleGuard roles={["manager", "senior_dispatcher"]}>
              <OperationsPage />
            </RoleGuard>
          }
        />
        <Route
          path="/maintenance/queue"
          element={
            <RoleGuard roles={["manager", "maintenance_coordinator"]}>
              <MaintenanceRoute />
            </RoleGuard>
          }
        />
        <Route
          path="/maintenance/engineers"
          element={
            <RoleGuard roles={["manager", "maintenance_coordinator"]}>
              <EngineersPage />
            </RoleGuard>
          }
        />
        <Route
          path="/my-work"
          element={
            <RoleGuard roles={["engineer"]}>
              <EngineerRoute />
            </RoleGuard>
          }
        />
        <Route
          path="/my-work/sync"
          element={
            <RoleGuard roles={["engineer"]}>
              <EngineerRoute />
            </RoleGuard>
          }
        />
        <Route
          path="/my-work/:workOrderId"
          element={
            <RoleGuard roles={["engineer"]}>
              <EngineerRoute />
            </RoleGuard>
          }
        />
        <Route
          path="/my-work/:workOrderId/result"
          element={
            <RoleGuard roles={["engineer"]}>
              <EngineerRoute />
            </RoleGuard>
          }
        />
        <Route
          path="/work-orders"
          element={
            <RoleGuard roles={["manager", "senior_dispatcher", "facility_dispatcher", "maintenance_coordinator"]}>
              <WorkOrdersListPage />
            </RoleGuard>
          }
        />
        <Route
          path="/work-orders/:workOrderId"
          element={
            <RoleGuard roles={["manager", "senior_dispatcher", "facility_dispatcher", "maintenance_coordinator"]}>
              <WorkOrderRoute />
            </RoleGuard>
          }
        />
        <Route
          path="/work-orders/:workOrderId/verify"
          element={
            <RoleGuard roles={["manager", "senior_dispatcher", "facility_dispatcher", "maintenance_coordinator"]}>
              <WorkOrderRoute />
            </RoleGuard>
          }
        />
        <Route
          path="/analytics"
          element={
            <RoleGuard roles={["manager", "senior_dispatcher"]}>
              <AnalyticsPage />
            </RoleGuard>
          }
        />
        <Route
          path="/audit"
          element={
            <RoleGuard roles={["manager"]}>
              <AuditPage />
            </RoleGuard>
          }
        />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/access-denied" element={<AccessDeniedPage />} />
        <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
