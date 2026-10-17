import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSchema, type Event } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createNotificationService } from "../src/notifications/service.js";

vi.setConfig({ testTimeout: 30_000 });
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: { telegram?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-notifications-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const config = getApiConfig({ SPACE_CLI_ENABLED: "true", SPACE_CLI_COMMAND_PATH: root, SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"), SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"), SPACE_ARTIFACT_ROOT: root });
  const store = new InMemorySpaceStore();
  const eventBus = new SpaceEventBus();
  const published: Event[] = [];
  eventBus.subscribe((event) => { if (event.type.startsWith("NOTIFICATION_")) published.push(event); });
  const notificationsRepository = new InMemorySpaceNotificationsRepository(undefined, options.telegram ?? false);
  const app = await createApp({ store, config, eventBus, notificationsRepository, jobApplyMailTriage: false,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };
  const room = (await app.inject({ method: "POST", url: "/api/rooms", headers, payload: { name: "Notify", initialPaneCount: 0 } })).json() as { id: string; ownerUserId: string };
  const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
  return { app, store, eventBus, published, notificationsRepository, headers, room, pane };
}

describe("Space notifications", () => {
  it("raises, dedupes, lists, counts, reads and acknowledges the owner's notifications; the stream carries ids only", async () => {
    const { app, headers, room, pane, published, eventBus } = await fixture();
    // A browser handoff in the room becomes a notification for the room's owner (bridged from the event bus).
    eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null, traceId: "trace:handoff-1", type: "BROWSER_HANDOFF_REQUESTED",
      message: "CAPTCHA on the form", payload: {}, createdAt: new Date().toISOString() }));
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(1));
    const pending = (await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json();
    expect(pending.byRoom).toEqual({ [room.id]: 1 });
    expect(pending.byPane).toEqual({ [pane.id]: 1 });
    expect(pending.bySource).toEqual({ BROWSER_HANDOFF: 1 });
    const first = pending.latest[0];
    expect(first).toMatchObject({ source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", severity: "ATTENTION", title: "The browser needs you", body: "CAPTCHA on the form",
      link: { roomId: room.id, paneId: pane.id }, dedupeKey: `browser-handoff:${pane.id}`, status: "OPEN" });
    expect(published[0]).toMatchObject({ type: "NOTIFICATION_CREATED", roomId: room.id, paneId: pane.id, payload: { notificationId: first.id, ownerUserId: room.ownerUserId, source: "BROWSER_HANDOFF", status: "OPEN" } });
    expect(published[0]!.payload).not.toHaveProperty("title");
    // The same handoff again refreshes the open notification instead of adding another.
    eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: pane.id, turnId: null, workflowId: null, traceId: "trace:handoff-2", type: "BROWSER_HANDOFF_REQUESTED",
      message: "Login wall", payload: {}, createdAt: new Date().toISOString() }));
    await vi.waitFor(() => expect(published.some((event) => event.type === "NOTIFICATION_UPDATED")).toBe(true));
    const list = (await app.inject({ method: "GET", url: "/api/notifications?status=ALL&limit=10", headers })).json();
    expect(list.notifications).toHaveLength(1);
    expect(list.notifications[0]).toMatchObject({ id: first.id, body: "Login wall" });
    // Read, then acknowledge; a watchdog alert is URGENT and counts again.
    expect((await app.inject({ method: "POST", url: `/api/notifications/${first.id}/read`, headers })).json().notification.status).toBe("READ");
    expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().total).toBe(0);
    // One record by id (a native notification tap): the owner's own, never another id.
    const byId = await app.inject({ method: "GET", url: `/api/notifications/${encodeURIComponent(pending.latest[0].id)}`, headers });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().notification.id).toBe(pending.latest[0].id);
    expect((await app.inject({ method: "GET", url: "/api/notifications/notification%3Anope00000000", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/notifications/${first.id}/ack`, headers })).json().notification).toMatchObject({ status: "ACKED", ackedAt: expect.any(String) });
    eventBus.publish(eventSchema.parse({ id: makeSpaceId("event"), roomId: room.id, paneId: null, turnId: null, workflowId: null, traceId: "trace:watchdog-3", type: "ROOM_WATCHDOG_ALERT",
      message: "Pane host unreachable", payload: {}, createdAt: new Date().toISOString() }));
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/notifications/pending", headers })).json().latest[0]).toMatchObject({ source: "ROOM_WATCHDOG", severity: "URGENT" }));
    expect((await app.inject({ method: "POST", url: "/api/notifications/read-all", headers })).json().read).toBe(1);
    expect((await app.inject({ method: "GET", url: "/api/notifications?status=OPEN", headers })).json().notifications).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/notifications/notification:missing00/read", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/notifications/pending" })).statusCode).toBe(401);
    await app.close();
  });

  it("sends a test notification and queues Telegram only for what needs the user, per the user's channels, never while notifications are suppressed", async () => {
    const { app, headers, notificationsRepository } = await fixture({ telegram: true });
    const test = (await app.inject({ method: "POST", url: "/api/notifications/test", headers })).json().notification;
    expect(test).toMatchObject({ source: "SYSTEM", kind: "TEST", severity: "ATTENTION", title: "Test notification" });
    expect(notificationsRepository.telegram.map((entry) => entry.id)).toEqual([test.id]);
    // Telegram off for SYSTEM: the next test notification stays in-app.
    await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { notifications: { channels: {}, perSource: { SYSTEM: { telegram: false } } } } });
    const second = (await app.inject({ method: "POST", url: "/api/notifications/test", headers })).json().notification;
    expect(notificationsRepository.telegram.map((entry) => entry.id)).toEqual([test.id]);
    expect(second.id).not.toBe(test.id);
    // Suppressed: nothing leaves the Center.
    await app.inject({ method: "PATCH", url: "/api/user-settings", headers, payload: { notifications: null, suppressNotifications: true } });
    await app.inject({ method: "POST", url: "/api/notifications/test", headers });
    expect(notificationsRepository.telegram).toHaveLength(1);
    await app.close();
  });

  it("the service keeps INFO notifications off Telegram, honours a producer override and resolves by dedupe key", async () => {
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const bus = new SpaceEventBus();
    const events: Event[] = [];
    bus.subscribe((event) => events.push(event));
    const service = createNotificationService({ repository, eventBus: bus, userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const info = await service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "INFO", title: "Anna", body: "", link: {}, dedupeKey: "mail:1", payload: {}, telegram: null });
    expect(repository.telegram).toEqual([]);
    expect(events[0]).toMatchObject({ type: "NOTIFICATION_CREATED", roomId: null, payload: { notificationId: info.id } });
    await service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "INFO", title: "Anna", body: "", link: {}, dedupeKey: "mail:2", payload: {}, telegram: true });
    expect(repository.telegram).toHaveLength(1);
    expect(await service.resolve("user:1", "mail:1")).toBe(1);
    expect((await service.pending("user:1")).total).toBe(1);
    expect(await service.resolve("user:1", "mail:1")).toBe(0);
  });
});
