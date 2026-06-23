import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  completeGoogleAuth,
  discoverModels,
  getSettings,
  googleAuthStatus,
  saveSettings,
  startGoogleAuth,
  type GoogleAuthStatus,
  type PublicSettings,
} from "../api";

type Provider = "openai" | "vertex";

const input =
  "w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
const label = "block text-sm font-medium mb-1.5";

export function SettingsDialog({
  open,
  onOpenChange,
  vertexModels,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vertexModels: string[];
  onSaved: () => void;
}) {
  const [provider, setProvider] = useState<Provider>("openai");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // OpenAI form.
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false); // a token is already stored
  const [oaiModel, setOaiModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  // Vertex form.
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("us-central1");
  const [vertexModel, setVertexModel] = useState(vertexModels[0] ?? "gemini-2.5-pro");
  const [connected, setConnected] = useState(false);
  const [google, setGoogle] = useState<GoogleAuthStatus | null>(null);
  const [code, setCode] = useState("");
  const pollRef = useRef<number | null>(null);

  const prefill = useCallback((s: PublicSettings) => {
    if (s.provider === "openai") {
      setProvider("openai");
      setEndpoint(s.endpoint);
      setOaiModel(s.model);
      setModels(s.model ? [s.model] : []);
      setHasToken(s.hasToken);
      setToken("");
    } else if (s.provider === "vertex") {
      setProvider("vertex");
      setProject(s.project);
      setLocation(s.location);
      setVertexModel(s.model);
      setConnected(s.connected);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDiscoverError(null);
    setLoading(true);
    getSettings()
      .then(prefill)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, prefill]);

  async function onDiscover() {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const ids = await discoverModels(endpoint, token);
      setModels(ids);
      if (ids.length && !ids.includes(oaiModel)) setOaiModel(ids[0]);
      if (!ids.length) setDiscoverError("the endpoint returned no models");
    } catch (e) {
      setDiscoverError(String(e instanceof Error ? e.message : e));
    } finally {
      setDiscovering(false);
    }
  }

  async function onConnectGoogle() {
    setGoogle({ phase: "pending", url: null, error: null });
    try {
      const url = await startGoogleAuth();
      setGoogle({ phase: "pending", url, error: null });
    } catch (e) {
      setGoogle({ phase: "error", url: null, error: String(e instanceof Error ? e.message : e) });
    }
  }

  async function onSubmitCode() {
    try {
      const st = await completeGoogleAuth(code);
      setGoogle(st);
      if (st.phase === "connected") setConnected(true);
      // While the exchange runs server-side, poll status so a slow exchange
      // still resolves the UI.
      if (st.phase === "pending" && !pollRef.current) {
        pollRef.current = window.setInterval(async () => {
          const s = await googleAuthStatus().catch(() => null);
          if (s) {
            setGoogle(s);
            if (s.phase === "connected") setConnected(true);
            if (s.phase !== "pending" && pollRef.current) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
            }
          }
        }, 1500);
      }
    } catch (e) {
      setGoogle({ phase: "error", url: google?.url ?? null, error: String(e instanceof Error ? e.message : e) });
    }
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      if (provider === "openai") {
        await saveSettings({ provider: "openai", endpoint: endpoint.trim(), token: token.trim(), model: oaiModel.trim() });
      } else {
        await saveSettings({ provider: "vertex", project: project.trim(), location: location.trim(), model: vertexModel });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  }

  const canSaveOpenAI = endpoint.trim() && oaiModel.trim() && (token.trim() || hasToken);
  const canSaveVertex = project.trim() && location.trim() && vertexModel;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Model settings</DialogTitle>
          <DialogDescription>
            Choose one model provider for the whole appliance. Saving stops running chats; reopening one re-spawns it under the new
            config.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid place-items-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Provider toggle */}
            <div className="inline-flex rounded-lg border p-0.5">
              {(["openai", "vertex"] as const).map((pv) => (
                <button
                  key={pv}
                  onClick={() => setProvider(pv)}
                  className={cn(
                    "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
                    provider === pv ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {pv === "openai" ? "OpenAI-compatible" : "Google Vertex"}
                </button>
              ))}
            </div>

            {provider === "openai" ? (
              <div className="space-y-4">
                <div>
                  <label className={label}>Endpoint URL</label>
                  <input className={input} placeholder="https://host/v1" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
                </div>
                <div>
                  <label className={label}>Token {hasToken && <span className="text-xs text-muted-foreground">(set — leave blank to keep)</span>}</label>
                  <input
                    className={input}
                    type="password"
                    placeholder={hasToken ? "•••••••• (unchanged)" : "sk-..."}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </div>
                <div>
                  <Button variant="outline" size="sm" onClick={() => void onDiscover()} disabled={!endpoint.trim() || discovering}>
                    {discovering && <Loader2 className="size-4 animate-spin" />}
                    Fetch models
                  </Button>
                  {discoverError && <p className="mt-2 text-xs text-destructive">{discoverError}</p>}
                </div>
                {models.length > 0 && (
                  <div>
                    <label className={label}>Model</label>
                    <select className={input} value={oaiModel} onChange={(e) => setOaiModel(e.target.value)}>
                      {models.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className={label}>Project</label>
                  <input className={input} placeholder="my-gcp-project" value={project} onChange={(e) => setProject(e.target.value)} />
                </div>
                <div>
                  <label className={label}>Location</label>
                  <input className={input} placeholder="us-central1" value={location} onChange={(e) => setLocation(e.target.value)} />
                </div>
                <div>
                  <label className={label}>Model</label>
                  <select className={input} value={vertexModel} onChange={(e) => setVertexModel(e.target.value)}>
                    {vertexModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      Google account {connected ? <span className="text-green-600">— connected</span> : <span className="text-muted-foreground">— not connected</span>}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => void onConnectGoogle()} disabled={google?.phase === "pending" && !google.url}>
                      {connected ? "Reconnect" : "Connect Google"}
                    </Button>
                  </div>
                  {google?.phase === "pending" && google.url && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Open this link, sign in, then paste the verification code below:
                      </p>
                      <a href={google.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-primary underline">
                        {google.url}
                      </a>
                      <div className="flex gap-2">
                        <input className={input} placeholder="verification code" value={code} onChange={(e) => setCode(e.target.value)} />
                        <Button size="sm" onClick={() => void onSubmitCode()} disabled={!code.trim()}>
                          Submit
                        </Button>
                      </div>
                    </div>
                  )}
                  {google?.phase === "error" && <p className="mt-2 text-xs text-destructive">{google.error}</p>}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void onSave()} disabled={saving || (provider === "openai" ? !canSaveOpenAI : !canSaveVertex)}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
