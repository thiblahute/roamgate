import { useEffect, useState } from "react";
import { bridge } from "../api";
import type { NodeHomeState } from "../routedBridge";
import "./NodeHomeStatus.css";

/**
 * On a page a Roamgate node served: why the home (the desktop) is not
 * there. Without a session on the home it offers its sign-in, in a new tab
 * (the page's socket to the home retries by itself once signed in); when
 * the home does not answer, it says the page shows this machine only.
 * Nothing on any other page.
 */
export function NodeHomeStatus() {
  const [state, setState] = useState<NodeHomeState | null>(
    () => bridge.nodeHome,
  );
  useEffect(() => bridge.onNodeHome(setState), []);
  if (!state) return null;
  if (state.reach === "signin")
    return (
      <button
        type="button"
        className="topbar-button node-home-status is-signin"
        title="The desktop has no session for this browser: sign in there, then come back"
        onClick={() => window.open(`${state.home}/login`, "_blank", "noopener")}
      >
        Sign in to the desktop
      </button>
    );
  if (state.reach === "unreachable")
    return (
      <span
        className="node-home-status is-unreachable"
        role="status"
        title="Work, reviews and the other connections come back with the desktop"
      >
        Desktop unreachable: this Mac only
      </span>
    );
  return null;
}
