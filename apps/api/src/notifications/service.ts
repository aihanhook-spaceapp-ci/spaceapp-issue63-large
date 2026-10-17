import {
  NOTIFICATION_SOURCE_LABELS, eventSchema, notificationChannelEnabled, notificationRaiseInputSchema, resolveNotificationSettings,
  type Event, type NotificationListQuery, type NotificationRaiseInput, type NotificationStatus, type NotificationStreamPayload, type SpaceNotification, type UserSettings
} from "@space/contracts";
import type { SpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, type SpaceEventBus } from "@space/runtime";

export interface NotificationServiceDeps {
  repository: SpaceNotificationsRepository;
  eventBus: Pick<SpaceEventBus, "publish">;
  /** The owner's settings decide the channels; `suppressNotifications` silences every pop-up and Telegram. */
  userSettings(userId: string): Promise<UserSettings>;
  /** Room events are kept (and replayed) by the store; notifications outside a room only travel the live bus. */
  recordRoomEvent(input: Omit<Event, "id" | "createdAt" | "workflowId">): Promise<Event>;
  log?: { warn(meta: Record<string, unknown>, message: string): void };
  now?(): string;
}

/** Kept for 30 days, then pruned (read or not). */
export const NOTIFICATION_RETENTION_MS = 30 * 24 * 3_600_000;

export function createNotificationService(deps: NotificationServiceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());

  function payloadOf(notification: SpaceNotification): NotificationStreamPayload {
    return { notificationId: notification.id, ownerUserId: notification.ownerUserId, source: notification.source, kind: notification.kind, severity: notification.severity,
      status: notification.status, roomId: notification.roomId, paneId: notification.paneId };
  }
  async function publish(type: "NOTIFICATION_CREATED" | "NOTIFICATION_UPDATED", notification: SpaceNotification) {
    const base = { roomId: notification.roomId ?? "", paneId: notification.paneId, turnId: null, workflowId: null, traceId: `notification:${notification.id}`, type,
      message: `${NOTIFICATION_SOURCE_LABELS[notification.source]}: ${notification.kind}`.slice(0, 1000), payload: payloadOf(notification) as unknown as Record<string, unknown> };
    try {
      // Ids only on the shared stream: every signed-in user receives every event; the owner reads the record through the API.
      if (notification.roomId) deps.eventBus.publish(await deps.recordRoomEvent({ ...base, roomId: notification.roomId }));
      else deps.eventBus.publish(eventSchema.parse({ ...base, id: makeSpaceId("event"), roomId: null, createdAt: now() }));
    } catch (error) {
      deps.log?.warn({ err: error, notificationId: notification.id }, "Notification event could not be published.");
    }
  }

  return {
    /** Records the notification (or refreshes the open one with its dedupe key), publishes it and queues Telegram when the owner wants it. */
    async raise(rawInput: NotificationRaiseInput): Promise<SpaceNotification> {
      const input = notificationRaiseInputSchema.parse(rawInput);
      const { notification, created } = await deps.repository.raise(input);
      await publish(created ? "NOTIFICATION_CREATED" : "NOTIFICATION_UPDATED", notification);
      if (created) {
        const settings = await deps.userSettings(input.ownerUserId).catch(() => null);
        const channels = resolveNotificationSettings(settings?.notifications);
        const telegram = input.telegram ?? (notificationChannelEnabled(channels, input.source, "telegram") && input.severity !== "INFO");
        if (telegram && !settings?.suppressNotifications) {
          await deps.repository.enqueueTelegram(notification, { source: NOTIFICATION_SOURCE_LABELS[notification.source] })
            .catch((error) => deps.log?.warn({ err: error, notificationId: notification.id }, "Notification Telegram enqueue failed."));
        }
      }
      return notification;
    },
    get: (owner: string, id: string) => deps.repository.get(owner, id),
    list: (owner: string, query: NotificationListQuery) => deps.repository.list(owner, query),
    pending: (owner: string) => deps.repository.pending(owner),
    async setStatus(owner: string, id: string, status: Exclude<NotificationStatus, "OPEN">): Promise<SpaceNotification | null> {
      const updated = await deps.repository.setStatus(owner, id, status);
      if (updated) await publish("NOTIFICATION_UPDATED", updated);
      return updated;
    },
    async readAll(owner: string): Promise<number> {
      const count = await deps.repository.readAll(owner);
      if (count) {
        const latest = (await deps.repository.list(owner, { status: "ALL", limit: 1 }))[0];
        if (latest) await publish("NOTIFICATION_UPDATED", latest);
      }
      return count;
    },
    /** A question answered or a thread handled resolves its open notification. */
    async resolve(owner: string, dedupeKey: string): Promise<number> {
      const count = await deps.repository.resolveByDedupeKey(owner, dedupeKey);
      if (count) {
        const latest = (await deps.repository.list(owner, { status: "ALL", limit: 1 }))[0];
        if (latest) await publish("NOTIFICATION_UPDATED", latest);
      }
      return count;
    },
    prune: () => deps.repository.prune(new Date(Date.parse(now()) - NOTIFICATION_RETENTION_MS).toISOString())
  };
}
export type NotificationService = ReturnType<typeof createNotificationService>;
