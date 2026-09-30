import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GoalRuntime } from "./runtime.js";
import { registerGoalTools, renderGoalCompletion } from "./tools.js";
import { registerGoalManagementTools } from "./management-tools.js";

function nameForHelp(action: string, schema: any) {
  if (!["pause", "resume", "clear"].includes(action)) return schema;
  const { action: _action, ...properties } = schema.properties;
  return { ...schema, properties, required: schema.required.filter((key: string) => key !== "action") };
}

const ACTIONS: Record<string, string> = {
  start: "goal_start", edit: "goal_edit", pause: "goal_control", resume: "goal_control", clear: "goal_control",
  complete: "goal_complete", blocked: "goal_blocked", wait: "goal_wait",
};

/** Capture internal handlers without publishing their schemas to the model. */
export function registerGoalTool(pi: ExtensionAPI, runtime: GoalRuntime) {
  const handlers = new Map<string, any>();
  const internal = Object.create(pi) as ExtensionAPI;
  internal.registerTool = (tool: any) => { handlers.set(tool.name, tool); };
  registerGoalTools(internal, runtime);
  registerGoalManagementTools(internal, runtime);
  const examples = [
    '{}', '{"action":"help"}', '{"action":"status"}',
    '{"action":"start","args":{"objective":"Implement and verify the feature"}}',
    '{"action":"start","args":{"objective":"New objective","replace":true,"goal_id":"CURRENT_ID"}}',
    '{"action":"edit","args":{"goal_id":"CURRENT_ID","objective":"Revised objective"}}',
    ...["pause", "resume", "clear"].map(action => JSON.stringify({action,args:{goal_id:"CURRENT_ID"}})),
    '{"action":"complete","args":{"goal_id":"CURRENT_ID","summary":"Delivered changes and verification evidence"}}',
    '{"action":"blocked","args":{"goal_id":"CURRENT_ID","reason":"External action needed","evidence":"Repeated failed attempts","repeated_turns":3}}',
    '{"action":"wait","args":{"goal_id":"CURRENT_ID","reason":"Waiting for CI notification","resume_after_ms":300000}}',
  ];
  const help = () => [
    "Goal: one persistent objective with automatic continuation. Use status for the current ID. No extra interactive approval is requested by management actions.",
    "Calls (args contains action-specific parameters):", ...examples,
    "start: omit token_budget for unlimited tokens; optional positive integer token_budget. Replacement requires replace:true and current goal_id.",
    "edit: objective required; optional token_budget changes the cumulative budget, omitted preserves it. Edit/resume may rotate the ID. Management changes apply after tool results are committed; the next contract is authoritative.",
    'complete: require verified completion and an evidence summary. blocked: same external blocker for at least three consecutive turns, with reason and evidence. wait: arrange external wake notification first; optional safety deadline, minimum effective 10000ms. Call terminal actions alone.',
    'For detailed rules and parameter schema: {"action":"help","args":{"action":"complete"}} (or another action).',
  ].join("\n\n");
  pi.registerTool(defineTool({
    name: "goal", label: "Goal",
    description: 'Manage a persistent goal. Call with no arguments or action:"help" for actions, rules, and examples; action:"status" reads the current goal. Other actions take parameters in args.',
    promptSnippet: 'Use goal for persistent multi-turn objectives; call goal({}) to discover its actions before managing one.',
    renderResult(result) { return renderGoalCompletion(result); },
    parameters: Type.Object({ action: Type.Optional(Type.String()), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, {additionalProperties:false}),
    async execute(callId, params, signal, update, ctx) {
      const action = params.action ?? "help";
      if (action === "help") {
        const topic = params.args?.action;
        if (topic !== undefined) {
          if (typeof topic !== "string" || !ACTIONS[topic]) throw new Error("Unknown help action.");
          const tool = handlers.get(ACTIONS[topic]);
          const schema = nameForHelp(topic, tool.parameters);
          const text = `${topic}: ${tool.description}\nargs schema:\n${JSON.stringify(schema, null, 2)}`.replaceAll("goal_complete", 'goal(action="complete")').replaceAll("goal_blocked", 'goal(action="blocked")').replaceAll("goal_wait", 'goal(action="wait")');
          return {content:[{type:"text" as const,text}],details:undefined};
        }
        return {content:[{type:"text" as const,text:help()}],details:undefined};
      }
      if (action === "status") return {content:[{type:"text" as const,text:JSON.stringify(runtime.activeGoal ?? null,null,2)}],details:undefined};
      const name = ACTIONS[action];
      if (!name) throw new Error(`Unknown goal action: ${action}. Call goal({}) for help.`);
      const tool = handlers.get(name);
      const args = {...(params.args ?? {}), ...(name === "goal_control" ? {action} : {})};
      // Management handlers assume schema-valid input. Terminal handlers perform
      // their own bounded validation and return precise rejection results.
      const { Value } = await import("typebox/value");
      if (["start", "edit", "pause", "resume", "clear"].includes(action) && !Value.Check(tool.parameters, args)) throw new Error(`Invalid parameters for goal ${action}. Call goal({}) for help.`);
      const result = await tool.execute(callId,args,signal,update,ctx);
      return { ...result, content: result.content.map((block: any) => block.type === "text" ? {...block, text: block.text.replaceAll("goal_complete", 'goal(action="complete")').replaceAll("goal_blocked", 'goal(action="blocked")').replaceAll("goal_wait", 'goal(action="wait")')} : block) };
    },
  }));
}
