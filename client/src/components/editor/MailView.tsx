import React, { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
  useBridgeStatus, useScrapeEmails, useScrapeTeams, useEmailDetail, useTeamsChatMessages, useOrgCapture,
  useOpenClawStatus, useOpenClawCompiled, useOpenClawProposals, useOpenClawVersions,
  useAcceptProposal, useRejectProposal, useRestoreVersion, useRecompileOpenClaw,
} from "@/hooks/use-org-data";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";

type MailTab = "mail" | "teams" | "claw";

interface EmailSummary {
  index: number;
  from: string;
  subject: string;
  preview: string;
  date: string;
  unread: boolean;
}

interface EmailDetail {
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

interface ChatSummary {
  index: number;
  name: string;
  lastMessage: string;
  unread: boolean;
}

interface ChatMessage {
  sender: string;
  text: string;
  time: string;
}

export default function MailView() {
  const [tab, setTab] = useState<MailTab>("mail");
  const [expandedEmail, setExpandedEmail] = useState<number | null>(null);
  const [expandedChat, setExpandedChat] = useState<number | null>(null);
  const [replyText, setReplyText] = useState("");
  const [sendText, setSendText] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [cachedEmails, setCachedEmails] = useState<EmailSummary[]>([]);
  const [cachedChats, setCachedChats] = useState<ChatSummary[]>([]);

  const { data: bridgeStatus } = useBridgeStatus();
  const { data: emailData, refetch: refetchEmails, isFetching: emailsFetching } = useScrapeEmails();
  const { data: teamsData, refetch: refetchTeams, isFetching: teamsFetching } = useScrapeTeams();
  const { data: emailDetail, isFetching: detailFetching } = useEmailDetail(expandedEmail);
  const { data: chatMessages, isFetching: chatFetching } = useTeamsChatMessages(expandedChat);
  const captureMutation = useOrgCapture();

  const emails: EmailSummary[] = emailData?.emails || cachedEmails;
  const chats: ChatSummary[] = teamsData?.chats || cachedChats;
  const messages: ChatMessage[] = chatMessages?.messages || [];
  const detail: EmailDetail | null = emailDetail || null;

  useEffect(() => {
    if (emailData?.emails?.length) {
      setCachedEmails(emailData.emails);
      if (window.parent !== window) {
        window.parent.postMessage({ action: "orgcloud-scrape-complete" }, "*");
      }
    }
  }, [emailData]);

  useEffect(() => {
    if (teamsData?.chats?.length) {
      setCachedChats(teamsData.chats);
      if (window.parent !== window) {
        window.parent.postMessage({ action: "orgcloud-scrape-complete" }, "*");
      }
    }
  }, [teamsData]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.action === "orgcloud-scrape-cache") {
        const { emails: cachedE, chats: cachedC } = event.data;
        if (cachedE?.length) setCachedEmails(cachedE);
        if (cachedC?.length) setCachedChats(cachedC);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const isRunning = bridgeStatus?.running ?? false;
  const authState = bridgeStatus?.authState ?? "unknown";
  const needsLogin = authState === "login_required" || authState === "expired";

  const statusIcon = isRunning
    ? needsLogin ? "[!]" : "[●]"
    : "[○]";
  const statusColor = isRunning
    ? needsLogin ? "text-org-todo" : "text-foreground"
    : "text-muted-foreground";

  const handleLogin = useCallback(async () => {
    setLoginLoading(true);
    try {
      const service = tab === "teams" ? "teams" : "outlook";
      await apiRequest("POST", "/api/browser/login", { service });
    } catch (err) {
      console.error("Login failed:", err);
    } finally {
      setLoginLoading(false);
    }
  }, [tab]);

  const handleLoginDone = useCallback(async () => {
    try {
      await apiRequest("POST", "/api/browser/login/done");
      queryClient.invalidateQueries({ queryKey: ["/api/browser/status"] });
    } catch {}
  }, []);

  const handleScrape = useCallback(() => {
    if (tab === "mail") {
      refetchEmails();
    } else {
      refetchTeams();
    }
  }, [tab, refetchEmails, refetchTeams]);

  const handleFileToOrg = useCallback((title: string, body: string) => {
    captureMutation.mutate({
      fileName: "inbox.org",
      title,
      template: "note",
      body,
    });
  }, [captureMutation]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim()) return;
    try {
      await apiRequest("POST", "/api/mail/reply", { text: replyText });
      setReplyText("");
    } catch {}
  }, [replyText]);

  const handleSendTeams = useCallback(async () => {
    if (!sendText.trim()) return;
    try {
      await apiRequest("POST", "/api/teams/send", { text: sendText });
      setSendText("");
      if (expandedChat !== null) {
        queryClient.invalidateQueries({ queryKey: ["/api/teams/chat", expandedChat] });
      }
    } catch {}
  }, [sendText, expandedChat]);

  const isFetching = tab === "mail" ? emailsFetching : teamsFetching;

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="mail-view">
      <div className="flex items-center gap-0 border-b border-border px-2 py-1 bg-card shrink-0">
        <span className="text-foreground mr-1">⌘</span>
        <span className="text-foreground font-bold mr-2 phosphor-glow text-xs">Control</span>
        <button
          onClick={() => setTab("mail")}
          data-testid="tab-mail"
          className={cn(
            "px-2 py-0.5 text-xs font-bold transition-colors",
            tab === "mail" ? "text-foreground phosphor-glow" : "text-muted-foreground hover:text-foreground"
          )}
        >
          [mail]
        </button>
        <button
          onClick={() => setTab("teams")}
          data-testid="tab-teams"
          className={cn(
            "px-2 py-0.5 text-xs font-bold transition-colors",
            tab === "teams" ? "text-foreground phosphor-glow" : "text-muted-foreground hover:text-foreground"
          )}
        >
          [teams]
        </button>
        <button
          onClick={() => setTab("claw")}
          data-testid="tab-claw"
          className={cn(
            "px-2 py-0.5 text-xs font-bold transition-colors",
            tab === "claw" ? "text-foreground phosphor-glow" : "text-muted-foreground hover:text-foreground"
          )}
        >
          [claw]
        </button>

        <div className="flex-1" />

        <span className={cn("text-xs font-bold mr-2", statusColor)} data-testid="bridge-status">
          {statusIcon}
        </span>

        {needsLogin && !loginLoading && (
          <button
            onClick={handleLogin}
            data-testid="button-login"
            className="text-xs text-org-todo hover:text-foreground font-bold mr-2"
          >
            [login]
          </button>
        )}

        {bridgeStatus?.loginInProgress && (
          <button
            onClick={handleLoginDone}
            data-testid="button-login-done"
            className="text-xs text-foreground hover:text-org-todo font-bold mr-2"
          >
            [done]
          </button>
        )}

        <button
          onClick={handleScrape}
          disabled={isFetching}
          data-testid="button-scrape"
          className={cn(
            "text-xs font-bold transition-colors",
            isFetching ? "text-muted-foreground animate-pulse" : "text-foreground hover:text-org-todo"
          )}
        >
          [↻]
        </button>
      </div>

      <div className="flex-1 overflow-y-auto text-xs leading-relaxed">
        {tab === "mail" ? (
          <MailList
            emails={emails}
            expandedEmail={expandedEmail}
            onExpand={setExpandedEmail}
            detail={detail}
            detailFetching={detailFetching}
            onFileToOrg={handleFileToOrg}
            replyText={replyText}
            onReplyChange={setReplyText}
            onReply={handleReply}
            isFetching={emailsFetching}
          />
        ) : tab === "teams" ? (
          <TeamsList
            chats={chats}
            expandedChat={expandedChat}
            onExpand={setExpandedChat}
            messages={messages}
            chatFetching={chatFetching}
            onFileToOrg={handleFileToOrg}
            sendText={sendText}
            onSendChange={setSendText}
            onSend={handleSendTeams}
            isFetching={teamsFetching}
          />
        ) : (
          <ClawPanel />
        )}
      </div>
    </div>
  );
}

function MailList({
  emails, expandedEmail, onExpand, detail, detailFetching,
  onFileToOrg, replyText, onReplyChange, onReply, isFetching,
}: {
  emails: EmailSummary[];
  expandedEmail: number | null;
  onExpand: (idx: number | null) => void;
  detail: EmailDetail | null;
  detailFetching: boolean;
  onFileToOrg: (title: string, body: string) => void;
  replyText: string;
  onReplyChange: (t: string) => void;
  onReply: () => void;
  isFetching: boolean;
}) {
  if (isFetching && emails.length === 0) {
    return <div className="p-3 text-muted-foreground">scraping outlook...</div>;
  }

  if (emails.length === 0) {
    return (
      <div className="p-3 text-muted-foreground">
        <div>no emails loaded</div>
        <div className="mt-1">press [↻] to scrape or [login] to authenticate</div>
      </div>
    );
  }

  return (
    <div>
      {emails.map((email) => {
        const isExpanded = expandedEmail === email.index;
        return (
          <div key={email.index} className="border-b border-border" data-testid={`email-item-${email.index}`}>
            <button
              onClick={() => onExpand(isExpanded ? null : email.index)}
              className="w-full text-left px-2 py-1.5 hover:bg-muted/30 transition-colors"
              data-testid={`button-expand-email-${email.index}`}
            >
              <div className="flex items-start gap-1">
                <span className="text-muted-foreground shrink-0 w-3">
                  {isExpanded ? "▾" : "▸"}
                </span>
                <span className={cn(
                  "shrink-0 w-1",
                  email.unread ? "text-org-todo" : "text-muted-foreground"
                )}>
                  {email.unread ? "●" : " "}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className={cn(
                      "font-bold truncate",
                      email.unread ? "text-foreground" : "text-muted-foreground"
                    )}>
                      {email.from}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-[10px]">
                      {email.date}
                    </span>
                  </div>
                  <div className="text-foreground truncate">{email.subject}</div>
                  {!isExpanded && email.preview && (
                    <div className="text-muted-foreground truncate">{email.preview}</div>
                  )}
                </div>
              </div>
            </button>

            {isExpanded && (
              <div className="px-4 py-2 bg-muted/10 border-t border-border/50">
                {detailFetching ? (
                  <div className="text-muted-foreground">loading...</div>
                ) : detail ? (
                  <div>
                    <div className="text-muted-foreground mb-1">
                      From: {detail.from}
                      {detail.to && <span> | To: {detail.to}</span>}
                      {detail.date && <span> | {detail.date}</span>}
                    </div>
                    {detail.subject && (
                      <div className="text-foreground font-bold mb-1">{detail.subject}</div>
                    )}
                    <pre className="text-foreground whitespace-pre-wrap font-mono text-xs leading-relaxed max-h-60 overflow-y-auto">
                      {detail.body}
                    </pre>
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        onClick={() => onFileToOrg(
                          `Email: ${email.subject}`,
                          `From: ${detail.from}\nDate: ${detail.date}\n\n${detail.body?.substring(0, 500)}`
                        )}
                        data-testid={`button-file-email-${email.index}`}
                        className="text-muted-foreground hover:text-foreground font-bold"
                      >
                        [→org]
                      </button>
                      <div className="flex-1 flex items-center gap-1">
                        <input
                          type="text"
                          value={replyText}
                          onChange={(e) => onReplyChange(e.target.value)}
                          placeholder="reply..."
                          data-testid={`input-reply-${email.index}`}
                          className="flex-1 bg-transparent border border-border px-1 py-0.5 text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground"
                          onKeyDown={(e) => { if (e.key === "Enter") onReply(); }}
                        />
                        <button
                          onClick={onReply}
                          data-testid={`button-reply-${email.index}`}
                          className="text-muted-foreground hover:text-foreground font-bold"
                        >
                          [→]
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground">could not load email</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ClawPanel() {
  const { data: status } = useOpenClawStatus();
  const { data: compiled } = useOpenClawCompiled(status?.exists ?? false);
  const { data: proposals } = useOpenClawProposals();
  const { data: versions } = useOpenClawVersions();
  const acceptMutation = useAcceptProposal();
  const rejectMutation = useRejectProposal();
  const restoreMutation = useRestoreVersion();
  const recompileMutation = useRecompileOpenClaw();

  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [expandedProgram, setExpandedProgram] = useState<string | null>(null);
  const [expandedProposal, setExpandedProposal] = useState<number | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  if (!status?.exists) {
    return (
      <div className="p-3 text-muted-foreground" data-testid="claw-empty">
        <div>openclaw.org not found</div>
        <div className="mt-1">seed the database or import your local OpenClaw config</div>
      </div>
    );
  }

  const pendingCount = proposals?.length || 0;
  const syncTime = status.lastSync
    ? new Date(status.lastSync.timestamp).toLocaleString()
    : "never";

  return (
    <div className="p-2 space-y-3" data-testid="claw-panel">
      <div className="flex items-center gap-2 text-muted-foreground" data-testid="claw-status-bar">
        <span>skills:{status.skillCount || 0}</span>
        <span>programs:{status.programCount || 0}</span>
        <span>errors:{status.errorCount || 0}</span>
        {pendingCount > 0 && (
          <span className="text-org-todo font-bold">pending:{pendingCount}</span>
        )}
        <span className="flex-1" />
        <span>sync:{syncTime}</span>
        <button
          onClick={() => recompileMutation.mutate()}
          data-testid="button-recompile"
          className="text-foreground hover:text-org-todo font-bold"
        >
          [↻]
        </button>
      </div>

      {pendingCount > 0 && proposals && (
        <div data-testid="claw-proposals">
          <div className="text-foreground font-bold mb-1">PROPOSALS</div>
          {proposals.map((p) => {
            const isExpanded = expandedProposal === p.id;
            return (
              <div key={p.id} className="border-b border-border/50" data-testid={`proposal-item-${p.id}`}>
                <button
                  onClick={() => setExpandedProposal(isExpanded ? null : p.id)}
                  className="w-full text-left px-1 py-1 hover:bg-muted/30"
                  data-testid={`button-expand-proposal-${p.id}`}
                >
                  <span className="text-muted-foreground">{isExpanded ? "▾" : "▸"} </span>
                  <span className="text-org-todo">[?] </span>
                  <span className="text-foreground">{p.section}{p.targetName ? `/${p.targetName}` : ""}</span>
                  <span className="text-muted-foreground"> — {p.reason.substring(0, 60)}{p.reason.length > 60 ? "..." : ""}</span>
                </button>
                {isExpanded && (
                  <div className="px-3 py-2 bg-muted/10">
                    <div className="text-muted-foreground mb-1">current:</div>
                    <pre className="text-foreground whitespace-pre-wrap max-h-24 overflow-y-auto mb-2 text-[10px]">{p.currentContent.substring(0, 500)}</pre>
                    <div className="text-muted-foreground mb-1">proposed:</div>
                    <pre className="text-foreground whitespace-pre-wrap max-h-24 overflow-y-auto mb-2 text-[10px]">{p.proposedContent.substring(0, 500)}</pre>
                    <div className="flex gap-2">
                      <button
                        onClick={() => acceptMutation.mutate(p.id)}
                        data-testid={`button-accept-${p.id}`}
                        className="text-foreground hover:text-org-todo font-bold"
                      >
                        [✓]
                      </button>
                      <button
                        onClick={() => rejectMutation.mutate(p.id)}
                        data-testid={`button-reject-${p.id}`}
                        className="text-muted-foreground hover:text-org-todo font-bold"
                      >
                        [×]
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {compiled && (
        <>
          <div data-testid="claw-soul">
            <div className="text-foreground font-bold mb-1">SOUL</div>
            <div className="text-muted-foreground px-1">
              {compiled.soul ? compiled.soul.substring(0, 200) + (compiled.soul.length > 200 ? "..." : "") : "empty"}
            </div>
          </div>

          <div data-testid="claw-skills">
            <div className="text-foreground font-bold mb-1">SKILLS ({compiled.skills.length})</div>
            {compiled.skills.map((skill) => {
              const isExpanded = expandedSkill === skill.name;
              const descMatch = skill.content.match(/description:\s*"?(.+?)(?:"|$)/im);
              const desc = descMatch?.[1] || "";
              return (
                <div key={skill.name} data-testid={`skill-item-${skill.name}`}>
                  <button
                    onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
                    className="w-full text-left px-1 py-0.5 hover:bg-muted/30"
                    data-testid={`button-expand-skill-${skill.name}`}
                  >
                    <span className="text-muted-foreground">{isExpanded ? "▾" : "▸"} </span>
                    <span className="text-foreground">{skill.name}</span>
                    {desc && <span className="text-muted-foreground"> — {desc.substring(0, 50)}</span>}
                  </button>
                  {isExpanded && (
                    <pre className="px-3 py-1 text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto text-[10px]">
                      {skill.content}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>

          <div data-testid="claw-programs">
            <div className="text-foreground font-bold mb-1">PROGRAMS ({compiled.programs.length})</div>
            {compiled.programs.map((prog) => {
              const isExpanded = expandedProgram === prog.name;
              const resultLines = prog.results
                .split("\n")
                .filter(l => l.trim().startsWith("|") && !l.includes("---"))
                .slice(-6);
              return (
                <div key={prog.name} data-testid={`program-item-${prog.name}`}>
                  <button
                    onClick={() => setExpandedProgram(isExpanded ? null : prog.name)}
                    className="w-full text-left px-1 py-0.5 hover:bg-muted/30"
                    data-testid={`button-expand-program-${prog.name}`}
                  >
                    <span className={prog.active ? "text-foreground" : "text-muted-foreground"}>
                      {prog.active ? "[●]" : "[○]"}{" "}
                    </span>
                    <span className="text-foreground">{prog.name}</span>
                    <span className="text-muted-foreground"> ({prog.status})</span>
                    {prog.scheduledRaw && (
                      <span className="text-muted-foreground"> {prog.schedule}</span>
                    )}
                  </button>
                  {isExpanded && (
                    <div className="px-3 py-1 bg-muted/10">
                      <pre className="text-muted-foreground whitespace-pre-wrap max-h-20 overflow-y-auto text-[10px] mb-1">
                        {prog.instructions.substring(0, 300)}
                      </pre>
                      {resultLines.length > 1 && (
                        <div className="mt-1">
                          <div className="text-muted-foreground text-[10px]">results:</div>
                          <pre className="text-foreground whitespace-pre text-[10px]">
                            {resultLines.join("\n")}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {compiled.config && (
            <div data-testid="claw-config">
              <div className="text-foreground font-bold mb-1">CONFIG</div>
              <pre className="text-muted-foreground px-1 whitespace-pre-wrap text-[10px] max-h-20 overflow-y-auto">
                {JSON.stringify(compiled.config, null, 2)}
              </pre>
            </div>
          )}

          {compiled.errors.length > 0 && (
            <div data-testid="claw-errors">
              <div className="text-org-todo font-bold mb-1">ERRORS</div>
              {compiled.errors.map((err, i) => (
                <div key={i} className="text-org-todo px-1">{err}</div>
              ))}
            </div>
          )}
        </>
      )}

      <div data-testid="claw-versions">
        <button
          onClick={() => setShowVersions(!showVersions)}
          className="text-foreground font-bold hover:text-org-todo"
          data-testid="button-toggle-versions"
        >
          {showVersions ? "▾" : "▸"} VERSIONS ({versions?.length || 0})
        </button>
        {showVersions && versions && (
          <div className="mt-1">
            {versions.slice(0, 10).map((v) => (
              <div key={v.id} className="flex items-center gap-2 px-1 py-0.5" data-testid={`version-item-${v.id}`}>
                <button
                  onClick={() => restoreMutation.mutate(v.id)}
                  data-testid={`button-restore-${v.id}`}
                  className="text-muted-foreground hover:text-foreground font-bold"
                >
                  [↩]
                </button>
                <span className="text-foreground">{v.label}</span>
                <span className="text-muted-foreground text-[10px]">{new Date(v.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TeamsList({
  chats, expandedChat, onExpand, messages, chatFetching,
  onFileToOrg, sendText, onSendChange, onSend, isFetching,
}: {
  chats: ChatSummary[];
  expandedChat: number | null;
  onExpand: (idx: number | null) => void;
  messages: ChatMessage[];
  chatFetching: boolean;
  onFileToOrg: (title: string, body: string) => void;
  sendText: string;
  onSendChange: (t: string) => void;
  onSend: () => void;
  isFetching: boolean;
}) {
  if (isFetching && chats.length === 0) {
    return <div className="p-3 text-muted-foreground">scraping teams...</div>;
  }

  if (chats.length === 0) {
    return (
      <div className="p-3 text-muted-foreground">
        <div>no chats loaded</div>
        <div className="mt-1">press [↻] to scrape or [login] to authenticate</div>
      </div>
    );
  }

  return (
    <div>
      {chats.map((chat) => {
        const isExpanded = expandedChat === chat.index;
        return (
          <div key={chat.index} className="border-b border-border" data-testid={`chat-item-${chat.index}`}>
            <button
              onClick={() => onExpand(isExpanded ? null : chat.index)}
              className="w-full text-left px-2 py-1.5 hover:bg-muted/30 transition-colors"
              data-testid={`button-expand-chat-${chat.index}`}
            >
              <div className="flex items-start gap-1">
                <span className="text-muted-foreground shrink-0 w-3">
                  {isExpanded ? "▾" : "▸"}
                </span>
                <span className={cn(
                  "shrink-0 w-1",
                  chat.unread ? "text-org-todo" : "text-muted-foreground"
                )}>
                  {chat.unread ? "●" : " "}
                </span>
                <div className="flex-1 min-w-0">
                  <span className={cn(
                    "font-bold",
                    chat.unread ? "text-foreground" : "text-muted-foreground"
                  )}>
                    {chat.name}
                  </span>
                  {!isExpanded && chat.lastMessage && (
                    <div className="text-muted-foreground truncate">{chat.lastMessage}</div>
                  )}
                </div>
              </div>
            </button>

            {isExpanded && (
              <div className="px-4 py-2 bg-muted/10 border-t border-border/50">
                {chatFetching ? (
                  <div className="text-muted-foreground">loading messages...</div>
                ) : messages.length > 0 ? (
                  <div>
                    <div className="max-h-48 overflow-y-auto space-y-1 mb-2">
                      {messages.map((msg, i) => (
                        <div key={i} className="flex gap-1">
                          <span className="text-muted-foreground shrink-0 font-bold">
                            {msg.sender}
                          </span>
                          {msg.time && (
                            <span className="text-muted-foreground shrink-0 text-[10px]">
                              {msg.time}
                            </span>
                          )}
                          <span className="text-foreground">{msg.text}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onFileToOrg(
                          `Teams: ${chat.name}`,
                          messages.map(m => `${m.sender}: ${m.text}`).join("\n").substring(0, 500)
                        )}
                        data-testid={`button-file-chat-${chat.index}`}
                        className="text-muted-foreground hover:text-foreground font-bold"
                      >
                        [→org]
                      </button>
                      <div className="flex-1 flex items-center gap-1">
                        <input
                          type="text"
                          value={sendText}
                          onChange={(e) => onSendChange(e.target.value)}
                          placeholder="send..."
                          data-testid={`input-send-${chat.index}`}
                          className="flex-1 bg-transparent border border-border px-1 py-0.5 text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground"
                          onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
                        />
                        <button
                          onClick={onSend}
                          data-testid={`button-send-${chat.index}`}
                          className="text-muted-foreground hover:text-foreground font-bold"
                        >
                          [→]
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground">no messages loaded</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
