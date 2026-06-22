export type Conversation = { id: string; lastActivity: number; expiresAt: number; title: string | null };
export type ConnectionState = "idle" | "connecting" | "ready" | "thinking" | "error";
