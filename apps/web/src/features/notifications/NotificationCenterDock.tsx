import { useEffect, useMemo, useState } from "react";
import { NOTIFICATION_SOURCES, NOTIFICATION_SOURCE_LABELS, type NotificationSource, type SpaceNotification } from "@space/contracts";
import { DockButton, DockChips, DockIconButton, DockState, DockToolbar } from "../dock-kit/DockKit.js";
import { Bell, Check, CheckCircle2 } from "../ui-theme/app-icons.js";
import { ackNotification, openNotification, readAllNotifications, refreshNotifications, useNotificationStore } from "./notification-store.js";
import "./notifications.css";

type Filter = "unread" | "all";

function when(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** The Notification Center: everything Space wanted the operator to see, newest first, with read / acknowledge and a click that opens the source. */
export function NotificationCenterDock() {
  const store = useNotificationStore();
  const [filter, setFilter] = useState<Filter>("unread");
  const [source, setSource] = useState<NotificationSource | "ALL">("ALL");
  useEffect(() => { void refreshNotifications(); }, []);
  const items = useMemo(() => store.items.filter((item) => (filter === "all" || item.status === "OPEN") && (source === "ALL" || item.source === source)), [filter, source, store.items]);
  const sources = useMemo(() => [{ id: "ALL" as const, label: "All" }, ...NOTIFICATION_SOURCES.filter((entry) => store.items.some((item) => item.source === entry))
    .map((entry) => ({ id: entry, label: NOTIFICATION_SOURCE_LABELS[entry], count: store.pending.bySource[entry] ?? 0 }))], [store.items, store.pending.bySource]);

  return (
    <section className="notification-center" aria-label="Notification Center">
      <DockToolbar title="Notifications" summary={store.pending.total ? `${store.pending.total} unread` : "Nothing waiting"}>
        <DockButton icon={CheckCircle2} disabled={!store.pending.total} onClick={() => void readAllNotifications()}>Mark all read</DockButton>
      </DockToolbar>
      <div className="notification-center-filters">
        <DockChips<Filter> label="Show" value={filter} onChange={setFilter} options={[{ id: "unread", label: "Unread", count: store.pending.total }, { id: "all", label: "All" }]} />
        {sources.length > 2 ? <DockChips<NotificationSource | "ALL"> label="Source" value={source} onChange={setSource} options={sources} /> : null}
      </div>
      {!store.loaded ? <DockState kind="loading" title="Loading notifications…" /> : null}
      {store.loaded && !items.length ? <DockState kind="empty" icon={Bell} title={filter === "unread" ? "All caught up" : "No notifications yet"} detail={filter === "unread" ? "New mail, questions and alerts show up here." : "What panes and services want you to see lands here."} /> : null}
      <ul className="notification-list" role="list">
        {items.map((item: SpaceNotification) => (
          <li key={item.id} className={`notification-item status-${item.status.toLowerCase()} severity-${item.severity.toLowerCase()}`} data-notification-id={item.id}>
            <button type="button" className="notification-item-main" onClick={() => openNotification(item)} aria-label={`${item.status === "OPEN" ? "Unread: " : ""}${NOTIFICATION_SOURCE_LABELS[item.source]}: ${item.title}`}>
              <span className="notification-item-source">{NOTIFICATION_SOURCE_LABELS[item.source]}</span>
              <strong className="notification-item-title">{item.title}</strong>
              {item.body ? <span className="notification-item-body">{item.body}</span> : null}
              <time className="notification-item-time" dateTime={item.createdAt} title={item.createdAt}>{when(item.createdAt)}</time>
            </button>
            {item.status === "OPEN" || item.status === "READ" ? (
              <DockIconButton label="Acknowledge" icon={Check} title="Acknowledge" onClick={() => void ackNotification(item.id)} />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
