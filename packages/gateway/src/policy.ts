import type { GatewayApiKeyRecord } from "@space/db";
import { gatewayError, type GatewayErrorEnvelope } from "./errors.js";

/**
 * API-key request policy, after codex-lb `app/modules/proxy/request_policy.py` (MIT, Soju06/codex-lb):
 * enforced model and reasoning effort, model allowlist, allowed reasoning efforts (`ultra` goes upstream as `max`)
 * and the fast speed tier sent upstream as `priority`.
 */
export class PolicyRejection extends Error {
  constructor(readonly statusCode: number, readonly envelope: GatewayErrorEnvelope) {
    super(envelope.error.message);
  }
}

const wireEffortAliases: Record<string, string> = { ultra: "max" };
const omittedServiceTiers = new Set(["auto", "default"]);

type Body = Record<string, unknown>;

function reasoningOf(body: Body): Record<string, unknown> | null {
  return body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning as Record<string, unknown> : null;
}

export interface PolicyResult {
  body: Body;
  model: string | null;
  /** The effort the client chose (before wire aliasing), for logs and limits. */
  reasoningEffort: string | null;
  requestedServiceTier: string | null;
  serviceTier: string | null;
}

export function applyRequestPolicy(input: Body, key: GatewayApiKeyRecord | null, options: { fastTier?: string } = {}): PolicyResult {
  const body: Body = { ...input };
  if (key?.enforcedModel) body.model = key.enforcedModel;
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  if (key && key.allowedModels.length > 0 && model !== null && !key.allowedModels.includes(model)) {
    throw new PolicyRejection(403, gatewayError("model_not_allowed", `This API key does not have access to model '${model}'`, "invalid_request_error"));
  }

  let reasoning = reasoningOf(body);
  if (key?.enforcedReasoningEffort) {
    reasoning = { ...(reasoning ?? {}), effort: key.enforcedReasoningEffort };
  }
  const requestedEffort = typeof reasoning?.effort === "string" && reasoning.effort.trim() ? reasoning.effort.trim().toLowerCase() : null;
  if (key && requestedEffort !== null && key.allowedReasoningEfforts.length > 0 && !key.allowedReasoningEfforts.includes(requestedEffort as never)) {
    throw new PolicyRejection(403, gatewayError("reasoning_effort_not_allowed",
      `This API key does not have access to reasoning effort '${requestedEffort}'`, "invalid_request_error"));
  }
  if (reasoning && requestedEffort !== null) {
    body.reasoning = { ...reasoning, effort: wireEffortAliases[requestedEffort] ?? requestedEffort };
  } else if (reasoning) {
    body.reasoning = reasoning;
  }

  const rawTier = typeof body.service_tier === "string" ? body.service_tier.trim().toLowerCase() : null;
  let serviceTier: string | null = rawTier;
  if (rawTier === "fast") serviceTier = options.fastTier ?? "priority";
  if (serviceTier !== null && omittedServiceTiers.has(serviceTier)) serviceTier = null;
  if (serviceTier === null) delete body.service_tier;
  else body.service_tier = serviceTier;

  return { body, model, reasoningEffort: requestedEffort, requestedServiceTier: rawTier, serviceTier };
}

/** Rejects a request once one of the key's limits for this model is used up in its current window. */
export function checkKeyLimits(key: GatewayApiKeyRecord | null, model: string | null, nowIso: string): void {
  if (!key) return;
  for (const limit of key.limits) {
    if (limit.modelFilter !== null && limit.modelFilter !== model) continue;
    if (limit.resetAt <= nowIso) continue;
    if (limit.currentValue >= limit.maxValue) {
      const kind = limit.limitType.toLowerCase();
      throw new PolicyRejection(429, gatewayError("rate_limit_exceeded",
        `API key ${kind} ${limit.limitWindow.toLowerCase()} limit exceeded${limit.modelFilter ? ` for model ${limit.modelFilter}` : ""}`, "rate_limit_error"));
    }
  }
}
