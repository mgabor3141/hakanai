import type { Conversation } from "./types";

// What to show for a conversation. pi titles each session from its first user
// message (or an auto-generated name); we show the first line and let CSS clip
// it with an ellipsis. Falls back to a placeholder before the first message.
export function conversationTitle(conversation: Conversation): string {
  const firstLine = conversation.title?.split("\n")[0]?.trim();
  return firstLine || "New conversation";
}
