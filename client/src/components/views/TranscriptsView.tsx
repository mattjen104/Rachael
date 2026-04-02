import React, { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, getStoredApiKey, apiUrl } from "@/lib/queryClient";
import type { Transcript } from "@shared/schema";

interface TranscriptsViewProps {
  selectedTranscriptId?: number;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function platformBadge(platform: string): string {
  const badges: Record<string, string> = {
    teams: "TEAMS",
    zoom: "ZOOM",
    "google-meet": "MEET",
    webex: "WEBEX",
    slack: "SLACK",
    other: "OTHER",
  };
  return badges[platform] || "OTHER";
}

function statusIndicator(status: string): { label: string; color: string } {
  switch (status) {
    case "recording": return { label: "REC", color: "text-red-500" };
    case "transcribing": return { label: "PROCESSING", color: "text-yellow-500" };
    case "done": return { label: "DONE", color: "text-green-500" };
    case "error": return { label: "ERROR", color: "text-red-400" };
    default: return { label: status.toUpperCase(), color: "text-muted-foreground" };
  }
}

function RecordingTypeBadge({ type }: { type: string }) {
  const label = type === "manual" ? "MIC" : "TAB";
  return (
    <span
      className="text-[9px] px-1 py-0.5 rounded bg-muted/50 text-muted-foreground font-mono"
      data-testid={`badge-recording-type-${type}`}
    >
      {label}
    </span>
  );
}

export default function TranscriptsView({ selectedTranscriptId }: TranscriptsViewProps) {
  const { data: transcripts = [], isLoading } = useQuery<Transcript[]>({
    queryKey: ["/api/transcripts"],
    refetchInterval: 5000,
  });

  const deleteTranscript = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/transcripts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/transcripts"] });
    },
  });

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [readingId, setReadingId] = useState<number | null>(selectedTranscriptId || null);
  const [isRecordingManual, setIsRecordingManual] = useState(false);
  const [manualRecorder, setManualRecorder] = useState<MediaRecorder | null>(null);
  const [manualChunks, setManualChunks] = useState<Blob[]>([]);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedTranscriptId) setReadingId(selectedTranscriptId);
  }, [selectedTranscriptId]);

  const readingTranscript = readingId ? transcripts.find(t => t.id === readingId) : null;

  const startManualRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        setIsRecordingManual(false);
        setRecordingDuration(0);

        const blob = new Blob(chunks, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("audio", blob, "recording.webm");
        formData.append("title", `Manual recording ${new Date().toLocaleString()}`);
        formData.append("recordingType", "manual");

        try {
          const headers: Record<string, string> = {};
          const apiKey = getStoredApiKey();
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
          await fetch(apiUrl("/api/transcripts/upload"), { method: "POST", body: formData, headers, credentials: "include" });
          queryClient.invalidateQueries({ queryKey: ["/api/transcripts"] });
        } catch (err) {
          console.error("Upload failed:", err);
        }
      };

      recorder.start(1000);
      setManualRecorder(recorder);
      setManualChunks(chunks);
      setIsRecordingManual(true);
      setRecordingDuration(0);

      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(d => d + 1);
      }, 1000);
    } catch (err) {
      console.error("Microphone access denied:", err);
    }
  }, []);

  const stopManualRecording = useCallback(() => {
    if (manualRecorder && manualRecorder.state !== "inactive") {
      manualRecorder.stop();
    }
  }, [manualRecorder]);

  useEffect(() => {
    const handleRecordCommand = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === "start" && !isRecordingManual) startManualRecording();
      if (detail === "stop" && isRecordingManual) stopManualRecording();
    };
    window.addEventListener("transcripts:record", handleRecordCommand);
    return () => window.removeEventListener("transcripts:record", handleRecordCommand);
  }, [isRecordingManual, startManualRecording, stopManualRecording]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (readingTranscript) {
      if (e.key === "Escape") {
        e.preventDefault();
        setReadingId(null);
      }
      return;
    }

    switch (e.key) {
      case "j":
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, transcripts.length - 1));
        break;
      case "k":
        e.preventDefault();
        setSelectedIdx(i => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (transcripts[selectedIdx]) setReadingId(transcripts[selectedIdx].id);
        break;
      case "d":
        e.preventDefault();
        if (transcripts[selectedIdx]) deleteTranscript.mutate(transcripts[selectedIdx].id);
        break;
      case "m":
        e.preventDefault();
        if (isRecordingManual) stopManualRecording();
        else startManualRecording();
        break;
    }
  }, [readingTranscript, transcripts, selectedIdx, deleteTranscript, isRecordingManual, startManualRecording, stopManualRecording]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (readingTranscript) {
    const si = statusIndicator(readingTranscript.status);
    const segments = (readingTranscript.segments || []) as Array<{ start: number; end: number; text: string }>;

    return (
      <div className="flex flex-col h-full overflow-hidden font-mono text-xs" data-testid="transcript-detail">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
          <button
            onClick={() => setReadingId(null)}
            className="text-muted-foreground hover:text-primary cursor-pointer"
            data-testid="button-back-transcripts"
          >
            ← back
          </button>
          <span className="flex-1 truncate text-primary font-bold" data-testid="text-transcript-title">
            {readingTranscript.title}
          </span>
          <span className="text-[9px] px-1 py-0.5 rounded bg-primary/20 text-primary font-bold">
            {platformBadge(readingTranscript.platform)}
          </span>
          <RecordingTypeBadge type={readingTranscript.recordingType} />
          <span className={`text-[9px] ${si.color}`}>{si.label}</span>
        </div>

        <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-muted-foreground border-b border-border">
          <span data-testid="text-transcript-duration">Duration: {formatDuration(readingTranscript.durationSeconds)}</span>
          {readingTranscript.sourceUrl && (
            <span className="truncate" data-testid="text-transcript-source">{readingTranscript.sourceUrl}</span>
          )}
          <span>{new Date(readingTranscript.createdAt).toLocaleDateString()}</span>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2" data-testid="transcript-content">
          {readingTranscript.status === "transcribing" && (
            <div className="text-yellow-500 py-4 text-center" data-testid="status-transcribing">
              Transcribing audio... This may take a few minutes.
            </div>
          )}
          {readingTranscript.status === "recording" && (
            <div className="text-red-500 py-4 text-center" data-testid="status-recording">
              Recording in progress...
            </div>
          )}
          {readingTranscript.status === "error" && (
            <div className="text-red-400 py-2" data-testid="status-error">
              {readingTranscript.rawText}
            </div>
          )}
          {readingTranscript.status === "done" && segments.length > 0 ? (
            <div className="space-y-1">
              {segments.map((seg, i) => (
                <div key={i} className="flex gap-2 hover:bg-muted/20 py-0.5 px-1 rounded" data-testid={`segment-${i}`}>
                  <span className="text-muted-foreground shrink-0 w-16 text-right">
                    {formatTimestamp(seg.start)}
                  </span>
                  <span className="text-foreground">{seg.text}</span>
                </div>
              ))}
            </div>
          ) : readingTranscript.status === "done" && readingTranscript.rawText ? (
            <div className="whitespace-pre-wrap text-foreground leading-relaxed" data-testid="text-raw-transcript">
              {readingTranscript.rawText}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden font-mono text-xs" data-testid="transcripts-view">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <span className="text-primary font-bold text-[11px]">TRANSCRIPTS</span>
        <div className="flex items-center gap-2">
          {isRecordingManual ? (
            <button
              onClick={stopManualRecording}
              className="text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 cursor-pointer flex items-center gap-1"
              data-testid="button-stop-manual-recording"
            >
              <span className="animate-pulse">●</span> STOP {formatDuration(recordingDuration)}
            </button>
          ) : (
            <button
              onClick={startManualRecording}
              className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted/80 text-muted-foreground hover:text-primary cursor-pointer"
              data-testid="button-start-manual-recording"
            >
              🎤 Record
            </button>
          )}
          <span className="text-muted-foreground text-[10px]">{transcripts.length} items</span>
        </div>
      </div>

      <div className="text-[9px] text-muted-foreground px-3 py-1 border-b border-border">
        j/k:nav Enter:open d:delete m:mic-record
      </div>

      <div className="flex-1 overflow-y-auto" data-testid="transcripts-list">
        {isLoading ? (
          <div className="text-muted-foreground px-3 py-4 text-center">Loading...</div>
        ) : transcripts.length === 0 ? (
          <div className="text-muted-foreground px-3 py-4 text-center">
            No transcripts yet. Record a meeting or use the microphone to get started.
          </div>
        ) : (
          transcripts.map((t, idx) => {
            const si = statusIndicator(t.status);
            return (
              <div
                key={t.id}
                data-testid={`transcript-item-${t.id}`}
                data-selected={idx === selectedIdx}
                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b border-border/50 ${
                  idx === selectedIdx ? "bg-primary/10 text-primary" : "hover:bg-muted/30"
                }`}
                onClick={() => { setSelectedIdx(idx); setReadingId(t.id); }}
              >
                <span className={`text-[9px] shrink-0 ${si.color}`} data-testid={`status-${t.id}`}>
                  {si.label === "REC" ? <span className="animate-pulse">●</span> : si.label}
                </span>
                <span className="text-[9px] px-1 py-0.5 rounded bg-primary/20 text-primary font-bold shrink-0">
                  {platformBadge(t.platform)}
                </span>
                <RecordingTypeBadge type={t.recordingType} />
                <span className="flex-1 truncate" data-testid={`text-title-${t.id}`}>
                  {t.title || `${t.platform} recording`}
                </span>
                <span className="text-muted-foreground shrink-0" data-testid={`text-duration-${t.id}`}>
                  {formatDuration(t.durationSeconds)}
                </span>
                <span className="text-muted-foreground text-[9px] shrink-0">
                  {new Date(t.createdAt).toLocaleDateString()}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
