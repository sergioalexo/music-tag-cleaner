import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Card } from "./ui";

interface Props {
  children: ReactNode;
  /** Called with the error once caught, so it can also reach the Logs page. */
  onError?: (message: string) => void;
  /** Shown as the recovery action's label; defaults to "Reload". */
  backLabel?: string;
  onBack?: () => void;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Stops a render crash from unmounting the whole app. Without this, any
 * exception thrown while rendering (a null dereference in a page that
 * assumes the library index is populated, say) takes down `<App/>` entirely
 * and leaves a black window — see PLAN-v0.15-library.md, workstream E.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    this.props.onError?.(`${error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const details = `${error.message}\n\n${error.stack ?? ""}\n\n${info?.componentStack ?? ""}`;

    return (
      <div className="flex h-full items-center justify-center p-6">
        <Card className="max-w-lg space-y-3 p-5">
          <h2 className="text-sm font-semibold text-destructive">Something went wrong</h2>
          <p className="text-xs text-muted-foreground">
            This page hit an error and couldn't render. The rest of the app is unaffected.
          </p>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border bg-secondary/40 p-2 text-[11px]">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(details)}
            >
              Copy details
            </Button>
            <Button
              size="sm"
              onClick={() => {
                this.setState({ error: null, info: null });
                this.props.onBack?.();
              }}
            >
              {this.props.backLabel ?? "Back to tracks"}
            </Button>
          </div>
        </Card>
      </div>
    );
  }
}
