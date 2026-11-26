"use client";

import { Popover } from "@base-ui/react/popover";
import { Switch } from "@base-ui/react/switch";
import { BellIcon, BellRingingIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { accountStore } from "@/lib/account";
import {
  disablePush,
  enablePush,
  followKeyChanges,
  getAlerts,
  pushSupport,
  setAlerts,
  thisDeviceEndpoint,
  type AlertSettings,
} from "@/lib/alerts";
import { currentSyncKey } from "@/lib/sync";

/**
 * Alerts for new homes matching your search: by email (needs the optional email sign-in) and/or
 * push on this device (needs "Add to Home Screen" on iPhone). Settings load only when opened; the
 * bell remembers the last known state locally so page loads cost nothing.
 */

const ON_KEY = "hw:alerts:on";
const onListeners = new Set<() => void>();
const onStore = {
  subscribe(l: () => void) {
    onListeners.add(l);
    return () => void onListeners.delete(l);
  },
  get: () => {
    try {
      return localStorage.getItem(ON_KEY) === "1";
    } catch {
      return false;
    }
  },
  server: () => false,
};
function rememberOn(on: boolean) {
  try {
    localStorage.setItem(ON_KEY, on ? "1" : "0");
  } catch {}
  for (const l of onListeners) l();
}

/** Ask the Devices panel to show its email view (sign in / add email). */
export const openEmailSetup = () => window.dispatchEvent(new CustomEvent("hw:open-devices", { detail: "email" }));

export function AlertsControl({ enabled }: { enabled: boolean }) {
  const on = useSyncExternalStore(onStore.subscribe, onStore.get, onStore.server);
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  if (!enabled) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={on ? "Alerts for new matches (on)" : "Alerts for new matches"}
        className="press hidden h-11 items-center gap-2 rounded-full px-3.5 text-[14px] font-semibold transition-colors hover:bg-hover data-[popup-open]:bg-hover sm:flex"
      >
        {on ? <BellRingingIcon size={18} weight="fill" /> : <BellIcon size={18} />}
        <span className="hidden xl:inline">Alerts</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50 outline-none">
          <Popover.Popup
            ref={popupRef}
            initialFocus={popupRef}
            className={cn(
              "hw-float-menu w-[min(340px,calc(100vw-24px))] origin-[var(--transform-origin)] rounded-3xl bg-white p-5 shadow-[var(--shadow-sheet)] outline-none",
              "transition-[scale,opacity] duration-150 ease-[var(--ease-out)]",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            <Popover.Title className="mb-1 text-[17px] font-semibold tracking-[-0.01em]">Alerts</Popover.Title>
            {open && (
              <AlertsBody
                onNeedEmail={() => {
                  setOpen(false);
                  openEmailSetup();
                }}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The settings themselves; also shown inside the Devices panel on phones. */
export function AlertsBody({ onNeedEmail }: { onNeedEmail: () => void }) {
  const account = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.server);
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<null | "email" | "push">(null);
  const [support] = useState(pushSupport);
  const [deviceOn, setDeviceOn] = useState(() => !!thisDeviceEndpoint());

  const apply = (next: AlertSettings) => {
    setSettings(next);
    rememberOn(next.enabled);
  };

  useEffect(() => {
    followKeyChanges();
    if (!currentSyncKey()) return;
    getAlerts().then(apply, () => setFailed(true));
  }, []);

  const signedIn = account.phase === "signed-in";
  const emailOn = !!settings?.email;
  const pushCount = settings?.push.length ?? 0;

  async function toggleEmail(next: boolean) {
    setBusy("email");
    try {
      apply(await setAlerts(next || pushCount > 0, next));
      if (next) toast("Email alerts on", { id: "alerts", description: "New homes for this search reach your inbox, at most hourly." });
    } catch {
      toast("Couldn't change email alerts", { id: "alerts", description: "Check your connection and try again." });
    }
    setBusy(null);
  }

  async function togglePush(next: boolean) {
    setBusy("push");
    try {
      if (next) {
        const result = await enablePush();
        if (result === "denied") {
          toast("Notifications are blocked", { id: "alerts", description: "Allow them for this site in your browser settings." });
        } else if (result === "on") {
          setDeviceOn(true);
          toast("Notifications on", { id: "alerts", description: "This device gets a notification when new homes match." });
        }
      } else {
        await disablePush();
        setDeviceOn(false);
      }
      const fresh = await getAlerts();
      // No channel left: alerts are off.
      apply(fresh.enabled && !fresh.email && fresh.push.length === 0 ? await setAlerts(false) : fresh);
    } catch {
      toast("Couldn't change notifications", { id: "alerts", description: "Check your connection and try again." });
    }
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      <Popover.Description className="text-[13px] leading-snug text-ink-2">
        New homes that match your current search and filters, as soon as they appear.
      </Popover.Description>

      {failed ? (
        <p className="text-[13px] text-ink-3">Offline. Try again in a moment.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          <li className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="text-[14px] font-semibold">Email</p>
              <p className="truncate text-[12px] text-ink-3">
                {emailOn ? settings?.email : signedIn ? (account.email ?? "Your email") : "Sign in with your email first"}
              </p>
            </div>
            {signedIn || emailOn ? (
              <Toggle checked={emailOn} disabled={!settings || busy !== null} onChange={toggleEmail} label="Email alerts" />
            ) : (
              <button type="button" onClick={onNeedEmail} className="press h-9 shrink-0 rounded-full px-3.5 text-[13px] font-semibold shadow-[inset_0_0_0_1px_var(--color-line)] hover:shadow-[inset_0_0_0_1px_var(--color-ink)]">
                Add email
              </button>
            )}
          </li>
          <li className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="text-[14px] font-semibold">Notifications on this device</p>
              <p className="text-[12px] leading-snug text-ink-3">
                {support === "install-first"
                  ? "On iPhone: tap Share, then Add to Home Screen. Open Housewatch from there to turn this on."
                  : support === "unsupported"
                    ? "This browser can't show notifications."
                    : pushCount > (deviceOn ? 1 : 0)
                      ? `Also on ${pushCount - (deviceOn ? 1 : 0)} other device${pushCount - (deviceOn ? 1 : 0) === 1 ? "" : "s"}`
                      : "Works when the browser is closed"}
              </p>
            </div>
            {support === "ready" && (
              <Toggle checked={deviceOn} disabled={!settings || busy !== null} onChange={togglePush} label="Notifications on this device" />
            )}
          </li>
        </ul>
      )}
    </div>
  );
}

function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Switch.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative flex h-6 w-10 shrink-0 rounded-full bg-line p-0.5 transition-colors duration-200 data-[checked]:bg-ink data-[disabled]:opacity-50"
    >
      <Switch.Thumb className="block size-5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-[translate] duration-200 ease-[var(--ease-out)] data-[checked]:translate-x-4" />
    </Switch.Root>
  );
}
