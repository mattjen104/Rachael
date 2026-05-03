import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

type Episode = {
  id: number;
  slug: string;
  kind: "morning" | "afternoon" | "weekly";
  publishedDate: string;
  title: string;
  summary: string;
  scriptText: string;
  audioUrl: string | null;
  durationSec: number;
  sizeBytes: number;
  status: "pending" | "ready" | "failed";
  failureReason: string | null;
};

type Segment = {
  id: number;
  episodeId: number;
  ordinal: number;
  topic: string;
  text: string;
  startSec: number;
  endSec: number;
  feedback: number;
};

type FeedToken = { id: number; token: string; label: string; lastUsed: string | null; createdAt: string };

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function kindBadge(k: string): string {
  if (k === "morning") return "MORNING";
  if (k === "afternoon") return "AFTERNOON";
  if (k === "weekly") return "WEEK WRAP";
  return k.toUpperCase();
}

export default function StandupView() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [generating, setGenerating] = useState<"morning" | "afternoon" | "weekly" | null>(null);
  const [moveText, setMoveText] = useState("");
  type MoveAction = "do" | "snooze" | "drop" | "note";
  const MOVE_ACTIONS: readonly MoveAction[] = ["do", "snooze", "drop", "note"] as const;
  const isMoveAction = (v: string): v is MoveAction => (MOVE_ACTIONS as readonly string[]).includes(v);
  const [moveAction, setMoveAction] = useState<MoveAction>("note");
  const [moveStatus, setMoveStatus] = useState<string>("");
  const [showTranscript, setShowTranscript] = useState(false);
  const [feedTokens, setFeedTokens] = useState<FeedToken[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const selected = useMemo(() => episodes.find(e => e.id === selectedId) || null, [episodes, selectedId]);

  const reload = useCallback(async () => {
    try {
      const r = await apiRequest("GET", "/api/standup/episodes");
      const data = await r.json();
      setEpisodes(data || []);
      if (!selectedId && data?.length) setSelectedId(data[0].id);
    } catch {}
  }, [selectedId]);

  const reloadSegments = useCallback(async (id: number) => {
    try {
      const r = await apiRequest("GET", `/api/standup/episodes/${id}`);
      const data = await r.json();
      setSegments(data?.segments || []);
    } catch {}
  }, []);

  const reloadTokens = useCallback(async () => {
    try {
      const r = await apiRequest("GET", "/api/standup/feed-tokens");
      const data = await r.json();
      setFeedTokens(data || []);
    } catch {}
  }, []);

  useEffect(() => { reload(); reloadTokens(); }, [reload, reloadTokens]);
  useEffect(() => {
    if (selectedId) reloadSegments(selectedId);
  }, [selectedId, reloadSegments]);

  // Fetch audio as a blob using authenticated apiRequest, then hand the
  // resulting object URL to the <audio> element. This is necessary because
  // <audio src> cannot send custom Authorization headers, but the audio
  // route is auth-gated.
  useEffect(() => {
    setAudioBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (!selected || selected.status !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiRequest("GET", `/api/standup/episodes/${selected.id}/audio.mp3`);
        const blob = await r.blob();
        if (cancelled) return;
        setAudioBlobUrl(URL.createObjectURL(blob));
      } catch {
        if (!cancelled) setAudioBlobUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selected?.id, selected?.status]);
  // Clean up blob URL on unmount
  useEffect(() => () => { if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl); }, []);

  // Poll while a pending episode is generating
  useEffect(() => {
    const hasPending = episodes.some(e => e.status === "pending");
    if (!hasPending && !generating) return;
    const t = setInterval(() => { reload(); if (selectedId) reloadSegments(selectedId); }, 4000);
    return () => clearInterval(t);
  }, [episodes, generating, reload, reloadSegments, selectedId]);

  const generate = async (kind: "morning" | "afternoon" | "weekly") => {
    setGenerating(kind);
    try {
      await apiRequest("POST", "/api/standup/generate", { kind });
      setTimeout(() => { reload(); setGenerating(null); }, 1500);
    } catch {
      setGenerating(null);
    }
  };

  const sendMove = async (overrideAction?: MoveAction, overrideSegmentId?: number | null) => {
    const action = overrideAction || moveAction;
    const note = moveText.trim();
    if (action === "note" && !note) return;
    setMoveStatus("Sending...");
    try {
      const r = await apiRequest("POST", "/api/standup/your-move", {
        action,
        note: note || undefined,
        segmentId: overrideSegmentId !== undefined ? overrideSegmentId : (activeSegmentId || undefined),
        source: "standup-view",
      });
      const data = await r.json();
      setMoveStatus(data.ok ? `OK: ${data.outcome || action}` : `Error: ${data.message || "failed"}`);
      if (data.ok) setMoveText("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "failed";
      setMoveStatus(`Error: ${msg}`);
    }
  };

  const setFeedback = async (segId: number, value: number) => {
    try {
      const r = await apiRequest("POST", `/api/standup/segments/${segId}/feedback`, { value });
      const updated = await r.json();
      setSegments(prev => prev.map(s => s.id === segId ? { ...s, feedback: updated.feedback } : s));
    } catch {}
  };

  const newToken = async () => {
    const label = prompt("Label for this feed token (e.g. iphone-overcast)") || "default";
    await apiRequest("POST", "/api/standup/feed-tokens", { label });
    reloadTokens();
  };

  const deleteToken = async (token: string) => {
    if (!confirm("Revoke this token?")) return;
    await apiRequest("DELETE", `/api/standup/feed-tokens/${token}`);
    reloadTokens();
  };

  const seekTo = (sec: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = sec;
      audioRef.current.play();
    }
  };

  const activeSegmentId = useMemo(() => {
    const s = segments.find(s => currentTime >= s.startSec && currentTime < s.endSec);
    return s?.id || null;
  }, [segments, currentTime]);

  // Standup-local hotkeys:
  //   J / K — next / prev episode
  //   T     — toggle full transcript panel
  //   F     — focus first 👍/👎 button on active segment
  //   M     — focus "your move" input
  //   D     — quick "do" on active segment
  //   X     — quick "drop" on active segment
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "m") {
        e.preventDefault();
        document.getElementById("standup-move-input")?.focus();
      } else if (k === "t") {
        e.preventDefault();
        setShowTranscript(s => !s);
      } else if (k === "f") {
        if (activeSegmentId) {
          e.preventDefault();
          (document.querySelector(`[data-testid="feedback-up-${activeSegmentId}"]`) as HTMLElement | null)?.focus();
        }
      } else if (k === "d" && activeSegmentId) {
        e.preventDefault();
        sendMove("do", activeSegmentId);
      } else if (k === "x" && activeSegmentId) {
        e.preventDefault();
        sendMove("drop", activeSegmentId);
      } else if (k === "j") {
        e.preventDefault();
        setSelectedId(prev => {
          const idx = episodes.findIndex(ep => ep.id === prev);
          if (idx < 0 || idx >= episodes.length - 1) return prev;
          return episodes[idx + 1].id;
        });
      } else if (k === "k") {
        e.preventDefault();
        setSelectedId(prev => {
          const idx = episodes.findIndex(ep => ep.id === prev);
          if (idx <= 0) return prev;
          return episodes[idx - 1].id;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeSegmentId, episodes]);

  const feedBaseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="h-full flex flex-col bg-background text-foreground font-mono text-xs overflow-hidden" data-testid="view-standup">
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5 bg-card">
        <div className="text-primary font-bold text-[11px]">[STANDUP.FM]</div>
        <div className="flex gap-1">
          <button
            data-testid="button-generate-morning"
            onClick={() => generate("morning")}
            disabled={generating !== null}
            className="px-2 py-0.5 border border-border hover:border-primary text-[10px] disabled:opacity-50"
          >▶ MORNING</button>
          <button
            data-testid="button-generate-afternoon"
            onClick={() => generate("afternoon")}
            disabled={generating !== null}
            className="px-2 py-0.5 border border-border hover:border-primary text-[10px] disabled:opacity-50"
          >▶ AFTERNOON</button>
          <button
            data-testid="button-generate-weekly"
            onClick={() => generate("weekly")}
            disabled={generating !== null}
            className="px-2 py-0.5 border border-border hover:border-primary text-[10px] disabled:opacity-50"
          >▶ WEEK</button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Episode list */}
        <div className="w-32 border-r border-border overflow-y-auto">
          {episodes.length === 0 && (
            <div className="p-2 text-muted-foreground text-[10px]">No episodes yet. Hit ▶ MORNING.</div>
          )}
          {episodes.map(ep => (
            <button
              key={ep.id}
              data-testid={`episode-${ep.id}`}
              onClick={() => setSelectedId(ep.id)}
              className={`w-full text-left px-2 py-1.5 border-b border-border/40 hover:bg-card ${selectedId === ep.id ? "bg-card text-primary" : ""}`}
            >
              <div className="text-[10px] font-bold">{ep.publishedDate}</div>
              <div className="text-[9px] text-muted-foreground">{kindBadge(ep.kind)}</div>
              <div className="text-[9px]">
                {ep.status === "ready" && `${fmtTime(ep.durationSec)}`}
                {ep.status === "pending" && <span className="text-yellow-500">…gen</span>}
                {ep.status === "failed" && <span className="text-red-500">FAIL</span>}
              </div>
            </button>
          ))}
        </div>

        {/* Detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selected && (
            <div className="p-3 text-muted-foreground">Select an episode.</div>
          )}
          {selected && (
            <>
              <div className="border-b border-border px-3 py-2">
                <div className="text-[11px] font-bold text-primary" data-testid="text-episode-title">{selected.title}</div>
                <div className="text-[10px] text-muted-foreground" data-testid="text-episode-summary">{selected.summary || (selected.status === "pending" ? "Generating…" : selected.failureReason || "")}</div>
              </div>

              {selected.status === "ready" && audioBlobUrl && (
                <div className="px-3 py-2 border-b border-border">
                  <audio
                    ref={audioRef}
                    src={audioBlobUrl}
                    controls
                    preload="metadata"
                    className="w-full"
                    data-testid="audio-player"
                    onTimeUpdate={(e) => setCurrentTime((e.target as HTMLAudioElement).currentTime)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                  />
                  <div className="text-[10px] text-muted-foreground mt-1">
                    {fmtTime(currentTime)} / {fmtTime(selected.durationSec)} · {(selected.sizeBytes / 1024).toFixed(0)} KB
                    {isPlaying ? " · playing" : ""}
                  </div>
                </div>
              )}

              {selected.status === "failed" && (
                <div className="px-3 py-2 border-b border-border bg-red-950/30">
                  <div className="text-red-400 text-[10px]" data-testid="text-failure">FAILED: {selected.failureReason}</div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-3 py-2">
                <div className="text-[10px] text-muted-foreground mb-2">SEGMENTS</div>
                {segments.length === 0 && <div className="text-[10px] text-muted-foreground">No segments yet.</div>}
                {segments.map(seg => (
                  <div
                    key={seg.id}
                    data-testid={`segment-${seg.id}`}
                    className={`mb-2 border-l-2 pl-2 py-1 ${activeSegmentId === seg.id ? "border-primary bg-card" : "border-border/40"}`}
                  >
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => seekTo(seg.startSec)}
                        className="text-[10px] font-bold text-primary hover:underline"
                        data-testid={`seek-segment-${seg.id}`}
                      >
                        {fmtTime(seg.startSec)} — {seg.topic}
                      </button>
                      <div className="flex gap-1">
                        <button
                          data-testid={`feedback-up-${seg.id}`}
                          onClick={() => setFeedback(seg.id, seg.feedback === 1 ? 0 : 1)}
                          className={`px-1.5 text-[10px] border ${seg.feedback === 1 ? "border-green-500 text-green-500" : "border-border text-muted-foreground hover:text-foreground"}`}
                        >👍</button>
                        <button
                          data-testid={`feedback-down-${seg.id}`}
                          onClick={() => setFeedback(seg.id, seg.feedback === -1 ? 0 : -1)}
                          className={`px-1.5 text-[10px] border ${seg.feedback === -1 ? "border-red-500 text-red-500" : "border-border text-muted-foreground hover:text-foreground"}`}
                        >👎</button>
                      </div>
                    </div>
                    <div className="text-[10px] text-foreground/80 mt-1">{seg.text}</div>
                  </div>
                ))}
              </div>

              {/* Transcript (toggle with T) */}
              {showTranscript && (
                <div className="border-t border-border px-3 py-2 bg-card/40 max-h-32 overflow-y-auto" data-testid="text-transcript">
                  <div className="text-[10px] text-muted-foreground mb-1">TRANSCRIPT — T to hide</div>
                  <pre className="text-[10px] whitespace-pre-wrap text-foreground/80">{selected.scriptText}</pre>
                </div>
              )}

              {/* Your move */}
              <div className="border-t border-border px-3 py-2 bg-card">
                <div className="text-[10px] text-muted-foreground mb-1">
                  YOUR MOVE — M focus · D do · X drop · T transcript · J/K episodes
                </div>
                <div className="flex gap-1 items-center">
                  <select
                    data-testid="select-move-action"
                    value={moveAction}
                    onChange={e => { if (isMoveAction(e.target.value)) setMoveAction(e.target.value); }}
                    className="bg-background border border-border px-1 py-1 text-[10px]"
                  >
                    <option value="note">note</option>
                    <option value="do">do</option>
                    <option value="snooze">snooze</option>
                    <option value="drop">drop</option>
                  </select>
                  <input
                    id="standup-move-input"
                    data-testid="input-your-move"
                    value={moveText}
                    onChange={e => setMoveText(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") sendMove(); }}
                    placeholder={moveAction === "note" ? "note text..." : "optional context (resolves active segment)"}
                    className="flex-1 bg-background border border-border px-2 py-1 text-[10px] focus:outline-none focus:border-primary"
                  />
                  <button
                    data-testid="button-send-move"
                    onClick={() => sendMove()}
                    className="px-2 py-1 border border-border hover:border-primary text-[10px]"
                  >SEND</button>
                </div>
                {moveStatus && <div className="text-[9px] text-muted-foreground mt-1" data-testid="text-move-status">{moveStatus}</div>}
              </div>

              {/* Feed tokens */}
              <div className="border-t border-border px-3 py-2 bg-card/50">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] text-muted-foreground">PODCAST FEED TOKENS</div>
                  <button
                    data-testid="button-new-token"
                    onClick={newToken}
                    className="px-2 py-0.5 border border-border hover:border-primary text-[9px]"
                  >+ NEW</button>
                </div>
                {feedTokens.map(t => (
                  <div key={t.id} className="flex items-center justify-between py-0.5 text-[9px]" data-testid={`token-${t.id}`}>
                    <a
                      href={`${feedBaseUrl}/feed/standup.xml?token=${encodeURIComponent(t.token)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline truncate flex-1"
                    >
                      {t.label}: /feed/standup.xml?token={t.token.slice(0, 8)}…
                    </a>
                    <button
                      onClick={() => deleteToken(t.token)}
                      className="ml-2 text-red-400 hover:text-red-500"
                      data-testid={`delete-token-${t.id}`}
                    >×</button>
                  </div>
                ))}
                {feedTokens.length === 0 && <div className="text-[9px] text-muted-foreground">No tokens. Generate one to subscribe in your podcast app.</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
