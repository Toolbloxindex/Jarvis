"use client";

import { currentSyncKey, onSyncKeyChange, syncRpc } from "./sync";

/**
 * Alerts for new homes matching the synced search. Settings live in Supabase per sync key
 * (alert_subscriptions); the collector sends email digests (Resend) and web push after each run.
 */

export interface AlertSettings {
  enabled: boolean;
  /** Masked confirmed email when the email channel is on, else null. */
  email: string | null;
  /** Push endpoints registered for this key (all linked devices). */
  push: string[];
}

const ENDPOINT_KEY = "hw:push:endpoint";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export const getAlerts = () => syncRpc<AlertSettings>("alerts_get", { p_key: currentSyncKey() });

export const setAlerts = (enabled: boolean, email: boolean | null = null) =>
  syncRpc<AlertSettings>("alerts_set", { p_key: currentSyncKey(), p_enabled: enabled, p_email: email });

/* ---------- push ---------- */

export type PushSupport =
  /** Push works here. */
  | "ready"
  /** iPhone/iPad Safari tab: push only works after "Add to Home Screen". */
  | "install-first"
  /** No push in this browser (or no VAPID key configured). */
  | "unsupported";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || !VAPID_PUBLIC_KEY) return "unsupported";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return "install-first";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ready";
}

/** The endpoint this device registered, if notifications are on here. */
export function thisDeviceEndpoint() {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

function base64UrlToBytes(value: string) {
  const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration() {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export type PushResult = "on" | "denied" | "unsupported" | "install-first";

/** Ask permission (must run from a tap), subscribe, and register this device for alerts. */
export async function enablePush(): Promise<PushResult> {
  const support = pushSupport();
  if (support !== "ready") return support;
  // Ask only when needed: an already granted (or denied) permission needs no prompt.
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return "denied";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY) }));
  await syncRpc("alerts_push_add", { p_key: currentSyncKey(), p_sub: sub.toJSON() });
  localStorage.setItem(ENDPOINT_KEY, sub.endpoint);
  return "on";
}

export async function disablePush() {
  const endpoint = thisDeviceEndpoint();
  if (endpoint) await syncRpc("alerts_push_remove", { p_key: currentSyncKey(), p_endpoint: endpoint });
  localStorage.removeItem(ENDPOINT_KEY);
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}

/** When this browser joins another key (pairing, email), move its push subscription along. */
let watching = false;
export function followKeyChanges() {
  if (watching) return;
  watching = true;
  onSyncKeyChange(async (next, previous) => {
    const endpoint = thisDeviceEndpoint();
    if (!endpoint || !previous) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return;
      await syncRpc("alerts_push_add", { p_key: next, p_sub: sub.toJSON() });
      await syncRpc("alerts_push_remove", { p_key: previous, p_endpoint: endpoint });
    } catch {
      // Best effort: the user can turn notifications on again from Alerts.
    }
  });
}
