"use client";

import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { adoptKey, currentSyncKey, setSyncAuthToken, syncRpc, type SyncConfig } from "./sync";

/**
 * Optional email account on top of the account-free sync key (Supabase Auth).
 *
 * Signing in (password or emailed link) ties the account to one sync key: the first device that
 * signs in stores its key, every later device adopts it and merges its own list in. Signing out
 * keeps everything on this device. supabase-js is loaded only when it is needed: a stored session,
 * an auth link in the URL, or when the person opens the email view.
 */

const STORAGE_KEY = "hw-auth";

export interface AccountState {
  /** "unknown" until we know whether a session exists. */
  phase: "unknown" | "signed-out" | "signed-in" | "recovery";
  email: string | null;
}

let state: AccountState = { phase: "unknown", email: null };
const SERVER_STATE: AccountState = { phase: "unknown", email: null };
const listeners = new Set<() => void>();
function setState(next: AccountState) {
  state = next;
  for (const l of listeners) l();
}
export const accountStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  get: () => state,
  server: () => SERVER_STATE,
};

let config: SyncConfig | null = null;
let clientPromise: Promise<SupabaseClient> | null = null;

function client() {
  if (!config) throw new Error("account is not configured");
  const cfg = config;
  clientPromise ??= import("@supabase/supabase-js").then(({ createClient }) => {
    const supabase = createClient(cfg.url, cfg.anonKey, {
      auth: {
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Implicit flow: an emailed link works even when opened on another device than the one
        // that asked for it (PKCE would need the asking browser's verifier).
        flowType: "implicit",
      },
    });
    supabase.auth.onAuthStateChange((event, session) => {
      // Supabase warns against awaiting other Supabase calls inside this callback.
      setTimeout(() => void onAuth(event, session), 0);
    });
    return supabase;
  });
  return clientPromise;
}

async function onAuth(event: AuthChangeEvent, session: Session | null) {
  setSyncAuthToken(session?.access_token ?? null);
  if (!session) {
    setState({ phase: "signed-out", email: null });
    return;
  }
  const email = session.user.email ?? null;
  if (event === "PASSWORD_RECOVERY") {
    setState({ phase: "recovery", email });
    return;
  }
  setState({ phase: state.phase === "recovery" ? "recovery" : "signed-in", email });
  if (event === "SIGNED_IN" || event === "INITIAL_SESSION") await linkThisDevice();
}

/** Store this device's key on the account, or adopt the account's key. */
async function linkThisDevice() {
  const key = currentSyncKey();
  if (!key) return;
  try {
    const accountKey = await syncRpc<string>("account_link", { p_key: key });
    if (accountKey && accountKey !== key) {
      await adoptKey(accountKey);
      window.dispatchEvent(new CustomEvent("hw:account-linked"));
    }
  } catch {
    // Offline: the next session event (token refresh, reload) tries again.
  }
}

/** Call once sync has started. Loads supabase-js only when a session or auth link exists. */
export function startAccount(cfg: SyncConfig) {
  config = cfg;
  let stored = false;
  try {
    stored = localStorage.getItem(STORAGE_KEY) !== null;
  } catch {}
  const authLink = /(?:^|[#&?])(access_token|error_description|token_hash)=/.test(
    window.location.hash + window.location.search,
  );
  if (stored || authLink) void client();
  else setState({ phase: "signed-out", email: null });
}

const redirect = () => `${window.location.origin}/listings`;
const message = (error: { message?: string } | null) => error?.message ?? "Something went wrong";

export type EmailResult =
  | { ok: true; next: "signed-in" | "check-inbox" }
  | { ok: false; reason: "wrong-password" | "error"; message: string };

/**
 * One form for everything: with a password, sign in (or create the account); without one, email
 * a sign-in link.
 */
export async function continueWithEmail(email: string, password: string): Promise<EmailResult> {
  const supabase = await client();
  if (!password) {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect() } });
    return error ? { ok: false, reason: "error", message: message(error) } : { ok: true, next: "check-inbox" };
  }
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (!signIn.error) return { ok: true, next: "signed-in" };
  if (!/invalid login credentials/i.test(signIn.error.message)) {
    return { ok: false, reason: "error", message: message(signIn.error) };
  }
  const signUp = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirect() } });
  if (signUp.error) return { ok: false, reason: "error", message: message(signUp.error) };
  // An existing account answers sign-up with an empty identity list: the password was wrong.
  if (signUp.data.user && signUp.data.user.identities?.length === 0) {
    return { ok: false, reason: "wrong-password", message: "Wrong password for this email." };
  }
  return { ok: true, next: signUp.data.session ? "signed-in" : "check-inbox" };
}

export async function sendPasswordReset(email: string) {
  const { error } = await (await client()).auth.resetPasswordForEmail(email, { redirectTo: redirect() });
  if (error) throw new Error(message(error));
}

export async function setPassword(password: string) {
  const { error } = await (await client()).auth.updateUser({ password });
  if (error) throw new Error(message(error));
  setState({ phase: "signed-in", email: state.email });
}

/** Sign out on this device only. The list and the sync key stay. */
export async function signOut() {
  await (await client()).auth.signOut({ scope: "local" });
  setSyncAuthToken(null);
  setState({ phase: "signed-out", email: null });
}

/** Warm up the auth client when the email view opens. */
export const prepareAccount = () => {
  if (config) void client();
};
