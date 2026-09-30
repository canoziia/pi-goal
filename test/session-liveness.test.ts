import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoal, type GoalRuntime } from "../src/runtime.js";
import { registerGoalSessionLiveness } from "../src/session-liveness.js";

const key = Symbol.for("@agegr/pi-web/session-liveness/v1");
const store = globalThis as Record<PropertyKey, unknown>;
const original = Object.getOwnPropertyDescriptor(globalThis, key);

afterEach(() => {
  if (original) Object.defineProperty(globalThis, key, original);
  else delete store[key];
  vi.useRealTimers();
});

interface Provider {
  name: string;
  sessionId: string;
  sessionFile?: string;
  isActive(): boolean;
}

// Mirrors pi-web's token-owned registry and ID/file alias matching.
function registry() {
  const providers = new Map<symbol, Provider>();
  return {
    version: 1,
    providers,
    register: vi.fn((provider: Provider) => {
      const token = Symbol(provider.name);
      providers.set(token, provider);
      return vi.fn(() => { providers.delete(token); });
    }),
    hasActiveProvider(session: { sessionId: string; sessionFile?: string }) {
      const identities = new Set([session.sessionId, session.sessionFile].filter(Boolean));
      for (const provider of providers.values()) {
        if (!identities.has(provider.sessionId) && (!provider.sessionFile || !identities.has(provider.sessionFile))) continue;
        try {
          if (provider.isActive()) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
  };
}

function fixture() {
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const pi = { on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI;
  const runtime = { activeGoal: undefined } as unknown as GoalRuntime;
  registerGoalSessionLiveness(pi, runtime);
  const context = (id: string, file?: string) => ({
    sessionManager: { getSessionId: () => id, getSessionFile: () => file },
  }) as unknown as ExtensionContext;
  const emit = (name: string, ctx: ExtensionContext) => handlers.get(name)!({} as never, ctx);
  return { runtime, context, emit };
}

test("registers only at session_start; active and waiting survive over ten minutes of idle time without timers", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const host = registry();
  store[key] = host;
  const f = fixture();
  expect(host.providers.size).toBe(0);
  const ctx = f.context("session-a", "/sessions/a.jsonl");
  f.emit("session_start", ctx);
  expect(host.register).toHaveBeenCalledOnce();
  expect([...host.providers.values()][0]).toMatchObject({ name: "pi-goal", sessionId: "session-a", sessionFile: "/sessions/a.jsonl" });
  expect(host.hasActiveProvider({ sessionId: "session-a" })).toBe(false);
  f.runtime.activeGoal = createGoal("work", undefined, 0);
  expect(host.hasActiveProvider({ sessionId: "session-a" })).toBe(true);
  f.runtime.activeGoal.waiting = { reason: "external wake" };
  vi.advanceTimersByTime(11 * 60_000);
  const idleTimeout = 10 * 60_000;
  const shouldEvict = (sessionId: string) => Date.now() > idleTimeout && !host.hasActiveProvider({ sessionId });
  expect(shouldEvict("session-a")).toBe(false);
  expect(shouldEvict("unrelated")).toBe(true);
  expect(host.hasActiveProvider({ sessionId: "/sessions/a.jsonl" })).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  f.emit("session_shutdown", ctx);
  expect(host.providers.size).toBe(0);
  expect(shouldEvict("session-a")).toBe(true);
  f.emit("session_shutdown", ctx);
});

test.each(["paused", "blocked", "usage_limited", "budget_limited", "complete"] as const)("%s goals do not preserve sessions", (status) => {
  const host = registry();
  store[key] = host;
  const f = fixture();
  f.emit("session_start", f.context("a"));
  f.runtime.activeGoal = { ...createGoal("work", undefined, 0), status };
  expect(host.hasActiveProvider({ sessionId: "a" })).toBe(false);
});

test("replacement releases old registration and stale shutdown cannot release the new session", () => {
  const host = registry();
  store[key] = host;
  const f = fixture();
  const a = f.context("a");
  const b = f.context("b");
  f.runtime.activeGoal = createGoal("work", undefined, 0);
  f.emit("session_start", a);
  const old = [...host.providers.values()][0]!;
  f.emit("session_start", b);
  expect(old.isActive()).toBe(false);
  expect(host.providers.size).toBe(1);
  expect(host.hasActiveProvider({ sessionId: "a" })).toBe(false);
  f.emit("session_shutdown", a);
  expect(host.hasActiveProvider({ sessionId: "b" })).toBe(true);
  f.emit("session_shutdown", b);
  expect(host.providers.size).toBe(0);
});

test.each([undefined, {}, { version: 2, register: vi.fn() }, { version: 1, register: "invalid" }, { version: 1, register: () => { throw new Error("host unavailable"); } }])("absent or incompatible host is optional: %j", (host) => {
  store[key] = host;
  const f = fixture();
  const ctx = f.context("a");
  expect(() => f.emit("session_start", ctx)).not.toThrow();
  expect(() => f.emit("session_shutdown", ctx)).not.toThrow();
  expect(store[key]).toBe(host);
});

test("independent adapters release only their own provider", () => {
  const host = registry();
  store[key] = host;
  const a = fixture();
  const b = fixture();
  const ctx = a.context("shared");
  a.runtime.activeGoal = createGoal("a", undefined, 0);
  b.runtime.activeGoal = createGoal("b", undefined, 0);
  a.emit("session_start", ctx);
  b.emit("session_start", ctx);
  a.emit("session_shutdown", ctx);
  expect(host.providers.size).toBe(1);
  expect(host.hasActiveProvider({ sessionId: "shared" })).toBe(true);
  b.emit("session_shutdown", ctx);
  expect(host.providers.size).toBe(0);
});
