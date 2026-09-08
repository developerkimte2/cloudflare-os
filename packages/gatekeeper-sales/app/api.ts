/**
 * Thin helpers around the `SalesManagementApi` RPC stub: a mutation wrapper that reports failures as
 * toasts, and a small data-fetch hook for the read side (loading / error / retry).
 */
import { useKumoToastManager } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";

export function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** Wraps a mutating RPC call: on failure, shows a toast and returns undefined instead of throwing. */
export function useApiAction() {
  const toasts = useKumoToastManager();
  return useCallback(
    async function runAction<T>(action: () => Promise<T>, failureTitle?: string): Promise<T | undefined> {
      try {
        return await action();
      } catch (caught) {
        toasts.add({
          title: failureTitle ?? "操作に失敗しました",
          description: errorMessage(caught),
          variant: "error",
        });
        return undefined;
      }
    },
    [toasts],
  );
}

export type AsyncState<T> = {
  loading: boolean;
  error?: string;
  data?: T;
  reload: () => void;
};

/** Loads `loader()` on mount and whenever `deps` change; exposes a manual `reload`. */
export function useAsyncData<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [data, setData] = useState<T>();
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const epoch = useRef(0);

  const reload = useCallback(() => {
    const mine = ++epoch.current;
    setLoading(true);
    setError(undefined);
    loaderRef.current().then(
      (result) => {
        if (mine !== epoch.current) return;
        setData(result);
        setLoading(false);
      },
      (caught) => {
        if (mine !== epoch.current) return;
        setError(errorMessage(caught));
        setLoading(false);
      },
    );
    // `deps` is caller-controlled and intentionally not the array literal itself.
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return { loading, error, data, reload };
}
