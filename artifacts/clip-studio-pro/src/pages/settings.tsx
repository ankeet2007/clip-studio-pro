import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, CheckCircle2, Loader2, Youtube, LogOut, ExternalLink, RefreshCw, AtSign, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

import { API_BASE } from "@/lib/api";

interface AuthStatus {
  connected: boolean;
  status: "idle" | "pending" | "done" | "error";
  userCode: string;
  verificationUrl: string;
}

async function fetchStatus(): Promise<AuthStatus> {
  const res = await fetch(`${API_BASE}/api/auth/youtube/status`);
  return res.json() as Promise<AuthStatus>;
}

export default function Settings() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [channelHandle, setChannelHandle] = useState("");
  const [channelHandleDraft, setChannelHandleDraft] = useState("");
  const [savingHandle, setSavingHandle] = useState(false);

  // Keep code display in local state — never wiped by transient server errors
  const [displayedCode, setDisplayedCode] = useState("");
  const [displayedUrl, setDisplayedUrl] = useState("");
  const [codeExpired, setCodeExpired] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetchStatus();
        if (s.connected || s.status === "done") {
          setConnected(true);
          setDisplayedCode("");
          setDisplayedUrl("");
          stopPolling();
          toast({ title: "YouTube connected!", description: "High-quality livestream downloads are now unlocked." });
        } else if (s.status === "error" && !s.userCode) {
          // Truly expired or fatal — show retry
          setCodeExpired(true);
          stopPolling();
        }
        // Any other status (pending, transient errors) — keep polling, keep showing code
      } catch {
        // Network error — keep polling silently
      }
    }, 3000);
  }

  useEffect(() => {
    // Load YouTube auth status
    fetchStatus().then((s) => {
      setConnected(s.connected || s.status === "done");
      if (s.status === "pending" && s.userCode) {
        setDisplayedCode(s.userCode);
        setDisplayedUrl(s.verificationUrl);
        startPolling();
      }
    }).catch(() => {}).finally(() => setLoading(false));

    // Load channel handle from settings
    fetch(`${API_BASE}/api/settings`)
      .then((r) => r.json() as Promise<{ channelHandle: string }>)
      .then((data) => {
        setChannelHandle(data.channelHandle ?? "");
        setChannelHandleDraft(data.channelHandle ?? "");
      })
      .catch(() => {});

    return () => stopPolling();
  }, []);

  async function handleSaveHandle() {
    setSavingHandle(true);
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelHandle: channelHandleDraft }),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json() as { channelHandle: string };
      setChannelHandle(data.channelHandle);
      setChannelHandleDraft(data.channelHandle);
      toast({ title: "Channel handle saved" });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSavingHandle(false);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setCodeExpired(false);
    try {
      const res = await fetch(`${API_BASE}/api/auth/youtube/start`, { method: "POST" });
      const data = await res.json() as AuthStatus;

      if (data.connected || data.status === "done") {
        setConnected(true);
        return;
      }

      if (data.userCode) {
        setDisplayedCode(data.userCode);
        setDisplayedUrl(data.verificationUrl);
        startPolling();
      } else {
        toast({ title: "Error", description: "Could not get a code from Google. Try again.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Failed to start auth flow. Try again.", variant: "destructive" });
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    stopPolling();
    try {
      const res = await fetch(`${API_BASE}/api/auth/youtube`, { method: "DELETE" });
      if (!res.ok) throw new Error("Disconnect failed");
      setConnected(false);
      setDisplayedCode("");
      setDisplayedUrl("");
      setCodeExpired(false);
      toast({ title: "Disconnected", description: "YouTube account unlinked." });
    } catch {
      toast({ title: "Failed to disconnect", description: "Try again.", variant: "destructive" });
    }
  }

  function handleRetry() {
    setDisplayedCode("");
    setDisplayedUrl("");
    setCodeExpired(false);
    handleConnect();
  }

  const showCode = !!displayedCode && !connected;

  return (
    <div className="h-full flex flex-col bg-background text-foreground font-mono">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-card">
        <button
          onClick={() => navigate("/")}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Back to home"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span className="text-sm font-bold tracking-widest">SETTINGS</span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-8 max-w-lg mx-auto w-full space-y-8">
        {/* Channel Branding */}
        <div>
          <p className="text-xs tracking-widest text-muted-foreground uppercase mb-4">Channel Branding</p>
          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <AtSign className="w-5 h-5 text-primary" />
              <span className="font-bold text-sm tracking-wide">Channel Handle</span>
              {channelHandle === channelHandleDraft && channelHandle && (
                <span className="ml-auto flex items-center gap-1 text-xs text-green-400 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> SAVED
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Burned into the bottom of every <span className="text-foreground font-semibold">Edited</span> clip automatically. Leave blank to omit.
            </p>
            <div className="flex gap-2">
              <Input
                value={channelHandleDraft}
                onChange={(e) => setChannelHandleDraft(e.target.value)}
                placeholder="@your_channel"
                className="font-mono text-sm bg-background flex-1"
              />
              <Button
                size="sm"
                onClick={handleSaveHandle}
                disabled={savingHandle || channelHandleDraft === channelHandle}
                className="bg-primary text-primary-foreground font-mono text-xs tracking-wide shrink-0"
              >
                {savingHandle ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <><Save className="w-3.5 h-3.5 mr-1.5" /> Save</>
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* YouTube Account */}
        <div>
          <p className="text-xs tracking-widest text-muted-foreground uppercase mb-4">YouTube Account</p>

          <div className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center gap-3 mb-3">
              <Youtube className="w-5 h-5 text-red-500" />
              <span className="font-bold text-sm tracking-wide">YouTube Connection</span>
              {connected && (
                <span className="ml-auto flex items-center gap-1 text-xs text-green-400 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> CONNECTED
                </span>
              )}
            </div>

            <p className="text-xs text-muted-foreground mb-5 leading-relaxed">
              Connect your YouTube account to unlock max-quality downloads for livestreams and age-restricted videos.
              Without this, livestreams are capped at 360p.
            </p>

            {loading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking status…
              </div>
            ) : connected ? (
              <Button
                variant="outline"
                size="sm"
                className="text-muted-foreground hover:text-foreground text-xs"
                onClick={handleDisconnect}
              >
                <LogOut className="w-3.5 h-3.5 mr-1.5" /> Disconnect
              </Button>
            ) : showCode ? (
              <div className="space-y-4">
                <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-4">
                  <p className="text-xs text-muted-foreground mb-3">
                    Open this link on any device — phone, tablet, laptop — and enter the code:
                  </p>
                  <a
                    href={displayedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-yellow-400 text-xs font-semibold mb-4 hover:underline"
                  >
                    {displayedUrl}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">Code:</span>
                    <span className="text-2xl font-bold tracking-[0.3em] text-foreground select-all">
                      {displayedCode}
                    </span>
                  </div>
                </div>
                {codeExpired ? (
                  <div className="space-y-2">
                    <p className="text-xs text-destructive">Code expired — get a new one.</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-muted-foreground text-xs"
                      onClick={handleRetry}
                    >
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Get new code
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Waiting for you to enter the code…
                  </div>
                )}
              </div>
            ) : (
              <Button
                size="sm"
                className="bg-yellow-400 text-black hover:bg-yellow-300 font-bold text-xs tracking-wide"
                onClick={handleConnect}
                disabled={connecting}
              >
                {connecting ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Starting…</>
                ) : (
                  <><Youtube className="w-3.5 h-3.5 mr-1.5" /> Connect YouTube Account</>
                )}
              </Button>
            )}
          </div>

          {!connected && !showCode && (
            <div className="rounded-lg border border-border bg-card p-5 mt-4">
              <p className="text-xs tracking-widest text-muted-foreground uppercase mb-3">How it works</p>
              <ol className="space-y-2 text-xs text-muted-foreground list-decimal list-inside leading-relaxed">
                <li>Tap <span className="text-foreground font-semibold">Connect YouTube Account</span> above</li>
                <li>A code and link will appear</li>
                <li>Open the link on any device and enter the code</li>
                <li>Done — all your clips now download at max quality</li>
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
