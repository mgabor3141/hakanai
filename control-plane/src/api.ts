import type { Conversation } from "./types";

export async function listConversations(): Promise<Conversation[]> {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error(await res.text());
  const conversations = (await res.json()) as Conversation[];
  return conversations.sort((a, b) => b.lastActivity - a.lastActivity);
}

// Returned when an action cannot get a running slot without interrupting a busy
// conversation. The caller confirms with the user, then retries with force.
export type AtCapacity = { atCapacity: true; wouldInterrupt: { id: string; title: string | null } };
export const isAtCapacity = (v: unknown): v is AtCapacity => typeof v === "object" && v !== null && "atCapacity" in v;

async function denialOf(res: Response): Promise<AtCapacity> {
  const body = (await res.json()) as { wouldInterrupt: { id: string; title: string | null } };
  return { atCapacity: true, wouldInterrupt: body.wouldInterrupt };
}

export async function createConversation(force = false): Promise<string | AtCapacity> {
  const res = await fetch(`/api/conversations${force ? "?force=1" : ""}`, { method: "POST" });
  if (res.status === 409) return denialOf(res);
  if (!res.ok) throw new Error(await res.text());
  const { id } = (await res.json()) as { id: string };
  return id;
}

// Ensure a conversation is loaded (within the memory budget) before connecting.
// Returns AtCapacity if loading it would interrupt a busy conversation and
// force was not set.
export async function activateConversation(id: string, force = false): Promise<true | AtCapacity> {
  const res = await fetch(`/api/conversations/${id}/activate${force ? "?force=1" : ""}`, { method: "POST" });
  if (res.status === 409) return denialOf(res);
  if (!res.ok) throw new Error(await res.text());
  return true;
}

export async function getConfig(): Promise<{ maxActive: number; configured: boolean; vertexModels: string[] }> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { maxActive: number; configured: boolean; vertexModels: string[] };
}

// The redacted settings view: never carries the token / ADC, only presence flags.
export type PublicSettings =
  | { provider: "none" }
  | { provider: "openai"; endpoint: string; model: string; hasToken: boolean }
  | { provider: "vertex"; project: string; location: string; model: string; connected: boolean };

export type IncomingSettings =
  | { provider: "openai"; endpoint: string; token?: string; model: string }
  | { provider: "vertex"; project: string; location: string; model: string };

export async function getSettings(): Promise<PublicSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as PublicSettings;
}

export async function saveSettings(s: IncomingSettings): Promise<PublicSettings> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(s),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `save failed (${res.status})`);
  }
  return (await res.json()) as PublicSettings;
}

// Proxy OpenAI-compatible model discovery (also a pre-save connection test).
export async function discoverModels(endpoint: string, token: string): Promise<string[]> {
  const res = await fetch("/api/settings/discover-models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, token }),
  });
  const body = (await res.json().catch(() => ({}))) as { models?: string[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `discovery failed (${res.status})`);
  return body.models ?? [];
}

export type GoogleAuthStatus = { phase: "idle" | "pending" | "connected" | "error"; url: string | null; error: string | null };

export async function startGoogleAuth(): Promise<string> {
  const res = await fetch("/api/auth/google/start", { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `start failed (${res.status})`);
  return body.url ?? "";
}

export async function completeGoogleAuth(code: string): Promise<GoogleAuthStatus> {
  const res = await fetch("/api/auth/google/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json().catch(() => ({}))) as GoogleAuthStatus & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `complete failed (${res.status})`);
  return body;
}

export async function googleAuthStatus(): Promise<GoogleAuthStatus> {
  const res = await fetch("/api/auth/google/status");
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as GoogleAuthStatus;
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

// Upload a file into the conversation's container. Returns the in-container path
// the agent can read (the bytes never travel over the model channel).
export async function uploadAttachment(conversationId: string, file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`/api/conversations/${conversationId}/attachments`, { method: "POST", body });
  if (!res.ok) throw new Error(await res.text());
  const { path } = (await res.json()) as { path: string };
  return path;
}
