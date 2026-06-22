import { createContext } from "react";

// The active conversation id, provided around the chat thread so the markdown
// renderer can turn links to in-container files (/work/...) into downloads
// scoped to the right container.
export const ConversationFileContext = createContext<string | null>(null);
