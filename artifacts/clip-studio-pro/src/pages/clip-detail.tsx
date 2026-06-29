import { useParams, useLocation } from "wouter";
import { useGetClip, getGetClipQueryKey, getListClipsQueryKey, getGetClipStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Clock,
  Loader2,
  CheckCircle,
  AlertTriangle,
  PlayCircle,
  Link,
  Sparkles,
  Copy,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { useEffect, useRef, useState } from "react";

import { API_BASE } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/utils";

interface ClipMetadata {
  title: string;
  description: string;
  hashtags: string;
  tags: string;
}

export default function ClipDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const clipId = Number(params.id);
  const validId = Number.isInteger(clipId) && clipId > 0;

  const { data: clip, isLoading, isError } = useGetClip(clipId, {
    query: {
      queryKey: getGetClipQueryKey(clipId),
      enabled: validId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "pending" || status === "processing" ? 3000 : false;
      },
    },
  });

  const prevStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = clip?.status;
    if (prev !== undefined && prev !== clip?.status && (clip?.status === "done" || clip?.status === "error")) {
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
    }
  }, [clip?.status, queryClient]);

  // SEO metadata — fetched once the clip is rendered (transcript is available then).
  const [meta, setMeta] = useState<ClipMetadata | null>(null);
  useEffect(() => {
    if (clip?.status !== "done") { setMeta(null); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/clips/${clipId}/metadata`)
      .then((r) => r.json() as Promise<ClipMetadata>)
      .then((d) => { if (!cancelled) setMeta(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [clip?.status, clipId]);

  async function copyMeta(text: string, label: string) {
    const ok = await copyTextToClipboard(text);
    toast(ok ? { title: `${label} copied` } : { title: "Copy failed", variant: "destructive" });
  }

  async function handleRetry() {
    try {
      const res = await fetch(`${API_BASE}/api/clips/${clipId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      queryClient.invalidateQueries({ queryKey: getGetClipQueryKey(clipId) });
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      toast({ title: "Clip re-queued" });
    } catch {
      toast({ title: "Failed to retry clip", variant: "destructive" });
    }
  }

  const getStatusBadge = () => {
    switch (clip?.status) {
      case "pending":
        return (
          <Badge variant="secondary" className="flex items-center gap-1.5 font-mono uppercase text-xs">
            <Clock className="w-3.5 h-3.5" /> Queued
          </Badge>
        );
      case "processing":
        return (
          <Badge className="bg-primary text-primary-foreground flex items-center gap-1.5 font-mono uppercase text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Processing
          </Badge>
        );
      case "done":
        return (
          <Badge className="bg-green-500/10 text-green-500 border border-green-500/20 flex items-center gap-1.5 font-mono uppercase text-xs">
            <CheckCircle className="w-3.5 h-3.5" /> Done
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive" className="flex items-center gap-1.5 font-mono uppercase text-xs">
            <AlertTriangle className="w-3.5 h-3.5" /> Error
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
      <AppHeader />

      <main className="flex-1 min-h-0 overflow-y-auto p-6 md:p-8 max-w-3xl mx-auto w-full">
        {/* Back button */}
        <button
          onClick={() => navigate("/timeline")}
          className="flex items-center gap-2 text-sm font-mono text-muted-foreground hover:text-foreground transition-colors mb-8 group"
        >
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
          Back to Timeline
        </button>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-64 bg-muted" />
            <Skeleton className="h-4 w-48 bg-muted" />
            <Skeleton className="h-32 w-full bg-muted rounded-lg" />
          </div>
        ) : !validId || isError || !clip ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="font-mono text-sm uppercase tracking-widest">Clip not found</p>
            <Button variant="ghost" className="mt-4" onClick={() => navigate("/")}>
              Go back
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Title row */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  {getStatusBadge()}
                  <span className="font-mono text-xs text-muted-foreground">#{clip.id}</span>
                </div>
                <h2 className="text-2xl font-bold tracking-tight truncate">{clip.headline || <span className="text-muted-foreground italic font-normal">Raw clip</span>}</h2>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                {clip.status === "done" && clip.outputFilename && (
                  <Button
                    className="font-mono text-xs bg-green-600 hover:bg-green-500 text-white"
                    asChild
                  >
                    <a href={`${API_BASE}/api/clips/${clip.id}/download`} download>
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </a>
                  </Button>
                )}
                {clip.status === "error" && (
                  <Button
                    variant="outline"
                    className="font-mono text-xs border-destructive/50 text-destructive hover:bg-destructive hover:text-white"
                    onClick={handleRetry}
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Retry
                  </Button>
                )}
              </div>
            </div>

            {/* Details card */}
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <Link className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    {clip.sourceType === "local" ? (
                      <>
                        <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Local File</p>
                        <p className="text-sm font-mono break-all">{clip.localFileName ?? "Uploaded file"}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Source URL</p>
                        <p className="text-sm font-mono break-all">{clip.youtubeUrl}</p>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <PlayCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Timestamps</p>
                    <p className="text-sm font-mono">{clip.startTime} &ndash; {clip.endTime}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <Clock className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Created</p>
                    <p className="text-sm font-mono">
                      {new Date(clip.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Processing indicator */}
            {(clip.status === "pending" || clip.status === "processing") && (
              <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-5 py-4">
                <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
                <div>
                  <p className="text-sm font-semibold">
                    {clip.status === "pending" ? "Waiting in queue…" : "Processing your clip…"}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    This page will update automatically
                  </p>
                </div>
              </div>
            )}

            {/* Error message */}
            {clip.status === "error" && clip.errorMessage && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
                <p className="text-xs font-mono text-destructive uppercase tracking-wider mb-2">Error Details</p>
                <p className="text-sm text-destructive/90 font-mono break-words">{clip.errorMessage}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 font-mono text-xs border-destructive/50 text-destructive hover:bg-destructive hover:text-white"
                  onClick={handleRetry}
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-2" />
                  Retry this clip
                </Button>
              </div>
            )}

            {/* YouTube SEO metadata — ready-to-paste title / description / tags */}
            {clip.status === "done" && meta && (
              <div className="rounded-lg border border-border bg-card p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.13em] text-muted-foreground">
                    <Sparkles className="w-4 h-4 text-primary" /> YouTube metadata
                  </p>
                  <button
                    onClick={() => copyMeta(`${meta.title}\n\n${meta.description}`, "All metadata")}
                    className="flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.08em] text-primary hover:underline"
                  >
                    <Copy className="w-3 h-3" /> Copy all
                  </button>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Title</span>
                    <button onClick={() => copyMeta(meta.title, "Title")} className="text-muted-foreground hover:text-foreground" aria-label="Copy title"><Copy className="w-3.5 h-3.5" /></button>
                  </div>
                  <p className="text-sm bg-background rounded-md border border-border px-3 py-2 break-words">{meta.title}</p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Description</span>
                    <button onClick={() => copyMeta(meta.description, "Description")} className="text-muted-foreground hover:text-foreground" aria-label="Copy description"><Copy className="w-3.5 h-3.5" /></button>
                  </div>
                  <pre className="text-xs bg-background rounded-md border border-border px-3 py-2 whitespace-pre-wrap break-words font-sans">{meta.description}</pre>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Tags</span>
                    <button onClick={() => copyMeta(meta.tags, "Tags")} className="text-muted-foreground hover:text-foreground" aria-label="Copy tags"><Copy className="w-3.5 h-3.5" /></button>
                  </div>
                  <p className="text-xs font-mono bg-background rounded-md border border-border px-3 py-2 break-words text-muted-foreground">{meta.tags}</p>
                </div>
              </div>
            )}

            {/* Done — ready */}
            {clip.status === "done" && (
              <div className="flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/5 px-5 py-4">
                <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-green-400">Clip is ready</p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                    {clip.outputFilename}
                  </p>
                </div>
                {clip.outputFilename && (
                  <Button
                    size="sm"
                    className="font-mono text-xs bg-green-600 hover:bg-green-500 text-white shrink-0"
                    asChild
                  >
                    <a href={`${API_BASE}/api/clips/${clip.id}/download`} download>
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </a>
                  </Button>
                )}
              </div>
            )}

          </div>
        )}
      </main>
    </div>
  );
}
