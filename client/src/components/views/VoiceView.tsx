import React, { useState, useRef, useCallback, useEffect } from "react";
import { apiUrl } from "@/lib/queryClient";
import { useTvMode } from "@/hooks/use-tv-mode";

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
}

export default function VoiceView() {
  const { isTvMode } = useTvMode();
  const [messages, setMessages] = useState<Message[]>([
    { role: "system", text: "Voice command center ready. Press [V] or tap the mic to speak.", timestamp: Date.now() },
  ]);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const addMessage = useCallback((role: Message["role"], text: string) => {
    setMessages(prev => [...prev, { role, text, timestamp: Date.now() }]);
  }, []);

  const executeVoiceCommand = useCallback(async (text: string) => {
    setIsProcessing(true);
    addMessage("user", text);

    try {
      const res = await fetch(apiUrl("/api/voice-cmd"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, source: "voice-view", notify: false }),
      });
      const data = await res.json();

      if (data.ok) {
        const output = data.output || "";
        const trimmed = output.length > 500 ? output.slice(0, 500) + "..." : output;
        addMessage("assistant", `${data.label}${String.fromCharCode(10)}${trimmed}`);
      } else {
        addMessage("assistant", `Error: ${data.message || "Unknown error"}`);
      }
    } catch (e: any) {
      addMessage("assistant", `Connection error: ${e.message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [addMessage]);

  const startListening = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      addMessage("system", "Speech recognition not available in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
      setTranscript("");
    };

    recognition.onresult = (event: any) => {
      let finalTranscript = "";
      let interimTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }
      setTranscript(finalTranscript || interimTranscript);
      if (finalTranscript) {
        setIsListening(false);
        executeVoiceCommand(finalTranscript.trim());
      }
    };

    recognition.onerror = (event: any) => {
      setIsListening(false);
      if (event.error !== "aborted") {
        addMessage("system", `Mic error: ${event.error}`);
      }
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [addMessage, executeVoiceCommand]);

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
  }, []);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        toggleListening();
        return;
      }
      if (e.key === "j") {
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, messages.length - 1));
        return;
      }
      if (e.key === "k") {
        e.preventDefault();
        setSelectedIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "g") {
        e.preventDefault();
        setSelectedIdx(0);
        return;
      }
      if (e.key === "G") {
        e.preventDefault();
        setSelectedIdx(messages.length - 1);
        return;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [toggleListening, messages.length]);

  const roleIcon = (role: string) => {
    if (role === "user") return ">";
    if (role === "assistant") return "<";
    return "*";
  };

  const roleColor = (role: string) => {
    if (role === "user") return "text-[var(--crt-green,#00ff41)]";
    if (role === "assistant") return "text-[var(--crt-amber,#ffb000)]";
    return "text-muted-foreground";
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="voice-view">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="font-bold text-sm">VOICE</span>
        <button
          data-testid="button-mic-toggle"
          onClick={toggleListening}
          className={`px-3 py-1 font-mono text-sm border transition-all ${
            isListening
              ? "border-red-500 text-red-400 bg-red-500/10 animate-pulse"
              : isProcessing
              ? "border-yellow-500 text-yellow-400 bg-yellow-500/10"
              : "border-primary text-primary hover:bg-primary/10"
          }`}
        >
          {isListening ? "[ LISTENING... ]" : isProcessing ? "[ PROCESSING ]" : "[ V ] MIC"}
        </button>
      </div>

      {isListening && transcript && (
        <div className="px-3 py-2 bg-primary/5 border-b border-border text-sm text-muted-foreground italic">
          {transcript}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-1 py-1" data-testid="voice-messages">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            data-idx={idx}
            data-selected={selectedIdx === idx ? "true" : undefined}
            className={`px-2 py-1 text-xs whitespace-pre-wrap font-mono ${
              selectedIdx === idx ? "bg-primary/20" : ""
            }`}
          >
            <span className={`${roleColor(msg.role)} mr-1`}>{roleIcon(msg.role)}</span>
            <span className={roleColor(msg.role)}>{msg.text}</span>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-border text-[10px] text-muted-foreground">
        <span>[V] Toggle mic</span>
        <span className="mx-2">|</span>
        <span>Say: "check inbox" "agenda" "memo [text]" "search [query]" "snow" "standup"</span>
      </div>
    </div>
  );
}
