import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional compact fallback (for narrow areas such as the settings sidebar). */
  fallback?: (error: Error, reload: () => void) => ReactNode;
  /** Called when the user clicks « Recharger »; defaults to reloading the page. */
  onReload?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render or chunk-load failures inside an on-demand screen so the rest of the app stays up. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Erreur d'affichage :", error, info.componentStack);
  }

  reload = (): void => {
    if (this.props.onReload) {
      this.setState({ error: null });
      this.props.onReload();
      return;
    }
    if (typeof location !== "undefined") location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reload);
    return (
      <div className="view">
        <div className="gate" role="alert">
          <div>
            <p>Impossible d'afficher cet écran.</p>
            {error.message && <p className="failed">{error.message}</p>}
            <button className="btn pri" type="button" onClick={this.reload}>
              Recharger
            </button>
          </div>
        </div>
      </div>
    );
  }
}
