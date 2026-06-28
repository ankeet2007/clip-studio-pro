import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { API_BASE } from "@/lib/api";
import {
  useListClips,
  useGetClipStats,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AppHeader } from "@/components/app-header";
import {
  Loader2,
  Activity,
  BarChart2,
  Plus,
  X,
  ChevronRight,
  Settings,
  Youtube,
  Upload,
  FileVideo,
  MonitorPlay,
  Mic,
  ClipboardCopy,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

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

export default function Home() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sourceTab, setSourceTab] = useState<SourceTab>("youtube");
  const [navConfirmOpen, setNavConfirmOpen] = useState(false);

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

  useListClips({ query: { queryKey: getListClipsQueryKey() } });

  const { data: stats, isLoading: isLoadingStats } = useGetClipStats({
    query: { queryKey: getGetClipStatsQueryKey() },
  });

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
  // then pastes the returned hook line back into the voiceover text box. The prompt
  // is built from context available at creation time (no transcript yet — that only
  // exists after a render).
  async function copyHookPrompt(index: number) {
    const values = form.getValues();
    const clip = values.clips[index];
    if (!clip) return;
    const toSecs = (t: string) => t.split(":").reduce((a, v) => a * 60 + Number(v), 0);
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
    try {
      await navigator.clipboard.writeText(prompt);
      toast({ title: "Prompt copied", description: "Paste it into your Gemini app, then paste the hook back here." });
    } catch {
      toast({ title: "Copy failed", description: "Clipboard unavailable — long-press to copy manually.", variant: "destructive" });
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
      const toSecs = (t: string) => t.split(":").reduce((acc, v) => acc * 60 + Number(v), 0);
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

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
      <AppHeader>
        <button
          onClick={() => navigate("/settings")}
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          title="Settings"
          aria-label="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </AppHeader>

      <main className="flex-1 flex flex-col min-h-0">
        <section className="flex-1 min-h-0 overflow-y-auto border-b border-border bg-background p-4 md:p-8">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-5 flex items-center gap-2">
              <Activity className="w-4 h-4" />
              New Job Definition
            </h2>

            {/* Source + Frame Style toggles */}
            <div className="flex flex-wrap gap-3 mb-5">
              <div className="flex rounded-md overflow-hidden border border-border bg-card w-fit">
                <button
                  type="button"
                  onClick={() => { setSourceTab("youtube"); setLocalErrors({}); }}
                  className={`flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                    sourceTab === "youtube" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Youtube className="w-3.5 h-3.5" />
                  YouTube
                </button>
                <button
                  type="button"
                  onClick={() => { setSourceTab("local"); setLocalErrors({}); }}
                  className={`flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                    sourceTab === "local" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Upload className="w-3.5 h-3.5" />
                  Local File
                </button>
              </div>

              <div className="flex rounded-md overflow-hidden border border-border bg-card w-fit">
                <button
                  type="button"
                  onClick={() => form.setValue("frameStyle", "immersive")}
                  className={`px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                    form.watch("frameStyle") === "immersive" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Immersive
                </button>
                <button
                  type="button"
                  onClick={() => form.setValue("frameStyle", "standard")}
                  className={`px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                    form.watch("frameStyle") === "standard" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Standard
                </button>
              </div>
            </div>

            {sourceTab === "youtube" && (
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                {/* URL row */}
                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Source URL
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://youtube.com/watch?v=..."
                      className="font-mono text-sm bg-card flex-1 min-w-0"
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
                    <p className="text-xs text-destructive font-mono">{form.formState.errors.youtubeUrl.message}</p>
                  )}
                </div>

                {/* YouTube preview player */}
                {showPlayer && videoId && (
                  <div className="rounded-md border border-border overflow-hidden bg-black">
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

                {/* Source Creator */}
                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Source Creator <span className="text-muted-foreground/40">(optional)</span>
                  </Label>
                  <Input
                    placeholder="e.g. KSI, MrBeast, IShowSpeed"
                    className="font-mono text-sm bg-card"
                    {...form.register("sourceChannel")}
                  />
                </div>

                {/* Clip entries */}
                <div className="space-y-2">
                  {/* Desktop header row */}
                  <div className="hidden md:grid grid-cols-12 gap-3 px-1">
                    <div className="col-span-1">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">#</span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Mode</span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">In</span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Out</span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Headline</span>
                    </div>
                    <div className="col-span-1 text-center">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">CC</span>
                    </div>
                    <div className="col-span-1 text-center">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Outro</span>
                    </div>
                    <div className="col-span-1" />
                  </div>

                  {fields.map((field, index) => {
                    const currentMode = form.watch(`clips.${index}.mode`);
                    const isRaw = currentMode === "raw";

                    return (
                      <div key={field.id}>
                        {/* Mobile card */}
                        <div className="md:hidden rounded-md border border-border bg-card/40 p-3 space-y-2.5">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] text-muted-foreground/40 tabular-nums w-5 shrink-0">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <div className="flex rounded overflow-hidden border border-border text-[10px] font-mono uppercase tracking-wider flex-1">
                              <button
                                type="button"
                                onClick={() => form.setValue(`clips.${index}.mode`, "edited")}
                                className={`flex-1 py-1.5 flex items-center justify-center transition-colors ${!isRaw ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                              >
                                Edited
                              </button>
                              <button
                                type="button"
                                onClick={() => form.setValue(`clips.${index}.mode`, "raw")}
                                className={`flex-1 py-1.5 flex items-center justify-center transition-colors ${isRaw ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                              >
                                Raw
                              </button>
                            </div>
                            <div className="flex items-center gap-2.5 shrink-0">
                              <label className="flex items-center gap-1 cursor-pointer">
                                <Checkbox
                                  checked={form.watch(`clips.${index}.captionsEnabled`) ?? true}
                                  onCheckedChange={(v) => form.setValue(`clips.${index}.captionsEnabled`, v === true)}
                                />
                                <span className="text-[10px] font-mono text-muted-foreground">CC</span>
                              </label>
                              <label className="flex items-center gap-1 cursor-pointer">
                                <Checkbox
                                  checked={form.watch(`clips.${index}.outroEnabled`) ?? true}
                                  onCheckedChange={(v) => form.setValue(`clips.${index}.outroEnabled`, v === true)}
                                />
                                <span className="text-[10px] font-mono text-muted-foreground">Outro</span>
                              </label>
                              {clipCount > 1 && (
                                <button
                                  type="button"
                                  onClick={() => remove(index)}
                                  className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-1">In</p>
                              <Input
                                placeholder="00:00:00"
                                className={`font-mono text-sm bg-background h-9 ${form.formState.errors.clips?.[index]?.startTime ? "border-destructive" : ""}`}
                                {...form.register(`clips.${index}.startTime`)}
                              />
                              {form.formState.errors.clips?.[index]?.startTime && (
                                <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.startTime!.message}</p>
                              )}
                            </div>
                            <div>
                              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-1">Out</p>
                              <Input
                                placeholder="00:00:15"
                                className={`font-mono text-sm bg-background h-9 ${form.formState.errors.clips?.[index]?.endTime ? "border-destructive" : ""}`}
                                {...form.register(`clips.${index}.endTime`)}
                              />
                              {form.formState.errors.clips?.[index]?.endTime && (
                                <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.endTime!.message}</p>
                              )}
                            </div>
                          </div>

                          {!isRaw && (
                            <div>
                              <Input
                                placeholder="Overlay headline…"
                                className={`text-sm bg-background h-9 ${form.formState.errors.clips?.[index]?.headline ? "border-destructive" : ""}`}
                                {...form.register(`clips.${index}.headline`)}
                              />
                              {form.formState.errors.clips?.[index]?.headline && (
                                <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.headline!.message}</p>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Desktop row */}
                        <div className="hidden md:grid grid-cols-12 gap-3 items-start">
                          <div className="col-span-1 flex items-center h-10">
                            <span className="font-mono text-xs text-muted-foreground/40 tabular-nums">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                          </div>
                          <div className="col-span-2 flex h-10 rounded-md overflow-hidden border border-border bg-card text-[10px] font-mono uppercase tracking-wider">
                            <button
                              type="button"
                              onClick={() => form.setValue(`clips.${index}.mode`, "edited")}
                              className={`flex-1 flex items-center justify-center transition-colors ${!isRaw ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                            >
                              Edited
                            </button>
                            <button
                              type="button"
                              onClick={() => form.setValue(`clips.${index}.mode`, "raw")}
                              className={`flex-1 flex items-center justify-center transition-colors ${isRaw ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                            >
                              Raw
                            </button>
                          </div>
                          <div className="col-span-2">
                            <Input placeholder="00:00:00" className="font-mono text-sm bg-card h-10" {...form.register(`clips.${index}.startTime`)} />
                            {form.formState.errors.clips?.[index]?.startTime && (
                              <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.startTime!.message}</p>
                            )}
                          </div>
                          <div className="col-span-2">
                            <Input placeholder="00:00:15" className="font-mono text-sm bg-card h-10" {...form.register(`clips.${index}.endTime`)} />
                            {form.formState.errors.clips?.[index]?.endTime && (
                              <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.endTime!.message}</p>
                            )}
                          </div>
                          <div className="col-span-2">
                            {isRaw ? (
                              <div className="h-10 flex items-center px-3 rounded-md border border-dashed border-border/50 text-xs text-muted-foreground/40 font-mono italic select-none">
                                no overlay
                              </div>
                            ) : (
                              <>
                                <Input placeholder="Overlay headline…" className="text-sm bg-card h-10" {...form.register(`clips.${index}.headline`)} />
                                {form.formState.errors.clips?.[index]?.headline && (
                                  <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.headline!.message}</p>
                                )}
                              </>
                            )}
                          </div>
                          <div className="col-span-1 flex items-center justify-center h-10">
                            <Checkbox
                              checked={form.watch(`clips.${index}.captionsEnabled`) ?? true}
                              onCheckedChange={(v) => form.setValue(`clips.${index}.captionsEnabled`, v === true)}
                              title="Enable captions"
                            />
                          </div>
                          <div className="col-span-1 flex items-center justify-center h-10">
                            <Checkbox
                              checked={form.watch(`clips.${index}.outroEnabled`) ?? true}
                              onCheckedChange={(v) => form.setValue(`clips.${index}.outroEnabled`, v === true)}
                              title="Include outro card"
                            />
                          </div>
                          <div className="col-span-1 flex items-center justify-center h-10">
                            {clipCount > 1 && (
                              <button
                                type="button"
                                onClick={() => remove(index)}
                                className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Voiceover hook row — full width, both layouts (edited mode only) */}
                        {!isRaw && (
                          <div className="mt-2 rounded-md border border-border/60 bg-card/40 p-2.5 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <Checkbox
                                  checked={form.watch(`clips.${index}.voiceoverEnabled`) ?? false}
                                  onCheckedChange={(v) => form.setValue(`clips.${index}.voiceoverEnabled`, v === true)}
                                />
                                <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                  <Mic className="w-3 h-3" /> AI Voiceover Hook
                                </span>
                              </label>
                              {form.watch(`clips.${index}.voiceoverEnabled`) && (
                                <button
                                  type="button"
                                  onClick={() => copyHookPrompt(index)}
                                  className="text-[10px] font-mono uppercase tracking-wider text-primary hover:underline flex items-center gap-1 shrink-0"
                                >
                                  <ClipboardCopy className="w-3 h-3" /> Copy Gemini prompt
                                </button>
                              )}
                            </div>
                            {form.watch(`clips.${index}.voiceoverEnabled`) && (
                              <Input
                                placeholder="Spoken intro hook — type it, or paste from your Gemini app…"
                                className="text-sm bg-background h-9"
                                {...form.register(`clips.${index}.voiceoverHook`)}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => clipCount < MAX_CLIPS && append({ ...defaultClip })}
                  disabled={clipCount >= MAX_CLIPS}
                  className={`flex items-center gap-2 text-xs font-mono uppercase tracking-wider py-1 transition-colors ${
                    clipCount >= MAX_CLIPS
                      ? "text-muted-foreground/30 cursor-not-allowed"
                      : "text-muted-foreground hover:text-primary"
                  }`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {clipCount >= MAX_CLIPS ? `Max ${MAX_CLIPS} clips reached` : `Add clip (${clipCount}/${MAX_CLIPS})`}
                </button>

                <div className="flex justify-end pt-1">
                  <Button type="submit" disabled={isSubmitting} className="font-mono uppercase tracking-widest text-xs h-12 px-8">
                    {isSubmitting ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING...</>
                    ) : (
                      `ENQUEUE ${clipCount} JOB${clipCount > 1 ? "S" : ""}`
                    )}
                  </Button>
                </div>
              </form>
            )}

            {sourceTab === "local" && (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Video File <span className="text-muted-foreground/50">(max 20 GB)</span>
                  </Label>
                  <div
                    className={`relative flex items-center gap-3 rounded-md border bg-card px-4 py-3 cursor-pointer hover:bg-card/80 transition-colors ${localErrors.file ? "border-destructive" : "border-border"}`}
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
                  {localErrors.file && <p className="text-xs text-destructive font-mono">{localErrors.file}</p>}
                </div>

                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Mode</Label>
                  <div className="flex rounded-md overflow-hidden border border-border bg-card w-fit">
                    {(["edited", "raw"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setLocalForm((p) => ({ ...p, mode: m }));
                          if (m === "raw") setLocalErrors((p) => ({ ...p, headline: undefined }));
                        }}
                        className={`px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                          localForm.mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">In</Label>
                    <Input
                      placeholder="00:00:00"
                      className={`font-mono text-sm bg-card ${localErrors.startTime ? "border-destructive" : ""}`}
                      value={localForm.startTime}
                      onChange={(e) => setLocalForm((p) => ({ ...p, startTime: e.target.value }))}
                    />
                    {localErrors.startTime && <p className="text-xs text-destructive font-mono">{localErrors.startTime}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Out</Label>
                    <Input
                      placeholder="00:01:00"
                      className={`font-mono text-sm bg-card ${localErrors.endTime ? "border-destructive" : ""}`}
                      value={localForm.endTime}
                      onChange={(e) => setLocalForm((p) => ({ ...p, endTime: e.target.value }))}
                    />
                    {localErrors.endTime && <p className="text-xs text-destructive font-mono">{localErrors.endTime}</p>}
                  </div>
                </div>

                {localForm.mode === "edited" && (
                  <div className="space-y-1.5">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Overlay Headline</Label>
                    <Input
                      placeholder="Overlay headline…"
                      className={`text-sm bg-card ${localErrors.headline ? "border-destructive" : ""}`}
                      value={localForm.headline}
                      onChange={(e) => setLocalForm((p) => ({ ...p, headline: e.target.value }))}
                    />
                    {localErrors.headline && <p className="text-xs text-destructive font-mono">{localErrors.headline}</p>}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Source Creator <span className="text-muted-foreground/50">(optional)</span>
                  </Label>
                  <Input
                    placeholder="e.g. KSI, MrBeast, IShowSpeed"
                    className="font-mono text-sm bg-card"
                    value={localForm.sourceChannel}
                    onChange={(e) => setLocalForm((p) => ({ ...p, sourceChannel: e.target.value }))}
                  />
                </div>

                <label className="flex items-center gap-2.5 cursor-pointer w-fit">
                  <Checkbox
                    checked={localForm.captionsEnabled}
                    onCheckedChange={(v) => setLocalForm((p) => ({ ...p, captionsEnabled: v === true }))}
                  />
                  <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Enable Captions</span>
                </label>

                {uploadProgress !== null && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                      <span>Uploading…</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="h-1 bg-muted rounded-full overflow-hidden">
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
                    className="font-mono uppercase tracking-widest text-xs h-12 px-8"
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
        </section>

        <AlertDialog open={navConfirmOpen} onOpenChange={setNavConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Leave without submitting?</AlertDialogTitle>
              <AlertDialogDescription>
                You have unsaved changes in the form. They will be lost if you navigate away.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Stay</AlertDialogCancel>
              <AlertDialogAction onClick={() => navigate("/timeline")}>Leave</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <button
          type="button"
          onClick={() => {
            if (form.formState.isDirty) {
              setNavConfirmOpen(true);
            } else {
              navigate("/timeline");
            }
          }}
          className="shrink-0 border-t border-border bg-card px-6 py-3 flex items-center justify-between w-full hover:bg-card/80 transition-colors"
        >
          <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground uppercase tracking-widest">
            <BarChart2 className="w-4 h-4" />
            Timeline
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            {isLoadingStats ? (
              <Skeleton className="h-3 w-24 bg-muted" />
            ) : stats ? (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">TOTAL:</span>
                <span className="text-foreground">{stats.total}</span>
              </div>
            ) : null}
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </div>
        </button>
      </main>
    </div>
  );
}
