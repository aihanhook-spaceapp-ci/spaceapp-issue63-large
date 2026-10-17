// System notifications: one switch and one delivery path for every notification source. In a browser they are
// the Notification API; inside the Android app or the Electron desktop app the shell shows a native notification
// whose tap brings Space back and opens the record. Shown only while Space is in the background (the toast covers
// the foreground).
const settingsKey = "space.notifications.desktop";

/** The Android shell's bridge (`SpaceNativeBridge` in MainActivity.java). */
interface AndroidNotifier {
  notify(id: string, title: string, body: string): boolean;
  notificationsAllowed(): boolean;
  requestNotificationPermission(): boolean;
  takePendingNotification(): string | null;
}
/** The Electron preload bridge (`window.spaceDesktop`). */
interface DesktopNotifier {
  notify(input: { id: string; title: string; body: string }): Promise<boolean>;
  onNotificationOpen(callback: (id: string) => void): () => void;
}
function android(): AndroidNotifier | null {
  const bridge = (window as unknown as { SpaceNative?: Partial<AndroidNotifier> }).SpaceNative;
  return typeof bridge?.notify === "function" ? bridge as AndroidNotifier : null;
}
function desktopApp(): DesktopNotifier | null {
  const bridge = (window as unknown as { spaceDesktop?: Partial<DesktopNotifier> }).spaceDesktop;
  return typeof bridge?.notify === "function" ? bridge as DesktopNotifier : null;
}
/** True inside the Android app or the desktop app: notifications come from the system, not the browser. */
export function nativeNotificationsAvailable(): boolean {
  return typeof window !== "undefined" && (android() !== null || desktopApp() !== null);
}
export function desktopNotificationsSupported(): boolean {
  return typeof window !== "undefined" && (nativeNotificationsAvailable() || "Notification" in window);
}
export function desktopNotificationPermission(): "granted" | "denied" | "default" | "unsupported" {
  if (typeof window === "undefined") return "unsupported";
  const app = android();
  if (app) return app.notificationsAllowed() ? "granted" : "default";
  if (desktopApp()) return "granted";
  return "Notification" in window ? Notification.permission : "unsupported";
}
/** Per device, off until the operator turns it on (a browser needs a click for the permission prompt). */
export function desktopNotificationsEnabled(): boolean {
  try { return window.localStorage.getItem(settingsKey) === "on"; } catch { return false; }
}
export async function setDesktopNotifications(enabled: boolean): Promise<boolean> {
  if (!desktopNotificationsSupported()) return false;
  let allowed = true;
  const app = android();
  if (app) {
    // The system prompt answers later; the switch stays on and `notify` reports what the system allows.
    if (enabled && !app.notificationsAllowed()) app.requestNotificationPermission();
  } else if (!desktopApp()) {
    allowed = Notification.permission === "granted";
    if (enabled && !allowed && Notification.permission !== "denied") allowed = (await Notification.requestPermission()) === "granted";
  }
  const on = enabled && allowed;
  try { window.localStorage.setItem(settingsKey, on ? "on" : "off"); } catch { /* private mode: not remembered */ }
  return on;
}
export function spaceInBackground(): boolean {
  return document.hidden || !document.hasFocus();
}
export function showDesktopNotification(input: { title: string; body: string; tag: string; onClick(): void }): boolean {
  if (!desktopNotificationsEnabled() || !spaceInBackground()) return false;
  const body = input.body.slice(0, 240);
  const app = android();
  if (app) {
    try { return app.notify(input.tag, input.title, body); } catch { return false; }
  }
  const desktop = desktopApp();
  if (desktop) {
    void desktop.notify({ id: input.tag, title: input.title, body }).catch(() => undefined);
    return true;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  try {
    const notification = new Notification(input.title, { body, tag: input.tag });
    notification.onclick = () => { window.focus(); input.onClick(); notification.close(); };
    return true;
  } catch {
    return false;
  }
}
/**
 * A tap on a native notification reaches the page as the notification id: Android keeps the id of the tapped
 * notification until the page takes it (also across a cold start), Electron sends it over IPC.
 */
export function subscribeNativeNotificationOpen(handler: (id: string) => void): () => void {
  const app = android();
  if (app) {
    const take = () => { let id: string | null = null; try { id = app.takePendingNotification(); } catch { id = null; } if (id) handler(id); };
    (window as unknown as { __spaceOpenNotification?: () => void }).__spaceOpenNotification = take;
    take();
    return () => { delete (window as unknown as { __spaceOpenNotification?: () => void }).__spaceOpenNotification; };
  }
  const desktop = desktopApp();
  if (desktop) {
    try { return desktop.onNotificationOpen((id) => { if (id) handler(id); }); } catch { return () => undefined; }
  }
  return () => undefined;
}
