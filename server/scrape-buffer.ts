import type { EmailSummary, EmailDetail, ChatSummary, ChatMessage } from "./app-adapters";

interface ScrapeBuffer {
  emails: EmailSummary[];
  emailDetails: Map<number, EmailDetail>;
  teamsChats: ChatSummary[];
  teamsChatMessages: Map<number, ChatMessage[]>;
  lastEmailScrape: number | null;
  lastTeamsScrape: number | null;
}

const buffer: ScrapeBuffer = {
  emails: [],
  emailDetails: new Map(),
  teamsChats: [],
  teamsChatMessages: new Map(),
  lastEmailScrape: null,
  lastTeamsScrape: null,
};

export function setEmails(emails: EmailSummary[]): void {
  buffer.emails = emails;
  buffer.lastEmailScrape = Date.now();
}

export function getEmails(): EmailSummary[] {
  return buffer.emails;
}

export function setEmailDetail(index: number, detail: EmailDetail): void {
  buffer.emailDetails.set(index, detail);
}

export function getEmailDetail(index: number): EmailDetail | null {
  return buffer.emailDetails.get(index) || null;
}

export function setTeamsChats(chats: ChatSummary[]): void {
  buffer.teamsChats = chats;
  buffer.lastTeamsScrape = Date.now();
}

export function getTeamsChats(): ChatSummary[] {
  return buffer.teamsChats;
}

export function setTeamsChatMessages(index: number, messages: ChatMessage[]): void {
  buffer.teamsChatMessages.set(index, messages);
}

export function getTeamsChatMessages(index: number): ChatMessage[] {
  return buffer.teamsChatMessages.get(index) || [];
}

export function getFullBuffer() {
  return {
    emails: buffer.emails,
    emailDetails: Object.fromEntries(buffer.emailDetails),
    teamsChats: buffer.teamsChats,
    teamsChatMessages: Object.fromEntries(buffer.teamsChatMessages),
    lastEmailScrape: buffer.lastEmailScrape,
    lastTeamsScrape: buffer.lastTeamsScrape,
  };
}

export function clearBuffer(): void {
  buffer.emails = [];
  buffer.emailDetails.clear();
  buffer.teamsChats = [];
  buffer.teamsChatMessages.clear();
  buffer.lastEmailScrape = null;
  buffer.lastTeamsScrape = null;
}
