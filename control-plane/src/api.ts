import type { Conversation } from "./types";

export async function listConversations(): Promise<Conversation[]> {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error(await res.text());
  const conversations = (await res.json()) as Conversation[];
  return conversations.sort((a, b) => b.lastActivity - a.lastActivity);
}

export async function createConversation(): Promise<string> {
  const res = await fetch("/api/conversations", { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  const { id } = (await res.json()) as { id: string };
  return id;
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
