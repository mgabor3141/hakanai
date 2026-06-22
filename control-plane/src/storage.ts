import type { Message } from "./types";

const messageKey = (id: string) => `hakanai.messages.${id}`;

export function loadMessages(id: string): Message[] {
  try {
    return JSON.parse(localStorage.getItem(messageKey(id)) ?? "[]") as Message[];
  } catch {
    return [];
  }
}

export function saveMessages(id: string, messages: Message[]) {
  localStorage.setItem(messageKey(id), JSON.stringify(messages));
}

export function forgetMessages(id: string) {
  localStorage.removeItem(messageKey(id));
}
