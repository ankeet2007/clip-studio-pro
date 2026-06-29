import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { API_BASE } from "@/lib/api";
import {
  useListClips,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AppHeader } from "@/components/app-header";
import {
  Loader2,
  Zap,
  Plus,
  X,
  Youtube,
  Upload,
  FileVideo,
  MonitorPlay,
  Mic,
  ClipboardCopy,
  Check,
  Eye,
  Play,
  SendHorizonal,
} from "lucide-react";

const MAX_CLIPS = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;

const clipEntrySchema = z.object({
  mode: z.enum(["edited", "raw"]).default("edited"),
  startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  headline: z.string().optional().default(""),
  captionsEnabled: z.boolean().default(true),
  outroEnabled: z.boolean().default(true),
  voiceoverEnabled: z.boolean().default(false),
  voiceoverHook: z.string().optional().default(""),
}).superRefine((val, ctx) => {
  if (val.mode === "edited" && (!val.headline || val.headline.trim().length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Headline required for Edited mode", path: ["headline"] });
  }
  const toSecs = (t: string) => t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
  if (toSecs(val.endTime) <= toSecs(val.startTime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "End time must be after start time", path: ["endTime"] });
  }
});

const formSchema = z.object({
  youtubeUrl: z
    .string()
    .url("Must be a valid URL")
    .regex(/(?:youtube\.com|youtu\.be)/, "Must be a YouTube URL"),
  frameStyle: z.enum(["standard", "immersive"]).default("immersive"),
  sourceChannel: z.string().optional().default(""),
  clips: z.array(clipEntrySchema).min(1),
});

type FormValues = z.infer<typeof formSchema>;

const defaultClip = {
  mode: "edited" as const,
  startTime: "00:00:00",
  endTime: "00:00:15",
  headline: "",
  captionsEnabled: true,
  outroEnabled: true,
  voiceoverEnabled: false,
  voiceoverHook: "",
};

type SourceTab = "youtube" | "local";

interface LocalForm {
  startTime: string;
  endTime: string;
  headline: string;
  mode: "edited" | "raw";
  sourceChannel: string;
  captionsEnabled: boolean;
}

function secsToHMS(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

function toSecs(t: string): number {
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) return 0;
  return t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
}

function fmtDuration(start: string, end: string): string {
  const d = Math.max(0, toSecs(end) - toSecs(start));
  const m = Math.floor(d / 60);
  const s = d % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Copies text to the clipboard, working over plain HTTP too. The modern
 * navigator.clipboard API only exists in a secure context (HTTPS or localhost);
 * this app is served over http on a LAN IP, so we fall back to the legacy
 * execCommand("copy") approach via a hidden textarea.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ---------- small reusable bits ---------- */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Label className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground mb-1.5 block">
      {children}
    </Label>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string; icon?: React.ReactNode }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex bg-background border border-border rounded-lg p-[3px] gap-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 rounded-md px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleChip({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.08em] transition-colors ${
        checked
          ? "text-primary border-primary/40 bg-primary/[0.07]"
          : "text-muted-foreground border-border bg-card hover:text-foreground"
      }`}
    >
      <span
        className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${
          checked ? "bg-primary border-primary" : "border-muted-foreground/50"
        }`}
      >
        {checked && <Check className="w-2.5 h-2.5 text-primary-foreground" strokeWidth={3.5} />}
      </span>
      {label}
    </button>
  );
}

/* ---------- live 9:16 preview ---------- */

function LivePreview({
  headline,
  mode,
  frameStyle,
  captions,
  voiceover,
  hook,
  handle,
}: {
  headline: string;
  mode: "edited" | "raw";
  frameStyle: "standard" | "immersive";
  captions: boolean;
  voiceover: boolean;
  hook: string;
  handle: string;
}) {
  const showHeadline = mode === "edited" && headline.trim().length > 0;
  const watermark = (handle || "@yourchannel").toUpperCase();
  // crude "karaoke" split for the caption mock
  const hookWords = (hook || "your spoken hook").trim().split(/\s+/).slice(0, 4);

  return (
    <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-4">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground flex items-center gap-2">
          <Eye className="w-3.5 h-3.5 text-primary" /> Live preview
        </span>
        <span className="font-mono text-[9px] text-muted-foreground/50">9:16</span>
      </div>

      <div className="w-[200px] mx-auto aspect-[9/16] rounded-[22px] border border-border bg-black overflow-hidden relative shadow-[0_30px_60px_-30px_#000]">
        {/* 40px top drop to clear YouTube UI */}
        <div className="h-[7%] bg-black" />
        {/* video area */}
        <div className="absolute inset-x-0 top-[7%] bottom-0 grid place-items-center bg-gradient-to-br from-[#2a2140] via-[#101a2e] to-[#0a1420]">
          <div className="w-11 h-11 rounded-full grid place-items-center bg-white/10 backdrop-blur-sm border border-white/20">
            <Play className="w-4 h-4 text-white fill-white ml-0.5" />
          </div>
        </div>

        {voiceover && (
          <div className="absolute left-2 top-[calc(7%+8px)] flex items-center gap-1 rounded-md bg-[#9b7bff]/85 px-1.5 py-0.5 text-[7.5px] font-mono tracking-wide text-white">
            <Mic className="w-2.5 h-2.5" /> HOOK
          </div>
        )}

        {showHeadline && (
          <div className="absolute inset-x-0 top-[11%] px-3 text-center">
            <span className="font-extrabold text-[13px] leading-tight text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)]">
              {headline}
            </span>
          </div>
        )}

        {mode === "edited" && (
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center font-extrabold tracking-wide text-[15px] text-white/85 drop-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">
            {watermark}
          </div>
        )}

        {captions && (
          <div className="absolute inset-x-0 bottom-[13%] px-3 text-center leading-snug">
            <span className="font-extrabold text-[13px] text-black bg-primary px-1.5 py-0.5 rounded-[5px] shadow">
              {hookWords[0] ?? "your"}
            </span>{" "}
            <span className="font-extrabold text-[13px] text-white drop-shadow-[0_2px_6px_#000]">
              {hookWords.slice(1).join(" ") || "captions"}
            </span>
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {[
          ["Frame", frameStyle === "immersive" ? "Immersive" : "Standard", "text-foreground"],
          ["Captions", captions ? "Karaoke ON" : "Off", captions ? "text-primary" : "text-muted-foreground"],
          ["Voiceover", voiceover ? "Hook ON" : "Off", voiceover ? "text-[#b69dff]" : "text-muted-foreground"],
        ].map(([k, v, cls]) => (
          <div key={k} className="flex items-center justify-between font-mono text-[10.5px]">
            <span className="text-muted-foreground">{k}</span>
            <span className={cls as string}>{v}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground/60 leading-relaxed text-center">
        Reflects your settings live — what you see is the Short that renders.
      </p>
    </div>
  );
}

export default function Home() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sourceTab, setSourceTab] = useState<SourceTab>("youtube");

  // YouTube preview player
  const [showPlayer, setShowPlayer] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const playerRef = useRef<any>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);

  // Local file upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [localForm, setLocalForm] = useState<LocalForm>({
    startTime: "00:00:00",
    endTime: "00:01:00",
    headline: "",
    mode: "edited",
    sourceChannel: "",
    captionsEnabled: true,
  });
  const [localErrors, setLocalErrors] = useState<Partial<Record<keyof LocalForm | "file", string>>>({});

  // channel handle for the live preview watermark
  const [channelHandle, setChannelHandle] = useState("");
  useEffect(() => {
    fetch(`${API_BASE}/api/settings`)
      .then((r) => r.json() as Promise<{ channelHandle?: string }>)
      .then((d) => setChannelHandle(d.channelHandle ?? ""))
      .catch(() => {});
  }, []);

  // warm the clips list cache for the timeline
  useListClips({ query: { queryKey: getListClipsQueryKey() } });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      youtubeUrl: "",
      frameStyle: "immersive",
      clips: [{ ...defaultClip }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "clips",
  });

  const [, navigate] = useLocation();
  const isSubmitting = form.formState.isSubmitting;

  const youtubeUrl = form.watch("youtubeUrl");
  const videoId = useMemo(() => {
    if (!youtubeUrl) return null;
    const m = youtubeUrl.match(
      /(?:youtu\.be\/|youtube\.com\/(?:shorts\/|live\/|embed\/|v\/|watch\?v=))([^&?/]+)/
    );
    return m?.[1] ?? null;
  }, [youtubeUrl]);

  const prevVideoIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (videoId !== prevVideoIdRef.current) {
      prevVideoIdRef.current = videoId;
      if (!videoId) setShowPlayer(false);
    }
  }, [videoId]);

  useEffect(() => {
    if (!showPlayer || !videoId) return;

    const mountPlayer = () => {
      if (!playerDivRef.current) return;
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      setPlayerReady(false);
      playerRef.current = new (window as any).YT.Player(playerDivRef.current, {
        videoId,
        playerVars: { controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
        events: { onReady: () => setPlayerReady(true) },
      });
    };

    if ((window as any).YT?.Player) {
      mountPlayer();
    } else {
      const prev = (window as any).onYouTubeIframeAPIReady;
      (window as any).onYouTubeIframeAPIReady = () => {
        mountPlayer();
        if (typeof prev === "function") prev();
      };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(s);
      }
    }

    return () => {
      if (playerRef.current) {
        try { playerRef.current.destroy(); } catch { /* ignore */ }
        playerRef.current = null;
      }
      setPlayerReady(false);
    };
  }, [showPlayer, videoId]);

  const handleSetIn = (clipIndex: number) => {
    const t: number = playerRef.current?.getCurrentTime?.() ?? 0;
    form.setValue(`clips.${clipIndex}.startTime`, secsToHMS(t));
  };

  const handleSetOut = (clipIndex: number) => {
    const t: number = playerRef.current?.getCurrentTime?.() ?? 0;
    form.setValue(`clips.${clipIndex}.endTime`, secsToHMS(t));
  };

  // Builds a ready-made prompt for the user's own Gemini app and copies it to the
  // clipboard. The server never calls any AI — the user pastes this into Gemini,
  // then pastes the returned hook line back into the voiceover text box.
  async function copyHookPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const dur = Math.max(0, toSecs(clip.endTime) - toSecs(clip.startTime));
    const prompt =
      `You are a viral short-form video editor. Write ONE punchy spoken intro hook ` +
      `(6-10 words) to be read aloud over the first few seconds of a YouTube Short, ` +
      `to stop the scroll. Return ONLY the hook line — no quotes, no extra text.\n\n` +
      `Context:\n` +
      `- Headline/title: ${clip.headline || "(none)"}\n` +
      `- Source channel: ${values.sourceChannel || "(unknown)"}\n` +
      `- Clip length: ~${dur}s\n` +
      `- Source video: ${values.youtubeUrl || "(n/a)"}`;
    const ok = await copyTextToClipboard(prompt);
    if (ok) {
      toast({ title: "Prompt copied", description: "Paste it into your Gemini app, then paste the hook back here." });
    } else {
      toast({ title: "Copy failed", description: "Couldn't access the clipboard. Long-press the box to copy manually.", variant: "destructive" });
    }
  }

  async function onSubmit(values: FormValues) {
    let successCount = 0;
    const failReasons: string[] = [];

    for (const clip of values.clips) {
      try {
        const r = await fetch(`${API_BASE}/api/clips`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            youtubeUrl: values.youtubeUrl,
            frameStyle: values.frameStyle,
            startTime: clip.startTime,
            endTime: clip.endTime,
            headline: clip.headline ?? "",
            mode: clip.mode,
            sourceChannel: values.sourceChannel ?? "",
            captionsEnabled: clip.captionsEnabled ?? true,
            outroEnabled: clip.outroEnabled ?? true,
            voiceoverEnabled: clip.voiceoverEnabled ?? false,
            voiceoverHook: clip.voiceoverHook ?? "",
          }),
        });
        if (!r.ok) {
          let reason = "Failed";
          try { reason = ((await r.json()) as { error?: string }).error ?? reason; } catch { /* ignore */ }
          failReasons.push(reason);
        } else {
          successCount++;
        }
      } catch {
        failReasons.push("Network error");
      }
    }

    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });

    if (successCount > 0) {
      toast({
        title: successCount === 1 ? "1 clip job enqueued" : `${successCount} clip jobs enqueued`,
        description: failReasons.length > 0 ? `${failReasons.length} failed: ${failReasons[0]}` : undefined,
      });
      form.reset({
        youtubeUrl: values.youtubeUrl,
        frameStyle: values.frameStyle,
        sourceChannel: values.sourceChannel,
        clips: [{ ...defaultClip }],
      });
    } else {
      toast({ title: "All submissions failed", description: failReasons[0], variant: "destructive" });
    }
  }

  const validateLocalForm = useCallback((): boolean => {
    const errors: typeof localErrors = {};
    if (!selectedFile) errors.file = "Please select a video file";
    const startValid = !!localForm.startTime.match(/^\d{2}:\d{2}:\d{2}$/);
    const endValid = !!localForm.endTime.match(/^\d{2}:\d{2}:\d{2}$/);
    if (!startValid) errors.startTime = "Must be HH:MM:SS";
    if (!endValid) errors.endTime = "Must be HH:MM:SS";
    if (startValid && endValid) {
      if (toSecs(localForm.endTime) <= toSecs(localForm.startTime))
        errors.endTime = "End time must be after start time";
    }
    if (localForm.mode === "edited" && !localForm.headline.trim())
      errors.headline = "Headline required for Edited mode";
    setLocalErrors(errors);
    return Object.keys(errors).length === 0;
  }, [selectedFile, localForm]);

  const handleLocalUpload = useCallback(async () => {
    if (!validateLocalForm() || !selectedFile) return;
    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("startTime", localForm.startTime);
    formData.append("endTime", localForm.endTime);
    formData.append("headline", localForm.headline);
    formData.append("mode", localForm.mode);
    formData.append("frameStyle", form.getValues("frameStyle"));
    formData.append("sourceChannel", localForm.sourceChannel ?? "");
    formData.append("captionsEnabled", String(localForm.captionsEnabled));

    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        setIsUploading(false);
        setUploadProgress(null);
        if (xhr.status === 201) {
          toast({ title: "File uploaded — processing started" });
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setLocalForm({ startTime: "00:00:00", endTime: "00:01:00", headline: "", mode: "edited", sourceChannel: "", captionsEnabled: true });
          setLocalErrors({});
          queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
        } else {
          let msg = "Upload failed";
          try { msg = (JSON.parse(xhr.responseText) as { error: string }).error || msg; } catch { /* ignore */ }
          toast({ title: msg, variant: "destructive" });
        }
        resolve();
      };
      xhr.onerror = () => {
        setIsUploading(false);
        setUploadProgress(null);
        toast({ title: "Network error — upload failed", variant: "destructive" });
        resolve();
      };
      xhr.open("POST", `${API_BASE}/api/clips/upload`);
      xhr.send(formData);
    });
  }, [selectedFile, localForm, validateLocalForm, queryClient, toast, form]);

  const clipCount = fields.length;

  // ----- values driving the live preview -----
  const wFrame = form.watch("frameStyle");
  const wClip0 = form.watch("clips.0");
  const preview =
    sourceTab === "youtube"
      ? {
          headline: wClip0?.headline ?? "",
          mode: (wClip0?.mode ?? "edited") as "edited" | "raw",
          captions: wClip0?.captionsEnabled ?? true,
          voiceover: wClip0?.voiceoverEnabled ?? false,
          hook: wClip0?.voiceoverHook ?? "",
        }
      : {
          headline: localForm.headline,
          mode: localForm.mode,
          captions: localForm.captionsEnabled,
          voiceover: false,
          hook: "",
        };

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
      <AppHeader />

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 md:px-8 py-6 md:py-8">
          {/* Page heading */}
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-3">
            <Zap className="w-4 h-4 text-primary" /> New job definition
          </p>
          <h2 className="text-2xl font-extrabold tracking-tight">Create a Short</h2>
          <p className="text-sm text-muted-foreground mt-1 mb-6">
            Pick a source, mark your in/out points, and dispatch render jobs to the phone.
          </p>

          <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
            {/* LEFT — form */}
            <div className="min-w-0">
              {/* source + frame toolbar */}
              <div className="flex flex-wrap gap-3 mb-5">
                <Segmented
                  value={sourceTab}
                  onChange={(v) => { setSourceTab(v as SourceTab); setLocalErrors({}); }}
                  options={[
                    { value: "youtube", label: "YouTube", icon: <Youtube className="w-3.5 h-3.5" /> },
                    { value: "local", label: "Local file", icon: <Upload className="w-3.5 h-3.5" /> },
                  ]}
                />
                <Segmented
                  value={wFrame}
                  onChange={(v) => form.setValue("frameStyle", v as "standard" | "immersive")}
                  options={[
                    { value: "immersive", label: "Immersive" },
                    { value: "standard", label: "Standard" },
                  ]}
                />
              </div>

              {sourceTab === "youtube" && (
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                  {/* URL + source creator card */}
                  <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-4">
                    <div>
                      <FieldLabel>Source URL</FieldLabel>
                      <div className="flex gap-2">
                        <Input
                          placeholder="https://youtube.com/watch?v=..."
                          className="font-mono text-sm bg-background flex-1 min-w-0"
                          {...form.register("youtubeUrl")}
                        />
                        {videoId && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => setShowPlayer((p) => !p)}
                            className={`font-mono text-xs tracking-wider border transition-colors shrink-0 ${
                              showPlayer
                                ? "border-primary/40 bg-primary/15 text-primary"
                                : "border-border bg-card text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            <MonitorPlay className="w-4 h-4" />
                            <span className="hidden sm:inline ml-2">{showPlayer ? "HIDE" : "PREVIEW"}</span>
                          </Button>
                        )}
                      </div>
                      {form.formState.errors.youtubeUrl && (
                        <p className="text-xs text-destructive font-mono mt-1.5">{form.formState.errors.youtubeUrl.message}</p>
                      )}
                    </div>

                    {showPlayer && videoId && (
                      <div className="rounded-lg border border-border overflow-hidden bg-black">
                        <div className="aspect-video w-full relative">
                          <div ref={playerDivRef} className="w-full h-full" />
                          {!playerReady && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black">
                              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                            </div>
                          )}
                        </div>
                        {playerReady && (
                          <div className="border-t border-border bg-card px-3 py-2 flex flex-wrap gap-2">
                            {fields.map((_, i) => (
                              <div key={i} className="flex items-center gap-1.5">
                                {clipCount > 1 && (
                                  <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-wider">
                                    {String(i + 1).padStart(2, "0")}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleSetIn(i)}
                                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border border-border bg-background hover:bg-muted rounded transition-colors"
                                >
                                  Set In
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleSetOut(i)}
                                  className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border border-border bg-background hover:bg-muted rounded transition-colors"
                                >
                                  Set Out
                                </button>
                              </div>
                            ))}
                            <span className="text-[10px] font-mono text-muted-foreground/40 self-center ml-auto">
                              pause first, then set
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <FieldLabel>Source creator <span className="text-muted-foreground/40 normal-case">(optional)</span></FieldLabel>
                      <Input
                        placeholder="e.g. KSI, MrBeast, IShowSpeed"
                        className="font-mono text-sm bg-background"
                        {...form.register("sourceChannel")}
                      />
                    </div>
                  </div>

                  {/* clip entries */}
                  <div className="space-y-3">
                    {fields.map((field, index) => {
                      const currentMode = form.watch(`clips.${index}.mode`);
                      const isRaw = currentMode === "raw";
                      const start = form.watch(`clips.${index}.startTime`);
                      const end = form.watch(`clips.${index}.endTime`);
                      const voOn = form.watch(`clips.${index}.voiceoverEnabled`) ?? false;

                      return (
                        <div key={field.id} className="rounded-xl border border-border bg-background/40 overflow-hidden">
                          {/* clip header */}
                          <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                            <span className="font-mono text-[11px] text-primary bg-primary/[0.08] border border-primary/20 w-7 h-7 rounded-md grid place-items-center font-semibold tabular-nums">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <Segmented
                              value={currentMode}
                              onChange={(v) => form.setValue(`clips.${index}.mode`, v as "edited" | "raw")}
                              options={[
                                { value: "edited", label: "Edited" },
                                { value: "raw", label: "Raw" },
                              ]}
                            />
                            {clipCount > 1 && (
                              <button
                                type="button"
                                onClick={() => remove(index)}
                                className="ml-auto w-7 h-7 grid place-items-center rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/10 transition-colors"
                                aria-label="Remove clip"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>

                          <div className="p-4 space-y-3.5">
                            {/* in / out / duration */}
                            <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                              <div>
                                <FieldLabel>In</FieldLabel>
                                <Input
                                  placeholder="00:00:00"
                                  className={`font-mono text-sm bg-background ${form.formState.errors.clips?.[index]?.startTime ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.startTime`)}
                                />
                              </div>
                              <div>
                                <FieldLabel>Out</FieldLabel>
                                <Input
                                  placeholder="00:00:15"
                                  className={`font-mono text-sm bg-background ${form.formState.errors.clips?.[index]?.endTime ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.endTime`)}
                                />
                              </div>
                              <div className="font-mono text-[11px] text-primary border border-dashed border-primary/30 rounded-lg px-3 py-2.5 text-center whitespace-nowrap">
                                <span className="block text-[9px] text-muted-foreground/60 uppercase tracking-[0.12em]">Length</span>
                                {fmtDuration(start, end)}
                              </div>
                            </div>
                            {form.formState.errors.clips?.[index]?.endTime && (
                              <p className="text-[10px] text-destructive font-mono -mt-1.5">{form.formState.errors.clips[index]!.endTime!.message}</p>
                            )}

                            {/* headline */}
                            {!isRaw && (
                              <div>
                                <Input
                                  placeholder="Overlay headline…"
                                  className={`text-sm bg-background ${form.formState.errors.clips?.[index]?.headline ? "border-destructive" : ""}`}
                                  {...form.register(`clips.${index}.headline`)}
                                />
                                {form.formState.errors.clips?.[index]?.headline && (
                                  <p className="text-[10px] text-destructive font-mono mt-1">{form.formState.errors.clips[index]!.headline!.message}</p>
                                )}
                              </div>
                            )}

                            {/* toggles */}
                            <div className="flex flex-wrap gap-2">
                              <ToggleChip
                                label="Captions"
                                checked={form.watch(`clips.${index}.captionsEnabled`) ?? true}
                                onChange={(v) => form.setValue(`clips.${index}.captionsEnabled`, v)}
                              />
                              <ToggleChip
                                label="Outro card"
                                checked={form.watch(`clips.${index}.outroEnabled`) ?? true}
                                onChange={(v) => form.setValue(`clips.${index}.outroEnabled`, v)}
                              />
                            </div>

                            {/* voiceover PRO panel (edited only) */}
                            {!isRaw && (
                              <div className="rounded-lg border border-[#9b7bff]/30 bg-gradient-to-b from-[#9b7bff]/[0.08] to-[#9b7bff]/[0.02] p-3">
                                <div className="flex items-center justify-between gap-2">
                                  <label className="flex items-center gap-2.5 cursor-pointer">
                                    <span
                                      className={`w-3.5 h-3.5 rounded-[4px] border flex items-center justify-center ${
                                        voOn ? "bg-[#9b7bff] border-[#9b7bff]" : "border-muted-foreground/50"
                                      }`}
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.voiceoverEnabled`, !voOn); }}
                                    >
                                      {voOn && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3.5} />}
                                    </span>
                                    <span
                                      className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-[#c9b8ff] flex items-center gap-1.5"
                                      onClick={(e) => { e.preventDefault(); form.setValue(`clips.${index}.voiceoverEnabled`, !voOn); }}
                                    >
                                      <Mic className="w-3.5 h-3.5 text-[#9b7bff]" /> AI Voiceover Hook
                                      <span className="text-[8.5px] font-semibold tracking-[0.14em] text-[#b69dff] border border-[#9b7bff]/40 rounded px-1.5 py-0.5">PRO</span>
                                    </span>
                                  </label>
                                  {voOn && (
                                    <button
                                      type="button"
                                      onClick={() => copyHookPrompt(index)}
                                      className="text-[10px] font-mono uppercase tracking-[0.08em] text-[#b69dff] hover:underline flex items-center gap-1.5 shrink-0"
                                    >
                                      <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                    </button>
                                  )}
                                </div>
                                {voOn && (
                                  <Input
                                    placeholder="Spoken intro hook — type it, or paste from your Gemini app…"
                                    className="text-sm bg-background mt-2.5"
                                    {...form.register(`clips.${index}.voiceoverHook`)}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* add clip */}
                  <button
                    type="button"
                    onClick={() => clipCount < MAX_CLIPS && append({ ...defaultClip })}
                    disabled={clipCount >= MAX_CLIPS}
                    className={`w-full flex items-center justify-center gap-2 rounded-xl border border-dashed py-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${
                      clipCount >= MAX_CLIPS
                        ? "text-muted-foreground/30 border-border cursor-not-allowed"
                        : "text-muted-foreground border-border hover:text-primary hover:border-primary/40"
                    }`}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {clipCount >= MAX_CLIPS ? `Max ${MAX_CLIPS} clips reached` : `Add clip (${clipCount}/${MAX_CLIPS})`}
                  </button>

                  {/* CTA */}
                  <div className="flex items-center justify-between gap-4 flex-wrap pt-1">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {clipCount} job{clipCount > 1 ? "s" : ""} ready · ~25–30 min on phone
                    </span>
                    <Button type="submit" disabled={isSubmitting} className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7">
                      {isSubmitting ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING…</>
                      ) : (
                        <><SendHorizonal className="mr-2 h-4 w-4" />ENQUEUE {clipCount} JOB{clipCount > 1 ? "S" : ""}</>
                      )}
                    </Button>
                  </div>
                </form>
              )}

              {sourceTab === "local" && (
                <div className="rounded-xl border border-border bg-gradient-to-b from-card to-[hsl(240_10%_5%)] p-5 space-y-5">
                  <div>
                    <FieldLabel>Video file <span className="text-muted-foreground/50 normal-case">(max 20 GB)</span></FieldLabel>
                    <div
                      className={`relative flex items-center gap-3 rounded-lg border bg-background px-4 py-3 cursor-pointer hover:bg-background/70 transition-colors ${localErrors.file ? "border-destructive" : "border-border"}`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <FileVideo className={`w-5 h-5 shrink-0 ${selectedFile ? "text-primary" : "text-muted-foreground/50"}`} />
                      <div className="flex-1 min-w-0">
                        {selectedFile ? (
                          <>
                            <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                            <p className="text-[10px] font-mono text-muted-foreground">
                              {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                            </p>
                          </>
                        ) : (
                          <p className="text-sm text-muted-foreground">Click to browse or drag a video file here</p>
                        )}
                      </div>
                      {selectedFile && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                          className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="video/*"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          if (file && file.size > MAX_FILE_BYTES) {
                            toast({ title: "File too large", variant: "destructive" });
                            return;
                          }
                          setSelectedFile(file);
                          setLocalErrors((prev) => ({ ...prev, file: undefined }));
                        }}
                      />
                    </div>
                    {localErrors.file && <p className="text-xs text-destructive font-mono mt-1.5">{localErrors.file}</p>}
                  </div>

                  <div>
                    <FieldLabel>Mode</FieldLabel>
                    <Segmented
                      value={localForm.mode}
                      onChange={(m) => {
                        setLocalForm((p) => ({ ...p, mode: m as "edited" | "raw" }));
                        if (m === "raw") setLocalErrors((p) => ({ ...p, headline: undefined }));
                      }}
                      options={[
                        { value: "edited", label: "Edited" },
                        { value: "raw", label: "Raw" },
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>In</FieldLabel>
                      <Input
                        placeholder="00:00:00"
                        className={`font-mono text-sm bg-background ${localErrors.startTime ? "border-destructive" : ""}`}
                        value={localForm.startTime}
                        onChange={(e) => setLocalForm((p) => ({ ...p, startTime: e.target.value }))}
                      />
                      {localErrors.startTime && <p className="text-xs text-destructive font-mono mt-1">{localErrors.startTime}</p>}
                    </div>
                    <div>
                      <FieldLabel>Out</FieldLabel>
                      <Input
                        placeholder="00:01:00"
                        className={`font-mono text-sm bg-background ${localErrors.endTime ? "border-destructive" : ""}`}
                        value={localForm.endTime}
                        onChange={(e) => setLocalForm((p) => ({ ...p, endTime: e.target.value }))}
                      />
                      {localErrors.endTime && <p className="text-xs text-destructive font-mono mt-1">{localErrors.endTime}</p>}
                    </div>
                  </div>

                  {localForm.mode === "edited" && (
                    <div>
                      <FieldLabel>Overlay headline</FieldLabel>
                      <Input
                        placeholder="Overlay headline…"
                        className={`text-sm bg-background ${localErrors.headline ? "border-destructive" : ""}`}
                        value={localForm.headline}
                        onChange={(e) => setLocalForm((p) => ({ ...p, headline: e.target.value }))}
                      />
                      {localErrors.headline && <p className="text-xs text-destructive font-mono mt-1">{localErrors.headline}</p>}
                    </div>
                  )}

                  <div>
                    <FieldLabel>Source creator <span className="text-muted-foreground/50 normal-case">(optional)</span></FieldLabel>
                    <Input
                      placeholder="e.g. KSI, MrBeast, IShowSpeed"
                      className="font-mono text-sm bg-background"
                      value={localForm.sourceChannel}
                      onChange={(e) => setLocalForm((p) => ({ ...p, sourceChannel: e.target.value }))}
                    />
                  </div>

                  <ToggleChip
                    label="Enable captions"
                    checked={localForm.captionsEnabled}
                    onChange={(v) => setLocalForm((p) => ({ ...p, captionsEnabled: v }))}
                  />

                  {uploadProgress !== null && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                        <span>Uploading…</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end pt-1">
                    <Button
                      type="button"
                      disabled={isUploading}
                      onClick={handleLocalUpload}
                      className="font-mono uppercase tracking-[0.13em] text-xs h-12 px-7"
                    >
                      {isUploading ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />UPLOADING…</>
                      ) : (
                        <><Upload className="mr-2 h-4 w-4" />UPLOAD &amp; PROCESS</>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT — live preview (sticky on desktop) */}
            <div className="lg:sticky lg:top-[84px]">
              <LivePreview
                headline={preview.headline}
                mode={preview.mode}
                frameStyle={wFrame}
                captions={preview.captions}
                voiceover={preview.voiceover}
                hook={preview.hook}
                handle={channelHandle}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
