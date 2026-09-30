import assert from "node:assert/strict";
import { test } from "vitest";
import goal from "../src/goal.js";
import { createMockPi, createMockContext } from "./support.js";

function setup() {
  const mock = createMockPi({activeTools:["goal"]}); goal(mock.pi);
  const ctx = createMockContext().ctx;
  const tool = mock.tools[0] as any;
  return {mock,ctx,tool,call:(params:object) => tool.execute("test",params,undefined,undefined,ctx)};
}
test("only one compact tool is exposed; empty and help are non-mutating discovery", async () => {
  const {mock,tool,call} = setup();
  assert.deepEqual(mock.tools.map(t=>t.name),["goal"]);
  assert.ok(JSON.stringify(tool.parameters).length < 500);
  assert.ok(tool.description.length < 300);
  const empty = await call({}), help = await call({action:"help"});
  assert.deepEqual(empty,help);
  for(const action of ["start","replace","edit","pause","resume","clear","complete","blocked","wait","status"]) assert.ok(help.content[0].text.includes(action));
  assert.equal(mock.entries.length,0);
  assert.equal(mock.sentUserMessages.length,0);
});
test("detailed action help contains validation and rules only on demand", async () => {
  const {call,tool}=setup();
  const result=await call({action:"help",args:{action:"complete"}});
  assert.match(result.content[0].text,/audit requirement by requirement/);
  assert.match(result.content[0].text,/summary/);
  assert.doesNotMatch(tool.description,/audit requirement by requirement/);
  assert.match((await call({action:"help",args:{action:"wait"}})).content[0].text,/2147483647/);
  const start = (await call({action:"help",args:{action:"start"}})).content[0].text;
  const replace = (await call({action:"help",args:{action:"replace"}})).content[0].text;
  assert.doesNotMatch(start, /"goal_id"|"replace"/);
  assert.match(replace, /"goal_id"/);
  assert.doesNotMatch(replace, /"replace":/);
});
test("status is readable without a goal; invalid actions and management args fail safely", async () => {
  const {call,mock}=setup();
  assert.equal((await call({action:"status"})).content[0].text,"null");
  await assert.rejects(call({action:"unknown"}),/Unknown goal action/);
  await assert.rejects(call({action:"start"}),/Invalid parameters/);
  await assert.rejects(call({action:"help",args:{action:"unknown"}}),/Unknown help action/);
  assert.equal(mock.entries.length,0);
});
