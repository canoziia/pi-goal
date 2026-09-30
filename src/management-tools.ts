import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateObjective } from "./command.js";
import { GoalCommandController } from "./commands.js";
import { goalIdRejectionReason, MAX_GOAL_ID_LENGTH, type GoalRuntime, type StatusContext } from "./runtime.js";

type Operation = "start" | "edit" | "pause" | "resume" | "clear";
interface Request {
  operation: Operation;
  goalId?: string;
  replace?: boolean;
  objective?: string;
  tokenBudget?: number;
  sessionManager: unknown;
}

/** Management calls are intents: never send a contract from tool execution.
 * turn_end is the upstream boundary where every tool result is committed.
 */
export function registerGoalManagementTools(pi: ExtensionAPI, runtime: GoalRuntime) {
  const controller = new GoalCommandController(runtime);
  let pending: Request | undefined;
  const id = Type.String({ minLength: 1, maxLength: MAX_GOAL_ID_LENGTH });
  const objective = Type.String({ minLength: 1, maxLength: 4_000 });
  const budget = Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));

  function rejection(request: Request): string | undefined {
    const goal = runtime.activeGoal;
    if (request.operation === "start" && goal && request.replace !== true) return "replacement requires replace: true and exact goal_id";
    if (request.operation === "start" && !goal) {
      if (request.replace) return "replace supplied but no goal exists";
      if (request.goalId !== undefined) return "replacement goal_id supplied but no goal exists";
    } else {
      if (!goal) return "no goal exists";
      const reason = goalIdRejectionReason(goal, request.goalId ?? "");
      if (reason) return reason;
    }
    if (request.objective !== undefined) {
      const reason = validateObjective(request.objective);
      if (reason) return reason;
    }
    if (request.tokenBudget !== undefined && (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget < 1)) {
      return "token_budget must be a positive safe integer";
    }
    if (request.operation === "pause" && goal?.status !== "active") return "only active goals can be paused";
    return undefined;
  }

  function enqueue(request: Request, signal: AbortSignal | undefined) {
    const reason = signal?.aborted ? "turn was aborted" : pending ? "another Goal management operation is pending" : rejection(request);
    if (reason) throw new Error(`Goal management rejected: ${reason}.`);
    pending = request;
    return {
      content: [{ type: "text" as const, text: `Goal ${request.operation} scheduled for turn_end after tool results are committed. This is an intent, not confirmation of activation; the next Goal contract is authoritative.` }],
      details: { operation: request.operation, goal_id: request.goalId, deferred: true },
      terminate: true as const,
    };
  }

  pi.registerTool(defineTool({
    name: "goal_start",
    label: "Goal Start",
    description: "Start Goal mode for an explicit objective. To replace any existing goal, supply replace: true and its exact current goal_id. No interactive confirmation is requested. Applied after this turn's tool results are committed.",
    parameters: Type.Object({ objective, token_budget: budget, goal_id: Type.Optional(id), replace: Type.Optional(Type.Boolean()) }),
    async execute(_callId, params, signal, _update, ctx) {
      return enqueue({ operation: "start", replace: params.replace, objective: params.objective.trim(), tokenBudget: params.token_budget, goalId: params.goal_id?.trim(), sessionManager: ctx.sessionManager }, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "goal_edit",
    label: "Goal Edit",
    description: "Edit the exact current Goal objective and optionally its cumulative token budget. Requires current goal_id. Applied after tool results are committed; the next contract supplies the rotated ID.",
    parameters: Type.Object({ goal_id: id, objective, token_budget: budget }),
    async execute(_callId, params, signal, _update, ctx) {
      return enqueue({ operation: "edit", objective: params.objective.trim(), tokenBudget: params.token_budget, goalId: params.goal_id.trim(), sessionManager: ctx.sessionManager }, signal);
    },
  }));
  pi.registerTool(defineTool({
    name: "goal_control",
    label: "Goal Control",
    description: "Pause, resume, or clear the exact current Goal. Requires current goal_id. Applied after tool results are committed. Resume may rotate the ID; use the next contract.",
    parameters: Type.Object({ goal_id: id, action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("clear")]) }),
    async execute(_callId, params, signal, _update, ctx) {
      if (!["pause", "resume", "clear"].includes(params.action)) throw new Error("Invalid Goal control action.");
      return enqueue({ operation: params.action, goalId: params.goal_id.trim(), sessionManager: ctx.sessionManager }, signal);
    },
  }));

  pi.on("turn_end", async (_event, ctx) => {
    const request = pending;
    pending = undefined;
    if (!request || request.sessionManager !== ctx.sessionManager || ctx.signal?.aborted) return;
    const reason = rejection(request);
    if (reason) {
      ctx.ui.notify(`Deferred Goal management rejected: ${reason}.`, "warning");
      return;
    }
    // Identity was checked twice; tools authorize replacement explicitly, not via UI.
    const toolContext: StatusContext = { ...ctx, ui: { ...ctx.ui, confirm: async () => true } };
    switch (request.operation) {
      case "start": await controller.startGoal(request.objective!, request.tokenBudget, toolContext); break;
      case "edit": await controller.editGoal(request.objective!, request.tokenBudget, toolContext); break;
      case "pause": controller.pauseGoal(toolContext); break;
      case "resume": await controller.resumeGoal(toolContext); break;
      case "clear": controller.clearGoal(toolContext); break;
    }
  });
  const discard = () => { pending = undefined; };
  pi.on("agent_end", discard);
  pi.on("session_start", discard);
  pi.on("session_shutdown", discard);
  pi.on("session_before_switch", discard);
}
