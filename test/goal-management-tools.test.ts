import assert from "node:assert/strict";
import { test } from "vitest";
import { requireGoalTool, requireLastGoal, startGoalForTest } from "./support/goal-fixture.js";

async function flush(active: Awaited<ReturnType<typeof startGoalForTest>>) {
  for (const handler of active.mock.events.get("turn_end") ?? []) await handler({}, active.ctx);
}
async function call(active: Awaited<ReturnType<typeof startGoalForTest>>, name: string, params: Record<string, unknown>) {
  return requireGoalTool(active.mock, name).execute("management", params, new AbortController().signal, () => undefined, active.ctx);
}

test("replacement and edit defer contracts until turn_end and never ask UI confirmation", async () => {
  const active = await startGoalForTest();
  active.ctx.ui.confirm = async () => { throw new Error("tool path must not show a dialog"); };
  const original = requireLastGoal(active.mock);
  await assert.rejects(call(active, "goal_start", { objective: "replacement" }));
  await assert.rejects(call(active, "goal_edit", { goal_id: "stale", objective: "replacement" }));
  const sent = active.mock.sentUserMessages.length;
  await assert.rejects(call(active, "goal_start", { goal_id: original.id, objective: "replacement" }));
  await assert.rejects(call(active, "goal_replace", { objective: "replacement" }));
  await assert.rejects(call(active, "goal_replace", { goal_id: "stale", objective: "replacement" }));
  const result = await call(active, "goal_replace", { goal_id: original.id, objective: "replacement" });
  assert.equal(result.terminate, true);
  assert.equal(requireLastGoal(active.mock).id, original.id);
  assert.equal(active.mock.sentUserMessages.length, sent);
  await flush(active);
  const replaced = requireLastGoal(active.mock);
  assert.notEqual(replaced.id, original.id);
  assert.equal(replaced.text, "replacement");
  assert.equal(active.mock.sentUserMessages.length, sent + 1);
  await call(active, "goal_edit", { goal_id: replaced.id, objective: "edited", token_budget: 100000 });
  assert.equal(requireLastGoal(active.mock).text, "replacement");
  await flush(active);
  assert.equal(requireLastGoal(active.mock).text, "edited");
  assert.notEqual(requireLastGoal(active.mock).id, replaced.id);
});

test("control requires identity, serializes intents, and reuses pause/resume/clear transitions", async () => {
  const active = await startGoalForTest();
  const original = requireLastGoal(active.mock);
  await assert.rejects(call(active, "goal_control", { goal_id: "stale", action: "clear" }));
  await call(active, "goal_control", { goal_id: original.id, action: "pause" });
  await assert.rejects(call(active, "goal_control", { goal_id: original.id, action: "clear" }));
  assert.equal(requireLastGoal(active.mock).status, "active");
  await flush(active);
  assert.equal(requireLastGoal(active.mock).status, "paused");
  await call(active, "goal_control", { goal_id: original.id, action: "resume" });
  await flush(active);
  const resumed = requireLastGoal(active.mock);
  assert.equal(resumed.status, "active");
  assert.notEqual(resumed.id, original.id);
  await call(active, "goal_control", { goal_id: resumed.id, action: "clear" });
  await flush(active);
  assert.deepEqual(active.mock.entries.at(-1)?.data, { goal: null });
  await call(active, "goal_start", { objective: "fresh start" });
  await flush(active);
  assert.equal(requireLastGoal(active.mock).text, "fresh start");
  assert.equal(requireLastGoal(active.mock).status, "active");
});

test("superseded and abandoned intents cannot mutate a newer goal", async () => {
  const active = await startGoalForTest();
  await call(active, "goal_edit", { goal_id: requireLastGoal(active.mock).id, objective: "stale edit" });
  await active.mock.commands.get("goal")?.handler("edit newer objective", active.ctx);
  await flush(active);
  assert.equal(requireLastGoal(active.mock).text, "newer objective");
  await call(active, "goal_control", { goal_id: requireLastGoal(active.mock).id, action: "clear" });
  for (const handler of active.mock.events.get("agent_end") ?? []) await handler({ messages: [] }, active.ctx);
  await flush(active);
  assert.equal(requireLastGoal(active.mock).text, "newer objective");
});
