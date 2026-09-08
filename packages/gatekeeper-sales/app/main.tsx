import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import { createRoot } from "react-dom/client";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import type { SalesManagementApi } from "../src/management-types";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<SalesManagementApi>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
  /** Places editable text in the chat composer. Never submits it automatically. */
  openPrompt(prompt: string): Promise<void>;
}

function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing Sales OS app root.");

  const { port1, port2 } = new MessageChannel();
  // Opaque-origin iframes can't name their parent origin. The parent accepts this handshake only
  // from this frame + null origin; the message only transfers a private port.
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
  // The initial theme comes back from the call; later changes arrive via iframe.setTheme().
  host
    .subscribeTheme(iframe)
    .then(applyAppTheme)
    .catch(() => {});

  createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("sales.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  }).render(
    <ErrorBoundary>
      <TooltipProvider>
        <Toasty>
          <App api={host.ui} openPrompt={(prompt) => host.openPrompt(prompt)} />
        </Toasty>
      </TooltipProvider>
    </ErrorBoundary>,
  );
}

main();
