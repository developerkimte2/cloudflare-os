// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperUiFrame } from "@gadgets/workshop-shared/gatekeeper";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import SandboxedGatekeeperApp from "./SandboxedGatekeeperApp";

vi.mock("./ThemeContext", () => ({
  useTheme: () => ({ resolvedThemeMode: "light" }),
}));

vi.mock("./ServerConfigContext", () => ({
  useServerConfig: () => ({ accentColor: "#7c3aed" }),
}));

vi.mock("./errorReporting", () => ({
  forwardTrustedFrameError: () => false,
}));

const WORKSPACE_ID = "a".repeat(64);

const listGadgets = vi.fn<() => Promise<{ id: string; title: string }[]>>(async () => [
  { id: WORKSPACE_ID, title: "Daily Brief" },
]);
const authenticatedApi = { listGadgets };

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestHost extends RpcTarget {
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  setPresenting(active: boolean): Promise<{
    rect: { left: number; top: number; width: number; height: number } | null;
    willResize: boolean;
  }>;
  openWorkspace(workspaceId: string, gadgetId?: number): Promise<void>;
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]>;
  openPrompt(prompt: string): Promise<void>;
}

class EmptyUi extends RpcTarget {}

class TestThemeReceiver extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(_theme: GatekeeperAppTheme): void {}
}

describe("SandboxedGatekeeperApp navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let host: RpcStub<TestHost> | undefined;

  beforeEach(() => {
    listGadgets.mockClear();
  });

  afterEach(async () => {
    host?.[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it("provides the deployment theme and routes bounded iframe requests", async () => {
    const frame = {
      iframeHtml: "<!doctype html><title>Scheduler</title>",
      ui: new RpcStub(new EmptyUi()),
    } as unknown as GatekeeperUiFrame;
    const rootRoute = createRootRoute({
      component: () => <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="scheduler" />,
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const gadgetRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/workspace/$id",
    });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({
      history,
      routeTree: rootRoute.addChildren([indexRoute, gadgetRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const iframe = container.querySelector("iframe");
    if (!iframe) throw new Error("Missing gatekeeper iframe");
    const { port1, port2 } = new MessageChannel();
    host = newMessagePortRpcSession<TestHost>(port1);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );

    const themeReceiver = new TestThemeReceiver();
    await expect(host.subscribeTheme(themeReceiver)).resolves.toEqual({
      mode: "light",
      accentColor: "#7c3aed",
    });

    await act(async () => {
      await host!.setPresenting(true);
    });
    expect(iframe.style.position).toBe("fixed");
    expect(iframe.style.top).toBe("calc(var(--app-top) + env(safe-area-inset-top))");
    expect(iframe.style.bottom).toBe("calc(var(--app-bottom) + env(safe-area-inset-bottom))");
    expect(iframe.style.width).toBe(
      "calc(100vw - (env(safe-area-inset-left) + env(safe-area-inset-right)))",
    );
    expect(iframe.style.height).toBe(
      "calc(100vh - var(--app-top) - var(--app-bottom) - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
    );

    await act(async () => {
      await host!.setPresenting(false);
    });
    expect(iframe.style.position).toBe("");
    expect(iframe.style.width).toBe("100%");
    expect(iframe.style.height).toBe("100%");

    await act(async () => {
      await host!.openWorkspace(WORKSPACE_ID, 2);
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`),
      );
    });
    expect(router.state.location.search).toEqual({ w: 2 });

    // Live titles come from the user's own gadget list, never from the app's snapshot. Concurrent
    // and repeated frame requests share a bounded-lifetime host-side index.
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    listGadgets
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Daily Brief" }])
      .mockResolvedValueOnce([{ id: WORKSPACE_ID, title: "Renamed Brief" }]);
    await expect(
      Promise.all([
        host.resolveWorkspaceTitles([WORKSPACE_ID, "b".repeat(64)]),
        host.resolveWorkspaceTitles([WORKSPACE_ID]),
      ]),
    ).resolves.toEqual([["Daily Brief", null], ["Daily Brief"]]);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Daily Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30_000);
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(["Renamed Brief"]);
    expect(listGadgets).toHaveBeenCalledTimes(2);

    await expect(host.openWorkspace("../evil")).rejects.toThrow(
      "Invalid gatekeeper app workspace target",
    );
    expect(router.state.location.pathname).toBe(`/workspace/${WORKSPACE_ID}`);

    await act(async () => {
      await host!.openPrompt("  Create a daily brief.  ");
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });
    expect(router.state.location.search).toEqual({ prompt: "Create a daily brief." });
  });
});

describe("SandboxedGatekeeperApp session recovery", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  const hosts: RpcStub<TestHost>[] = [];

  afterEach(async () => {
    for (const host of hosts.splice(0)) host[Symbol.dispose]();
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  function handshake(iframe: HTMLIFrameElement): RpcStub<TestHost> {
    const { port1, port2 } = new MessageChannel();
    const host = newMessagePortRpcSession<TestHost>(port1);
    hosts.push(host);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "handshake" },
        origin: "null",
        source: iframe.contentWindow,
        ports: [port2],
      }),
    );
    return host;
  }

  it("remounts the iframe so the app re-handshakes after its session is torn down", async () => {
    // The app handshakes only once, on load: a torn-down session with the iframe left in place
    // would strand every later RPC on "Peer closed MessagePort connection".
    const iframeHtml = "<!doctype html><title>Sales OS</title>";
    const frameA = { iframeHtml, ui: new RpcStub(new EmptyUi()) } as unknown as GatekeeperUiFrame;
    const frameB = { iframeHtml, ui: new RpcStub(new EmptyUi()) } as unknown as GatekeeperUiFrame;
    let setFrame: (frame: GatekeeperUiFrame) => void = () => {};
    function Harness() {
      const [frame, set] = useState(frameA);
      setFrame = set;
      return <SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="sales" />;
    }
    const rootRoute = createRootRoute({ component: Harness });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([indexRoute]),
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));

    const first = container.querySelector("iframe");
    if (!first) throw new Error("Missing gatekeeper iframe");
    const host1 = handshake(first);
    await expect(host1.subscribeTheme(new TestThemeReceiver())).resolves.toMatchObject({ mode: "light" });

    // Re-rendering with the very same frame keeps the session and the iframe untouched.
    await act(async () => setFrame(frameA));
    expect(container.querySelector("iframe")).toBe(first);

    // A fresh `ui` stub with identical HTML (what a reconnect produces) tears the session down;
    // the iframe must be replaced so its load-time handshake runs again and connects.
    await act(async () => setFrame(frameB));
    const second = container.querySelector("iframe");
    if (!second) throw new Error("Missing gatekeeper iframe after remount");
    expect(second).not.toBe(first);
    const host2 = handshake(second);
    await expect(host2.subscribeTheme(new TestThemeReceiver())).resolves.toMatchObject({ mode: "light" });
  });
});
