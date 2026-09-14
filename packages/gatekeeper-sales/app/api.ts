/**
 * Thin helpers around the `SalesManagementApi` RPC stub: a mutation wrapper that reports failures as
 * toasts, and a small data-fetch hook for the read side (loading / error / retry).
 */
import { useKumoToastManager } from "@cloudflare/kumo";
import type { RpcStub } from "capnweb";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureResult, SalesManagementApi } from "../src/management-types";

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

/**
 * Polls `getCapture(sourceId)` until captureAsync's alarm-driven queue has moved it out of
 * RECEIVED/PROCESSING, or the budget runs out. On timeout, whatever state it's still in is returned
 * as-is -- the rep can still see it (and retry) in the recent-captures list.
 */
export async function pollCapture(
  api: RpcStub<SalesManagementApi>, sourceId: string,
  { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<CaptureResult> {
  const deadline = Date.now() + timeoutMs;
  let current = await api.getCapture(sourceId);
  while (
    (current.source.processingStatus === "RECEIVED" || current.source.processingStatus === "PROCESSING") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    current = await api.getCapture(sourceId);
  }
  return current;
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
