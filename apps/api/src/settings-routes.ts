import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { updateProviderSettingsInputSchema, updateUserSettingsInputSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";

/** Provider settings and per-user settings; the parent retains authentication, CSRF, errors and rate limits. */
export function registerSettingsRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, cliRuntimeVisibility, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/provider-settings", defaultRouteRateLimitOptions, async () => store.getProviderSettings());
  app.patch("/api/provider-settings", defaultRouteRateLimitOptions, async (request) => {
    await cliRuntimeVisibility.assertEnabled("cli:codex");
    const input = parseBody(updateProviderSettingsInputSchema, request.body);
    const settings = await store.updateProviderSettings(input);
    await recordAudit(store, request, {
      action: "provider_settings.update",
      targetType: "provider_settings",
      targetId: "global",
      metadata: {
        defaultProviderId: settings.defaultProviderId,
        titleGenerationModelId: settings.titleGenerationModelId
      }
    });
    return settings;
  });
  const getUserSettingsHandler = async (request: any, reply: any) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    return store.getUserSettings(request.user.id);
  };
  const patchUserSettingsHandler = async (request: any, reply: any) => {
    if (!request.user) return sendApiError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    const input = parseBody(updateUserSettingsInputSchema, request.body);
    const updated = await store.updateUserSettings(request.user.id, input);
    await recordAudit(store, request, {
      action: "user_settings.update",
      targetType: "user_settings",
      targetId: request.user.id,
      metadata: { userId: request.user.id }
    });
    return updated;
  };
  app.get("/api/user-settings", defaultRouteRateLimitOptions, getUserSettingsHandler);
  app.get("/api/user/settings", defaultRouteRateLimitOptions, getUserSettingsHandler);
  app.patch("/api/user-settings", defaultRouteRateLimitOptions, patchUserSettingsHandler);
  app.patch("/api/user/settings", defaultRouteRateLimitOptions, patchUserSettingsHandler);
}
