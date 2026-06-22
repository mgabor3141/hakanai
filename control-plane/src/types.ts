export type Conversation = { id: string; lastActivity: number };
export type Role = "user" | "assistant" | "system";
export type Message = { id: string; role: Role; text: string; pending?: boolean };
export type ConnectionState = "idle" | "connecting" | "ready" | "thinking" | "error";
