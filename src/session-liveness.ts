import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "./runtime.js";

const REGISTRY_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");

interface LivenessProvider {
  name: string;
  sessionId: string;
  sessionFile?: string;
  isActive(): boolean;
}

interface LivenessRegistry {
  version: 1;
  register(provider: LivenessProvider): () => void;
}

function getRegistry(): LivenessRegistry | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY];
  if (!value || typeof value !== "object") return undefined;
  const registry = value as Partial<LivenessRegistry>;
  return registry.version === 1 && typeof registry.register === "function"
    ? registry as LivenessRegistry
    : undefined;
}

/** Optional pi-web protocol adapter; owns no timers or pi-web dependencies. */
export function registerGoalSessionLiveness(pi: ExtensionAPI, runtime: GoalRuntime): void {
  let owner: object | undefined;
  let release: (() => void) | undefined;

  const dispose = () => {
    owner = undefined;
    const previous = release;
    release = undefined;
    try {
      previous?.();
    } catch {
      // Optional host integration must not interrupt Goal lifecycle cleanup.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    dispose();
    const registry = getRegistry();
    if (!registry) return;
    const manager = ctx.sessionManager;
    try {
      const sessionId = manager.getSessionId();
      const sessionFile = manager.getSessionFile();
      if (!sessionId?.trim()) return;
      owner = manager;
      let live = true;
      const unregister = registry.register({
        name: "pi-goal",
        sessionId,
        ...(sessionFile ? { sessionFile } : {}),
        // Waiting is canonically active, even without a deadline or continuation.
        isActive: () => live && owner === manager && runtime.activeGoal?.status === "active",
      });
      release = () => {
        live = false;
        unregister();
      };
    } catch {
      dispose();
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (owner === ctx.sessionManager) dispose();
  });
}
