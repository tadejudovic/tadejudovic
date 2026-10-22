import crypto from "node:crypto";
import { config } from "../config.ts";
import { store } from "../store.ts";

/**
 * Google OAuth for the Photos Picker API.
 *
 * Since March 2025 the Google Photos Library API no longer lets apps read a
 * user's whole library. The supported path is the Picker API: the user picks
 * items in Google Photos' own UI and the app receives just those items. Its
 * scope is read-only and limited to what the user picked.
 */
export const PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const redirectUri = () => `${config.appUrl}/auth/google/callback`;
const pendingStates = new Set<string>();

/**
 * The Google Photos picker is on whenever the Google keys are set (the same ones used for signing
 * in; the Google Cloud project also needs the Photos Picker API enabled). GOOGLE_PHOTOS_PICKER=0
 * turns it off.
 */
export const googleConfigured = () =>
  process.env.GOOGLE_PHOTOS_PICKER !== "0" && Boolean(config.google.clientId && config.google.clientSecret);

export function authUrl(): string {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: PICKER_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function handleCallback(code: string, state: string) {
  if (!pendingStates.delete(state)) throw new Error("Invalid OAuth state — please try connecting again.");
  const tokens = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  store.setGoogle({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? store.google()?.refresh_token,
    expires_at: Date.now() + (tokens.expires_in - 60) * 1000,
    scope: tokens.scope,
  });
}

export async function accessToken(): Promise<string> {
  const t = store.google();
  if (!t) throw new Error("Google Photos is not connected.");
  if (Date.now() < t.expires_at) return t.access_token;
  if (!t.refresh_token) throw new Error("Google session expired — please reconnect Google Photos.");
  const fresh = await tokenRequest({ refresh_token: t.refresh_token, grant_type: "refresh_token" });
  store.setGoogle({ ...t, access_token: fresh.access_token, expires_at: Date.now() + (fresh.expires_in - 60) * 1000 });
  return fresh.access_token;
}

export function disconnect() {
  const t = store.google();
  store.setGoogle(undefined);
  if (t) {
    // Best effort: revoke the grant on Google's side too.
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token ?? t.access_token)}`, {
      method: "POST",
    }).catch(() => {});
  }
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}
