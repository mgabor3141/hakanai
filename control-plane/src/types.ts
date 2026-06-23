export type Conversation = {
  id: string;
  lastActivity: number;
  expiresAt: number;
  title: string | null;
  // Budget state: whether the container is loaded (consuming RAM) and whether it
  // is mid-turn. A stopped conversation still exists and resumes when reopened.
  running: boolean;
  busy: boolean;
};
export type ConnectionState = "idle" | "connecting" | "ready" | "thinking" | "error";
