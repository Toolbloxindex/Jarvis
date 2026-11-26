"use client";

import { Popover } from "@base-ui/react/popover";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { accountStore, continueWithEmail, prepareAccount, sendPasswordReset, setPassword, signOut } from "@/lib/account";

/**
 * The optional email step inside the Devices panel. One short form: email, and a password only if
 * you want one (no password = we email you a sign-in link). Signed in, any device you sign in on
 * gets your list; alerts can go to this email.
 */

const field =
  "h-11 w-full rounded-xl bg-subtle px-3 text-[16px] outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-ink";
const primary =
  "press h-11 w-full rounded-xl bg-ink px-4 text-[14px] font-semibold text-white transition-opacity disabled:opacity-30";
const quiet = "text-[12px] text-ink-3 underline underline-offset-4 hover:text-ink";

export function AccountPanel({ onBack }: { onBack: () => void }) {
  const account = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.server);
  useEffect(prepareAccount, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} aria-label="Back to devices" className="press -ml-2 grid size-9 place-items-center rounded-full hover:bg-hover">
          <ArrowLeftIcon size={16} weight="bold" />
        </button>
        <Popover.Title className="text-[17px] font-semibold tracking-[-0.01em]">
          {account.phase === "recovery" ? "New password" : "Email"}
        </Popover.Title>
      </div>
      {account.phase === "recovery" ? (
        <PasswordForm label="Save password" onSaved={() => toast("Password saved", { id: "account" })} />
      ) : account.phase === "signed-in" ? (
        <SignedIn email={account.email} />
      ) : (
        <EmailForm />
      )}
    </div>
  );
}

function EmailForm() {
  const [email, setEmail] = useState("");
  const [password, setPasswordValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<null | "link" | "confirm" | "reset">(null);
  const [error, setError] = useState<string | null>(null);
  const [wrongPassword, setWrongPassword] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  if (sent) {
    return (
      <div className="space-y-3">
        <p className="text-[15px] font-semibold">Check your inbox</p>
        <p className="text-[13px] leading-snug text-ink-2">
          {sent === "reset"
            ? `We sent a link to ${email.trim()} to choose a new password.`
            : sent === "confirm"
              ? `Confirm ${email.trim()} with the link we sent. Then you're signed in here.`
              : `We sent a sign-in link to ${email.trim()}. Open it on this device or any other.`}
        </p>
        <button type="button" className={quiet} onClick={() => setSent(null)}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        setError(null);
        setWrongPassword(false);
        try {
          const result = await continueWithEmail(email.trim(), password);
          if (result.ok) {
            if (result.next === "signed-in") toast("Signed in", { id: "account", description: "Your list now follows this email." });
            else setSent(password ? "confirm" : "link");
          } else {
            setError(result.message);
            setWrongPassword(result.reason === "wrong-password");
          }
        } catch {
          setError("Couldn't reach the server. Try again.");
        }
        setBusy(false);
      }}
    >
      <Popover.Description className="text-[13px] leading-snug text-ink-2">
        Optional. Sign in on any device to get your list back, and get new-home alerts by email.
      </Popover.Description>
      <input
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={field}
        aria-label="Email"
      />
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Password (optional)"
        value={password}
        onChange={(e) => setPasswordValue(e.target.value)}
        className={field}
        aria-label="Password, optional"
      />
      {error && (
        <p role="alert" className="text-[13px] text-[#b42318]">
          {error}
        </p>
      )}
      <button type="submit" disabled={!valid || busy} className={primary}>
        {busy ? "One moment…" : password ? "Continue" : "Email me a sign-in link"}
      </button>
      {(wrongPassword || password) && valid && (
        <button
          type="button"
          className={quiet}
          onClick={async () => {
            try {
              await sendPasswordReset(email.trim());
              setSent("reset");
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          Forgot password?
        </button>
      )}
    </form>
  );
}

function SignedIn({ email }: { email: string | null }) {
  const [changing, setChanging] = useState(false);
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-snug text-ink-2">
        Signed in as <span className="font-semibold text-ink select-text">{email}</span>. Sign in with this email on
        any device to get your list.
      </p>
      {changing ? (
        <PasswordForm label="Save password" onSaved={() => setChanging(false)} />
      ) : (
        <div className="flex items-center gap-4">
          <button type="button" className={quiet} onClick={() => setChanging(true)}>
            Set a password
          </button>
          <button
            type="button"
            className={quiet}
            onClick={async () => {
              await signOut().catch(() => {});
              toast("Signed out", { id: "account", description: "Your list stays on this device." });
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function PasswordForm({ label, onSaved }: { label: string; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (value.length < 8 || busy) return;
        setBusy(true);
        setError(null);
        try {
          await setPassword(value);
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        }
        setBusy(false);
      }}
    >
      <input
        type="password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={field}
        aria-label="New password"
      />
      {error && (
        <p role="alert" className="text-[13px] text-[#b42318]">
          {error}
        </p>
      )}
      <button type="submit" disabled={value.length < 8 || busy} className={primary}>
        {busy ? "Saving…" : label}
      </button>
    </form>
  );
}
