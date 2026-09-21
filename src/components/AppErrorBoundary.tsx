import { Component, type ErrorInfo, type ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("Contour render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-state" role="alert">
        <WarningCircle size={42} weight="duotone" aria-hidden="true" />
        <h1>Экран не удалось открыть</h1>
        <p>Данные не изменены. Обнови приложение, чтобы восстановить рабочее место</p>
        <button className="ui-button ui-button--primary ui-button--medium" type="button" onClick={() => window.location.reload()}>
          Обновить приложение
        </button>
      </main>
    );
  }
}
