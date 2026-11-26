"use client";

import { Popover } from "@base-ui/react/popover";
import { ArrowLeftIcon, CaretRightIcon, DevicesIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { accountStore, startAccount, type AccountState } from "@/lib/account";
import { cn } from "@/lib/cn";
import { AccountPanel } from "./account-panel";
import { AlertsBody } from "./alerts-control";
import {
  claimPairCode,
  createPairCode,
  startSync,
  syncStatusStore,
  unlinkDevice,
  type PairCode,
  type SyncConfig,
} from "@/lib/sync";

/**
 * Header control for account-free sync. Starts syncing on mount, shows its state as a small dot,
 * and opens a panel to link another device (QR or 6-character code) or enter a code.
 * Opening a link like /listings#pair=K7P2QX on another device links it automatically.
 */
type PanelView = "devices" | "email" | "alerts";

export function SyncControl({ config }: { config: SyncConfig | null }) {
  const status = useSyncExternalStore(syncStatusStore.subscribe, syncStatusStore.get, syncStatusStore.server);
  const account = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.server);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PanelView>("devices");
  // Focus the panel itself on open, not the code field: no surprise keyboard on phones.
  const popupRef = useRef<HTMLDivElement>(null);

  // Other controls (Alerts) and auth links (password reset) open a specific view.
  useEffect(() => {
    const show = (e: Event) => {
      setView(((e as CustomEvent<PanelView>).detail ?? "devices") as PanelView);
      setOpen(true);
    };
    const linked = () =>
      toast("Signed in", { id: "account", description: "Your list from your other devices is here now." });
    window.addEventListener("hw:open-devices", show);
    window.addEventListener("hw:account-linked", linked);
    return () => {
      window.removeEventListener("hw:open-devices", show);
      window.removeEventListener("hw:account-linked", linked);
    };
  }, []);
  useEffect(() => {
    if (account.phase === "recovery") window.dispatchEvent(new CustomEvent("hw:open-devices", { detail: "email" }));
  }, [account.phase]);

  useEffect(() => {
    if (!config) return;
    const stop = startSync(config);
    startAccount(config);
    // A scanned QR opens /listings#pair=CODE; an already open tab gets it as a hash change.
    const fromHash = () => {
      const code = window.location.hash.match(/^#pair=([A-Za-z0-9-]{6,8})$/)?.[1];
      if (!code) return;
      history.replaceState(history.state, "", window.location.pathname + window.location.search);
      void claim(code);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      stop();
    };
  }, [config]);

  if (!config) return null;
  const dot =
    status.phase === "offline" ? "bg-[#c2410c]" : status.phase === "syncing" ? "bg-ink-3 animate-pulse" : "bg-ink";

  return (
    <Popover.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) setView("devices");
      }}
    >
      <Popover.Trigger
        aria-label={`Your devices (${label(status.phase)})`}
        className="press relative flex h-11 items-center gap-2 rounded-full px-3 text-[14px] font-semibold transition-colors duration-150 hover:bg-hover data-[popup-open]:bg-hover"
      >
        <DevicesIcon size={18} />
        <span className="hidden xl:inline">Devices</span>
        {status.phase !== "off" && (
          <span aria-hidden className={cn("absolute top-2.5 left-7 size-2 rounded-full ring-2 ring-white", dot)} />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50 outline-none">
          <Popover.Popup
            ref={popupRef}
            initialFocus={popupRef}
            className={cn(
              "hw-float-menu w-[min(360px,calc(100vw-24px))] origin-[var(--transform-origin)] rounded-3xl bg-white p-5 shadow-[var(--shadow-sheet)] outline-none",
              "transition-[scale,opacity] duration-150 ease-[var(--ease-out)]",
              "data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            )}
          >
            {open && view === "email" && <AccountPanel onBack={() => setView("devices")} />}
            {open && view === "alerts" && (
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setView("devices")}
                    aria-label="Back to devices"
                    className="press -ml-2 grid size-9 place-items-center rounded-full hover:bg-hover"
                  >
                    <ArrowLeftIcon size={16} weight="bold" />
                  </button>
                  <Popover.Title className="text-[17px] font-semibold tracking-[-0.01em]">Alerts</Popover.Title>
                </div>
                <AlertsBody onNeedEmail={() => setView("email")} />
              </div>
            )}
            {open && view === "devices" && (
              <SyncPanel
                phase={status.phase}
                at={status.at}
                account={account}
                onDone={() => setOpen(false)}
                onView={setView}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function label(phase: string) {
  return phase === "offline" ? "offline, will sync later" : phase === "syncing" ? "syncing" : phase === "synced" ? "synced" : "this device only";
}

async function claim(code: string, onDone?: () => void) {
  try {
    const result = await claimPairCode(code);
    if (result === "linked") {
      toast("Linked", { id: "sync", description: "Your saved homes, notes and search now follow you here." });
      onDone?.();
    } else if (result === "already") {
      toast("Already linked", { id: "sync", description: "This device is already part of that group." });
      onDone?.();
    } else {
      toast("That code didn't work", { id: "sync", description: "Codes last 10 minutes and work once. Make a new one." });
    }
    return result;
  } catch {
    toast("Couldn't link right now", { id: "sync", description: "Check your connection and try again." });
    return "invalid" as const;
  }
}

function SyncPanel({
  phase,
  at,
  account,
  onDone,
  onView,
}: {
  phase: string;
  at: number | null;
  account: AccountState;
  onDone: () => void;
  onView: (view: PanelView) => void;
}) {
  const [pair, setPair] = useState<PairCode | null>(null);
  const [failed, setFailed] = useState(false);
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);

  const load = useCallback(
    () =>
      createPairCode().then(
        (code) => {
          setPair(code);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const refresh = () => {
    setPair(null);
    setFailed(false);
    void load();
  };

  const left = pair ? Math.max(0, Math.round((Date.parse(pair.expiresAt) - now) / 1000)) : 0;
  const expired = !!pair && left === 0;
  const link = pair ? `${window.location.origin}/listings#pair=${pair.code}` : "";
  const normalized = entry.toUpperCase().replace(/[^A-Z0-9]/g, "");

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <Popover.Title className="text-[17px] font-semibold tracking-[-0.01em]">Your devices</Popover.Title>
        <span className="text-[12px] text-ink-2">{statusLine(phase, at, now)}</span>
      </div>

      <section className="flex gap-4">
        <div className="grid size-[124px] shrink-0 place-items-center rounded-2xl bg-subtle p-2">
          {pair && !expired ? <Qr text={link} /> : <span className="text-[12px] text-ink-3">{failed ? "Offline" : "…"}</span>}
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-1.5">
          <Popover.Description className="text-[13px] leading-snug text-ink-2">
            Scan with your phone, or type this code on the other device. No account needed.
          </Popover.Description>
          <p className="tabular font-mono text-[24px] font-semibold tracking-[0.12em] select-text">
            {pair && !expired ? `${pair.code.slice(0, 3)}·${pair.code.slice(3)}` : "—"}
          </p>
          <p className="text-[12px] text-ink-3">
            {expired || failed ? (
              <button type="button" onClick={refresh} className="font-semibold text-ink underline underline-offset-4">
                New code
              </button>
            ) : pair ? (
              `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
            ) : (
              "Making a code…"
            )}
          </p>
        </div>
      </section>

      <form
        className="border-t border-line-soft pt-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (normalized.length !== 6 || busy) return;
          setBusy(true);
          const result = await claim(normalized, onDone);
          setBusy(false);
          if (result === "invalid") setEntry("");
        }}
      >
        <label htmlFor="pair-code" className="text-[13px] font-semibold">
          Have a code from another device?
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="pair-code"
            value={entry}
            onChange={(e) => setEntry(e.target.value.slice(0, 8))}
            placeholder="K7P2QX"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="tabular h-11 min-w-0 flex-1 rounded-xl bg-subtle px-3 font-mono text-[16px] tracking-[0.12em] uppercase outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-ink"
          />
          <button
            type="submit"
            disabled={normalized.length !== 6 || busy}
            className="press h-11 rounded-xl bg-ink px-4 text-[14px] font-semibold text-white transition-opacity disabled:opacity-30"
          >
            {busy ? "Linking…" : "Link"}
          </button>
        </div>
      </form>

      <div className="border-t border-line-soft pt-1">
        <Row
          title="Email"
          detail={account.phase === "signed-in" ? (account.email ?? "Signed in") : "Optional · get your list back anywhere"}
          onClick={() => onView("email")}
        />
        {/* The header has no room for the bell on phones: alerts live here. */}
        <div className="sm:hidden">
          <Row title="Alerts" detail="New homes for your search" onClick={() => onView("alerts")} />
        </div>
      </div>

      <button
        type="button"
        onClick={async () => {
          await unlinkDevice().catch(() => {});
          toast("This device stopped syncing", { id: "sync", description: "It keeps its own copy of your list." });
          refresh();
        }}
        className="text-[12px] text-ink-3 underline underline-offset-4 hover:text-ink"
      >
        Stop syncing this device
      </button>
    </div>
  );
}

function Row({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press -mx-2 flex w-[calc(100%+16px)] items-center justify-between gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-hover"
    >
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold">{title}</span>
        <span className="block truncate text-[12px] text-ink-3">{detail}</span>
      </span>
      <CaretRightIcon size={14} weight="bold" className="shrink-0 text-ink-3" />
    </button>
  );
}

function statusLine(phase: string, at: number | null, now: number) {
  if (phase === "offline") return "Offline · will sync";
  if (phase === "syncing") return "Syncing…";
  if (phase === "synced" && at) {
    const s = Math.round((now - at) / 1000);
    return s < 10 ? "Synced just now" : s < 60 ? `Synced ${s}s ago` : `Synced ${Math.round(s / 60)} min ago`;
  }
  return "";
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** QR drawn as one SVG path from uqr's module matrix (loaded only when the panel opens). */
function Qr({ text }: { text: string }) {
  const [matrix, setMatrix] = useState<boolean[][] | null>(null);
  const current = useRef(text);
  useEffect(() => {
    current.current = text;
    void import("uqr").then(({ encode }) => {
      if (current.current === text) setMatrix(encode(text, { ecc: "M", border: 1 }).data);
    });
  }, [text]);
  if (!matrix) return null;
  let d = "";
  matrix.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
  return (
    <svg viewBox={`0 0 ${matrix.length} ${matrix.length}`} className="size-full" shapeRendering="crispEdges" role="img" aria-label="QR code to link another device">
      <rect width={matrix.length} height={matrix.length} fill="#fff" />
      <path d={d} fill="currentColor" />
    </svg>
  );
}
