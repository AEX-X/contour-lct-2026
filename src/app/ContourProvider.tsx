import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ActionCommandBase, CurrentUser, MutationMeta, User } from "../domain";
import { clearDefaultOfflineStorage } from "../offline";
import {
  createMockContourRepository,
  type ContourRepository,
} from "../repositories";
import { contourKeys } from "./queryKeys";
import { createClientId } from "./clientId";

const repository = createMockContourRepository();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
    mutations: {
      retry: false,
    },
  },
});

interface ContourContextValue {
  repository: ContourRepository;
  currentUser: CurrentUser;
  profiles: User[];
  isOnline: boolean;
  setIsOnline: (value: boolean) => void;
  switchUser: (userId: string) => Promise<void>;
  resetDemo: () => Promise<void>;
  invalidateAll: () => Promise<void>;
}

const ContourContext = createContext<ContourContextValue | null>(null);

function SessionGate({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [isOnline, setIsOnline] = useState(true);
  const [switchingUser, setSwitchingUser] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const currentUserQuery = useQuery({
    queryKey: contourKeys.session(),
    queryFn: () => repository.getCurrentUser(),
  });

  const profilesQuery = useQuery({
    queryKey: contourKeys.profiles(),
    queryFn: () => repository.listDemoProfiles(),
    staleTime: Infinity,
  });

  const invalidateAll = useCallback(async () => {
    await client.invalidateQueries({ queryKey: contourKeys.all });
  }, [client]);

  useEffect(
    () => repository.subscribe((change) => {
      if (change.source === "external") {
        void client.invalidateQueries({ queryKey: contourKeys.all });
      }
    }),
    [client],
  );

  const removeActorScopedQueries = useCallback(() => {
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === contourKeys.all[0] &&
        !["session", "profiles"].includes(String(query.queryKey[1])),
    });
  }, [client]);

  const switchUser = useCallback(
    async (userId: string) => {
      setSwitchingUser(true);
      try {
        await client.cancelQueries();
        const nextUser = await repository.switchDemoUser(userId);
        client.setQueryData(contourKeys.session(), nextUser);
        removeActorScopedQueries();
        window.location.replace(nextUser.homeRoute);
      } catch (error) {
        setSwitchingUser(false);
        throw error;
      }
    },
    [client, removeActorScopedQueries],
  );

  const resetDemo = useCallback(async () => {
    await client.cancelQueries();
    await repository.reset();
    await clearDefaultOfflineStorage();
    const nextUser = await repository.getCurrentUser();
    client.setQueryData(contourKeys.session(), nextUser);
    removeActorScopedQueries();
    window.location.replace(nextUser.homeRoute);
  }, [client, removeActorScopedQueries]);

  const recoverDemo = useCallback(async () => {
    setRecovering(true);
    setRecoveryError(null);
    try {
      await resetDemo();
    } catch {
      setRecoveryError("Автоматический сброс не завершён. Обнови страницу и повтори попытку");
    } finally {
      setRecovering(false);
    }
  }, [resetDemo]);

  if (switchingUser || currentUserQuery.isPending || profilesQuery.isPending) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        <span className="app-loading__mark">C</span>
        <span>{switchingUser ? "Переключаем рабочую роль" : "Запускаем демонстрационный контур"}</span>
      </div>
    );
  }

  if (currentUserQuery.isError || profilesQuery.isError) {
    return (
      <main className="fatal-state">
        <h1>Не удалось открыть Contour</h1>
        <p>Демонстрационные данные не загрузились. Сбрось сценарий и попробуй снова</p>
        {recoveryError ? <p role="alert">{recoveryError}</p> : null}
        <button type="button" disabled={recovering} onClick={() => void recoverDemo()}>
          {recovering ? "Сбрасываем..." : "Сбросить демо"}
        </button>
      </main>
    );
  }

  const value: ContourContextValue = {
    repository,
    currentUser: currentUserQuery.data,
    profiles: profilesQuery.data,
    isOnline,
    setIsOnline,
    switchUser,
    resetDemo,
    invalidateAll,
  };

  return <ContourContext.Provider value={value}>{children}</ContourContext.Provider>;
}

export function ContourProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionGate>{children}</SessionGate>
    </QueryClientProvider>
  );
}

export function useContour() {
  const context = useContext(ContourContext);
  if (!context) {
    throw new Error("useContour must be used inside ContourProvider");
  }
  return context;
}

export function useRepositoryCommandMeta() {
  const { repository } = useContour();
  const stableMetaByIntentRef = useRef(new Map<string, MutationMeta>());
  return useMemo(
    () => {
      function buildMeta(): MutationMeta;
      function buildMeta(intentKey: string): MutationMeta;
      function buildMeta(expectedVersion: number): ActionCommandBase;
      function buildMeta(expectedVersion: number, intentKey: string): ActionCommandBase;
      function buildMeta(
        expectedVersionOrIntent?: number | string,
        explicitIntentKey?: string,
      ): MutationMeta | ActionCommandBase {
        const expectedVersion = typeof expectedVersionOrIntent === "number"
          ? expectedVersionOrIntent
          : undefined;
        const intentKey = typeof expectedVersionOrIntent === "string"
          ? expectedVersionOrIntent
          : explicitIntentKey;
        let meta = intentKey ? stableMetaByIntentRef.current.get(intentKey) : undefined;
        if (!meta) {
          meta = {
            idempotencyKey: createClientId("command"),
            clientOccurredAt: repository.getSnapshot().demoClockIso,
          };
          if (intentKey) stableMetaByIntentRef.current.set(intentKey, meta);
        }
        return expectedVersion === undefined ? meta : { ...meta, expectedVersion };
      }
      return buildMeta;
    },
    [repository],
  );
}
