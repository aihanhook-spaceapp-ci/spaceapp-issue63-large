import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idSchema } from "@space/contracts";
import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import { sendApiError } from "./http-errors.js";
import { parseQuery } from "./route-parsing.js";
import {
  eventMatchesRoom, formatReplayEvents, formatSseMessage, loadEventStreamReplay, startSseHeartbeat, trackSeenEventId
} from "./sse.js";

const eventStreamQuerySchema = z.object({
  roomId: idSchema.optional(),
  replayLimit: z.coerce.number().int().min(1).max(500).optional()
});

const listEventsQuerySchema = z
  .object({
    roomId: idSchema.optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortOrder: z.enum(["asc", "desc"]).optional()
  })
  .transform((input) => ({
    roomId: input.roomId,
    page: input.page ?? 1,
    pageSize: input.pageSize ?? input.limit ?? 50,
    sortOrder: input.sortOrder ?? "desc"
  }));

/**
 * Room event list and the SSE event stream with replay; the parent retains authentication, CSRF, errors and rate
 * limits.
 */
export function registerEventRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  eventBus: SpaceEventBus;
  routeOptions: { config: { rateLimit: { max: number; timeWindow: string } } };
}) {
  const { store, eventBus, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/events", defaultRouteRateLimitOptions, async (request, reply) => {
    const parsedQuery = listEventsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return sendApiError(reply, 400, "VALIDATION_ERROR", "Invalid request data.", parsedQuery.error.flatten());
    }
    const query = parsedQuery.data;
    if (query.roomId) {
      await store.getRoom(query.roomId);
    }
    const events = await store.listEventsPage(query);
    return {
      data: events.items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: events.total,
        totalPages: Math.ceil(events.total / query.pageSize)
      }
    };
  });
  app.get("/api/events/stream", { config: { rateLimit: defaultRouteRateLimitOptions.config.rateLimit }, compress: false }, async (request, reply) => {
    const query = parseQuery(eventStreamQuerySchema, request.query);
    if (query.roomId) {
      await store.getRoom(query.roomId);
    }
    const replayEvents = await loadEventStreamReplay(store, query);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(formatSseMessage("ready", { ok: true, requestId: request.requestIdForSpace }));
    reply.raw.write(formatSseMessage("replay-start", { count: replayEvents.length }));
    reply.raw.write(formatReplayEvents(replayEvents));
    reply.raw.write(formatSseMessage("replay-complete", { count: replayEvents.length }));
    const seenEventIds = new Set(replayEvents.map((event) => event.id));
    let isClosed = false;
    const stopHeartbeat = startSseHeartbeat((frame) => {
      if (!isClosed) reply.raw.write(frame);
    });
    const unsubscribe = eventBus.subscribe((event) => {
      if (!isClosed && eventMatchesRoom(event, query.roomId) && !seenEventIds.has(event.id)) {
        trackSeenEventId(seenEventIds, event.id);
        reply.raw.write(formatSseMessage(event.type, event));
      }
    });
    const closeStream = () => {
      if (isClosed) return;
      isClosed = true;
      stopHeartbeat();
      unsubscribe();
    };
    reply.raw.once("close", closeStream);
    request.raw.once("aborted", closeStream);
  });
}
