/**
 * hakanai model provider: an OpenAI-compatible endpoint configured entirely
 * from environment variables, so the same image works against any such server.
 *
 *   HAKANAI_MODEL_BASE_URL   e.g. https://inference.example/v1
 *   HAKANAI_MODEL_API_KEY    bearer token
 *
 * The control plane injects these per container (the agent bakes no creds).
 * Models are discovered from /v1/models at startup. pi runs under bun, so its
 * fetch honors HTTPS_PROXY -- the only route out of the egress-locked container.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = process.env.HAKANAI_MODEL_BASE_URL?.replace(/\/+$/, "");
const API_KEY = process.env.HAKANAI_MODEL_API_KEY;

export default async function (pi: ExtensionAPI) {
  if (!BASE_URL || !API_KEY) return; // unconfigured; register nothing

  let modelIds: string[] = [];
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (res.ok) {
      const payload = (await res.json()) as { data?: Array<{ id: string }> };
      modelIds = payload.data?.map((m) => m.id) ?? [];
    }
  } catch {
    return; // endpoint unreachable at startup
  }
  if (modelIds.length === 0) return;
  const ours = new Set(modelIds);

  pi.registerProvider("hakanai", {
    name: "hakanai model",
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    api: "openai-completions",
    models: modelIds.map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 16384,
      compat: { thinkingFormat: "qwen-chat-template" },
    })),
  });

  // Qwen3 emits tool calls in the wrong grammar when the system prompt carries
  // an <available_skills> XML block; rewrite it to markdown. Scoped to this
  // provider's models, a no-op otherwise. (See the mgabor-inference extension
  // in the author's dotfiles for the full why.)
  pi.on("before_provider_request", (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.model !== "string" || !ours.has(payload.model)) return undefined;
    const messages = payload.messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const sys = messages[0] as { role?: string; content?: unknown };
    if (sys.role !== "developer" && sys.role !== "system") return undefined;

    let text: string;
    let isArrayContent: boolean;
    if (typeof sys.content === "string") {
      text = sys.content;
      isArrayContent = false;
    } else if (Array.isArray(sys.content)) {
      text = sys.content.map((p: { text?: string }) => (p && typeof p.text === "string" ? p.text : "")).join("");
      isArrayContent = true;
    } else {
      return undefined;
    }

    const rewritten = rewriteAvailableSkills(text);
    if (rewritten === text) return undefined;
    const newSys = { ...sys, content: isArrayContent ? [{ type: "text", text: rewritten }] : rewritten };
    return { ...payload, messages: [newSys, ...messages.slice(1)] };
  });
}

function rewriteAvailableSkills(text: string): string {
  const blockRe = /<available_skills>([\s\S]*?)<\/available_skills>/;
  const block = blockRe.exec(text);
  if (!block) return text;

  const skillRe =
    /<skill>\s*<name>([^<]+)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([^<]+)<\/location>\s*<\/skill>/g;
  const skills: Array<{ name: string; description: string; location: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = skillRe.exec(block[1])) !== null) {
    skills.push({ name: m[1].trim(), description: m[2].trim(), location: m[3].trim() });
  }
  if (skills.length === 0) return text;

  const md =
    "Available skills (load via `read` when a task matches):\n" +
    skills.map((s) => `- **${s.name}**: ${s.description} (location: \`${s.location}\`)`).join("\n");
  return text.replace(blockRe, md);
}
