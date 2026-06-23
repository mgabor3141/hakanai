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

export async function getConfig(): Promise<{ maxActive: number }> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as { maxActive: number };
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
