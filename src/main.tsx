import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import type { PaneKind } from "../shared/types";
import { PaneWindow } from "./PaneWindow";
import "./styles/index.css";

/**
 * A window opened with `?pane=` shows that pane alone; anything else is the
 * full app. Reading it here rather than inside App keeps the pop-out from
 * mounting the sidebar and chat only to hide them.
 */
function paneFromLocation(): PaneKind | null {
  const raw = new URLSearchParams(window.location.search).get("pane");
  return raw === "browser" || raw === "terminal" || raw === "canvas" ? raw : null;
}

const pane = paneFromLocation();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pane ? <PaneWindow pane={pane} /> : <App />}</React.StrictMode>
);
