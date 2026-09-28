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
import { RepositoryError } from "../domain";
import { readRuntimeConfig } from "../config/runtime";
import { clearDefaultOfflineStorage } from "../offline";
import {
  createApiContourRepository,
  createMockContourRepository,
  type ContourRepository,
  type RepositoryAuthCredentials,
  type RepositoryRuntimeInfo,
} from "../repositories";
import { ApiLoginPage } from "../pages/ApiLoginPage";
import { contourKeys } from "./queryKeys";
import { createClientId } from "./clientId";

const runtimeConfig = readRuntimeConfig();
const repository: ContourRepository = runtimeConfig.dataMode === "api"
  ? createApiContourRepository({ baseUrl: runtimeConfig.apiBaseUrl })
  : createMockContourRepository();

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
  runtime: RepositoryRuntimeInfo;
  currentUser: CurrentUser;
  profiles: User[];
  isOnline: boolean;
  setIsOnline: (value: boolean) => void;
  switchUser: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetDemo: () => Promise<void>;
  invalidateAll: () => Promise<void>;
}

const ContourContext = createContext<ContourContextValue | null>(null);

function SessionGate({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const runtime = repository.getRuntimeInfo();
  const [isOnline, setIsOnline] = useState(true);
  const [switchingUser, setSwitchingUser] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const currentUserQuery = useQuery({
    queryKey: contourKeys.session(),
    queryFn: () => repository.getCurrentUser(),
    retry: false,
  });

  const profilesQuery = useQuery({
    queryKey: contourKeys.profiles(),
    queryFn: () => repository.listDemoProfiles(),
    staleTime: Infinity,
    enabled: currentUserQuery.isSuccess,
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

  const login = useCallback(async (credentials: RepositoryAuthCredentials) => {
    if (!repository.login) {
      throw new RepositoryError("FORBIDDEN", "В текущем режиме отдельный вход не требуется");
    }
    await client.cancelQueries();
    const nextUser = await repository.login(credentials);
    client.setQueryData(contourKeys.session(), nextUser);
    client.setQueryData(contourKeys.profiles(), [nextUser]);
    removeActorScopedQueries();
  }, [client, removeActorScopedQueries]);

  const signOut = useCallback(async () => {
    if (!repository.logout) return;
    await client.cancelQueries();
    await repository.logout();
    client.clear();
    window.location.replace("/");
  }, [client]);

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

  const authRequired = currentUserQuery.error instanceof RepositoryError && currentUserQuery.error.code === "AUTH_REQUIRED";

  if (authRequired && repository.login) {
    return <ApiLoginPage runtime={runtime} onLogin={login} />;
  }

  if (switchingUser || currentUserQuery.isPending || (currentUserQuery.isSuccess && profilesQuery.isPending)) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        <span className="app-loading__mark">C</span>
        <span>{switchingUser ? "Переключаем рабочую роль" : runtime.mode === "api" ? "Подключаем backend" : "Запускаем демонстрационный контур"}</span>
      </div>
    );
  }

  if (currentUserQuery.isError || profilesQuery.isError || !profilesQuery.data) {
    return (
      <main className="fatal-state">
        <h1>Не удалось открыть Contour</h1>
        <p>{runtime.mode === "api" ? "Backend недоступен или вернул несовместимый ответ" : "Демонстрационные данные не загрузились. Сбрось сценарий и попробуй снова"}</p>
        {recoveryError ? <p role="alert">{recoveryError}</p> : null}
        {runtime.mode === "mock" ? (
          <button type="button" disabled={recovering} onClick={() => void recoverDemo()}>
            {recovering ? "Сбрасываем..." : "Сбросить демо"}
          </button>
        ) : (
          <button type="button" onClick={() => window.location.reload()}>Повторить подключение</button>
        )}
      </main>
    );
  }

  const value: ContourContextValue = {
    repository,
    runtime,
    currentUser: currentUserQuery.data,
    profiles: profilesQuery.data,
    isOnline,
    setIsOnline,
    switchUser,
    signOut,
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
