import {
  openPage,
  getPage,
  getPageText,
  clickElement,
  clickByText,
  typeInPage,
  pressKey,
  waitForPage,
  getPageContent,
} from "./browser-bridge";

function safeEvaluate<T>(page: any, fn: (...args: any[]) => T, ...args: any[]): Promise<T> {
  const fnStr = fn.toString();
  const wrapper = `(function(__name) { return (${fnStr})(${args.map(a => JSON.stringify(a)).join(', ')}); })(function(t){return t})`;
  return page.evaluate(wrapper);
}

export interface EmailSummary {
  index: number;
  from: string;
  subject: string;
  preview: string;
  date: string;
  unread: boolean;
}

export interface EmailDetail {
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
}

export interface ChatSummary {
  index: number;
  name: string;
  lastMessage: string;
  unread: boolean;
}

export interface ChatMessage {
  sender: string;
  text: string;
  time: string;
}

const OUTLOOK_URL = "https://outlook.cloud.microsoft/mail/inbox";
const TEAMS_URL = "https://teams.microsoft.com/_#/conversations";

const SMART_WAIT_TIMEOUT = 5000;
const SMART_WAIT_POLL = 300;

async function smartWaitForSelector(page: any, selectors: string[], fallbackMs: number = 1500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < SMART_WAIT_TIMEOUT) {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) return true;
      } catch {}
    }
    await page.waitForTimeout(SMART_WAIT_POLL);
  }
  if (fallbackMs > 0) await page.waitForTimeout(fallbackMs);
  return false;
}

export async function openOutlook(): Promise<{ success: boolean; error?: string }> {
  return await openPage("outlook", OUTLOOK_URL);
}

export async function openTeams(): Promise<{ success: boolean; error?: string }> {
  return await openPage("teams", TEAMS_URL);
}

async function scrollToLoadMore(page: any, containerSelector: string, maxScrolls: number = 3): Promise<void> {
  try {
    for (let i = 0; i < maxScrolls; i++) {
      const scrolled = await safeEvaluate(page, (sel: string) => {
        const container = document.querySelector(sel);
        if (!container) return false;
        const el = container as HTMLElement;
        const before = el.scrollTop;
        el.scrollTop = el.scrollHeight;
        return el.scrollTop > before;
      }, containerSelector);
      if (!scrolled) break;
      await page.waitForTimeout(800);
    }
  } catch {}
}

async function scrapeOutlookPage(page: any): Promise<Array<{
  index: number; from: string; subject: string; preview: string; unread: boolean; date: string;
}>> {
  return await safeEvaluate(page, () => {
    const results: Array<{
      index: number; from: string; subject: string; preview: string; unread: boolean; date: string;
    }> = [];

    const NON_EMAIL_PATTERNS = /^(Notes|RSS Feeds|Search Folders|Drafts|Sent Items|Deleted Items|Junk Email|Archive|Conversation History|Outbox|Clutter|Focused|Other|Filter|Sort|Favorites|Folders|Groups|Go to Groups|Navigation pane|Inbox|selected|unread|items?|messages?)$/i;
    const FOLDER_NAME_PATTERNS = /^(Notes|RSS Feeds|Search Folders|Drafts|Sent Items|Deleted Items|Junk Email|Archive|Conversation History|Outbox|Clutter|Inbox|Favorites|Go to Groups|Navigation pane)$/i;
    const PURE_NUMBER = /^\d+$/;
    const DATE_TIME_PATTERN = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b.*\d{1,2}[:/]\d{2}/i;
    const SHORT_DATE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
    const TIME_ONLY = /^\d{1,2}:\d{2}\s*(AM|PM)$/i;
    const RELATIVE_DATE = /^(Yesterday|Today|\d+\s+(minutes?|hours?|days?|weeks?)\s+ago)$/i;

    const stripIconChars = (text: string): string => {
      return text.replace(/[\uE000-\uF8FF]/g, '').replace(/  +/g, ' ').trim();
    };

    const isFolderEntry = (text: string): boolean => {
      const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      const cleanLines = lines.map(l => stripIconChars(l)).filter(l => l.length > 0);
      if (cleanLines.length === 0) return true;
      if (cleanLines.length <= 3) {
        for (const line of cleanLines) {
          if (FOLDER_NAME_PATTERNS.test(line)) return true;
        }
        const hasFolder = cleanLines.some(l => FOLDER_NAME_PATTERNS.test(l));
        const hasNumber = cleanLines.some(l => PURE_NUMBER.test(l));
        const hasStatus = cleanLines.some(l => /^(unread|items?|selected|messages?)$/i.test(l));
        if (hasFolder || (hasNumber && hasStatus)) return true;
        if (cleanLines.length === 1 && PURE_NUMBER.test(cleanLines[0])) return true;
      }
      return false;
    };

    const findMessageListContainer = (): Element | null => {
      const msgListByLabel = document.querySelector('[aria-label*="Message list"]') ||
        document.querySelector('[aria-label*="message list"]') ||
        document.querySelector('[aria-label*="Inbox"]');
      if (msgListByLabel) {
        const convItems = msgListByLabel.querySelectorAll("[data-convid]");
        if (convItems.length > 0) return msgListByLabel;
        const options = msgListByLabel.querySelectorAll('[role="option"], [role="listitem"]');
        if (options.length > 0) return msgListByLabel;
      }

      const convItems = document.querySelectorAll("[data-convid]");
      if (convItems.length > 0) {
        let best: Element | null = null;
        let bestCount = Infinity;
        let parent = convItems[0].parentElement;
        while (parent && parent !== document.body && parent !== document.documentElement) {
          const count = parent.querySelectorAll("[data-convid]").length;
          if (count >= Math.min(convItems.length, 3)) {
            const childCount = parent.children.length;
            if (childCount < bestCount) {
              best = parent;
              bestCount = childCount;
            }
          }
          parent = parent.parentElement;
        }
        if (best) return best;
      }

      const listboxes = document.querySelectorAll('[role="listbox"]');
      for (let i = 0; i < listboxes.length; i++) {
        const lb = listboxes[i];
        const navPane = lb.closest('[aria-label*="Navigation"]') ||
          lb.closest('[aria-label*="Folder"]') ||
          lb.closest('[role="navigation"]');
        if (navPane) continue;
        const options = lb.querySelectorAll('[role="option"]');
        if (options.length >= 3) return lb;
      }

      return null;
    };

    const extractFromAriaLabel = (label: string): { from: string; subject: string; preview: string; date: string; unread: boolean } | null => {
      const isUnread = /\bunread\b/i.test(label);
      const cleanLabel = label.replace(/\bunread\b/i, "").replace(/,\s*,/g, ",").trim();

      const parts = cleanLabel.split(/,\s*/);
      if (parts.length >= 2) {
        let from = parts[0].trim();
        let date = "";
        const textParts: string[] = [];

        from = from.replace(/^(From:\s*|Sender:\s*)/i, "");

        for (let i = 1; i < parts.length; i++) {
          const part = parts[i].trim();
          if (!part) continue;
          if (DATE_TIME_PATTERN.test(part) || SHORT_DATE.test(part) || RELATIVE_DATE.test(part) || TIME_ONLY.test(part)) {
            date = part;
          } else {
            textParts.push(part);
          }
        }

        const subject = (textParts[0] || "").substring(0, 60);
        const preview = (textParts.slice(1).join(", ") || "").substring(0, 80);

        if (from && from.length >= 2) {
          return { from: from.substring(0, 40), subject, preview, date, unread: isUnread };
        }
      }

      return null;
    };

    const extractFromDOM = (el: HTMLElement): { from: string; subject: string; preview: string; date: string } | null => {
      let from = "";
      let subject = "";

      const headingEl = el.querySelector('[role="heading"]');
      if (headingEl) {
        subject = (headingEl as HTMLElement).innerText?.trim() || "";
      }

      const titleEls = el.querySelectorAll("[title]");
      for (let i = 0; i < titleEls.length; i++) {
        const titleVal = titleEls[i].getAttribute("title") || "";
        if (titleVal && titleVal.length >= 2 && titleVal !== subject && !DATE_TIME_PATTERN.test(titleVal) && !SHORT_DATE.test(titleVal) && !TIME_ONLY.test(titleVal) && !RELATIVE_DATE.test(titleVal)) {
          from = titleVal.substring(0, 40);
          break;
        }
      }

      if (from && subject) {
        const allText = el.innerText?.trim() || "";
        const lines = allText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        let date = "";
        let preview = "";
        for (const line of lines) {
          if (line === from || line === subject) continue;
          if (PURE_NUMBER.test(line)) continue;
          if (!date && (DATE_TIME_PATTERN.test(line) || SHORT_DATE.test(line) || TIME_ONLY.test(line) || RELATIVE_DATE.test(line))) {
            date = line;
            continue;
          }
          if (!preview && line.length > 5 && line !== from && line !== subject) {
            preview = line.substring(0, 80);
          }
        }
        return { from, subject: subject.substring(0, 60), preview, date };
      }
      return null;
    };

    const extractFromText = (el: HTMLElement): { from: string; subject: string; preview: string; date: string } | null => {
      const text = el.innerText?.trim() || "";
      if (!text || text.length < 5) return null;

      const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length < 2) return null;

      const cleanLines: string[] = [];
      let date = "";
      for (const line of lines) {
        if (NON_EMAIL_PATTERNS.test(line)) return null;
        if (PURE_NUMBER.test(line)) continue;

        if (!date && (DATE_TIME_PATTERN.test(line) || SHORT_DATE.test(line) || TIME_ONLY.test(line) || RELATIVE_DATE.test(line))) {
          date = line;
          continue;
        }
        cleanLines.push(line);
      }

      if (cleanLines.length < 2) return null;

      const from = cleanLines[0].substring(0, 40);

      let senderNames = from;
      if (cleanLines.length > 1 && cleanLines[1].includes(";")) {
        senderNames = from;
        cleanLines.splice(1, 1);
      }

      const subject = (cleanLines[1] || "").substring(0, 60);
      const preview = (cleanLines[2] || "").substring(0, 80);

      return { from: senderNames, subject, preview, date };
    };

    const container = findMessageListContainer();
    const candidates: HTMLElement[] = [];

    if (container) {
      const convItems = container.querySelectorAll("[data-convid]");
      if (convItems.length > 0) {
        convItems.forEach(el => candidates.push(el as HTMLElement));
      } else {
        const options = container.querySelectorAll('[role="option"], [role="listitem"]');
        options.forEach(el => candidates.push(el as HTMLElement));
      }
    }

    if (candidates.length === 0) {
      const convItems = document.querySelectorAll("[data-convid]");
      convItems.forEach(el => candidates.push(el as HTMLElement));
    }

    if (candidates.length === 0) {
      const allOptions = document.querySelectorAll(
        '[role="listbox"] [role="option"], div[data-is-focusable="true"][role="option"]'
      );
      allOptions.forEach(el => candidates.push(el as HTMLElement));
    }

    const seen = new Set<Node>();
    let idx = 0;

    for (const el of candidates) {
      if (idx >= 30) break;

      let dominated = false;
      seen.forEach(s => { if (s.contains(el) || el.contains(s)) dominated = true; });
      if (dominated) continue;
      seen.add(el);

      const rawText = el.innerText?.trim() || "";
      const fullText = stripIconChars(rawText);
      if (!fullText || fullText.length < 5) continue;
      if (NON_EMAIL_PATTERNS.test(fullText)) continue;
      if (PURE_NUMBER.test(fullText)) continue;
      if (isFolderEntry(rawText)) continue;

      const ariaLabel = el.getAttribute("aria-label") || "";
      let isUnread =
        /\bunread\b/i.test(ariaLabel) ||
        el.classList.toString().toLowerCase().includes("unread") ||
        el.querySelector('[class*="nread"]') !== null ||
        el.querySelector('[class*="Unread"]') !== null;

      let from = "Unknown";
      let subject = "(no subject)";
      let preview = "";
      let date = "";

      if (ariaLabel.length > 10) {
        const parsed = extractFromAriaLabel(ariaLabel);
        if (parsed) {
          from = parsed.from;
          subject = parsed.subject;
          preview = parsed.preview;
          date = parsed.date;
          if (parsed.unread) isUnread = true;
        }
      }

      if (from === "Unknown" || subject === "(no subject)") {
        const domParsed = extractFromDOM(el);
        if (domParsed) {
          if (from === "Unknown") from = domParsed.from;
          if (subject === "(no subject)") subject = domParsed.subject;
          if (!preview) preview = domParsed.preview;
          if (!date) date = domParsed.date;
        }
      }

      if (from === "Unknown" || subject === "(no subject)") {
        const textParsed = extractFromText(el);
        if (textParsed) {
          if (from === "Unknown") from = textParsed.from;
          if (subject === "(no subject)") subject = textParsed.subject;
          if (!preview) preview = textParsed.preview;
          if (!date) date = textParsed.date;
        } else if (from === "Unknown") {
          continue;
        }
      }

      if (from.length < 2) continue;

      idx++;
      results.push({
        index: idx,
        from,
        subject,
        preview,
        unread: isUnread,
        date,
      });
    }

    return results;
  });
}

async function ensureOutlookOnInbox(page: any): Promise<void> {
  try {
    const url = page.url();
    const isOnInbox = url.includes("/mail/inbox") || url.includes("/mail/");
    if (!isOnInbox && url.includes("outlook")) {
      console.log("[outlook-adapter] Not on inbox, navigating...");
      await page.goto(OUTLOOK_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(2000);
    }
  } catch (err: any) {
    console.error("[outlook-adapter] Inbox navigation error:", err.message);
  }
}

export async function getOutlookEmails(): Promise<EmailSummary[]> {
  const page = getPage("outlook");
  if (!page) return [];

  try {
    await ensureOutlookOnInbox(page);

    await smartWaitForSelector(page, [
      '[data-convid]',
      '[aria-label*="Message list"]',
      '[role="listbox"] [role="option"]',
    ]);

    await scrollToLoadMore(page, '[aria-label*="Message list"], [role="listbox"]', 3);

    let emails = await scrapeOutlookPage(page);

    if (emails.length === 0) {
      console.log("[outlook-adapter] First scrape returned 0 results, retrying in 1.5s...");
      await page.waitForTimeout(1500);
      emails = await scrapeOutlookPage(page);
    }

    if (emails.length === 0) {
      const url = page.url();
      const title = await page.title();
      console.log(`[outlook-adapter] Empty scrape. URL: ${url}, Title: ${title}`);
    }

    return emails.map(e => ({
      index: e.index,
      from: e.from,
      subject: e.subject,
      preview: e.preview,
      date: e.date,
      unread: e.unread,
    }));
  } catch (err: any) {
    console.error("[outlook-adapter] Scrape error:", err.message);
    return [];
  }
}

export async function readOutlookEmail(index: number): Promise<EmailDetail | null> {
  const page = getPage("outlook");
  if (!page) return null;

  try {
    let items = await page.$$("[data-convid]");
    if (items.length === 0) {
      items = await page.$$('[role="listbox"] [role="option"], div[data-is-focusable="true"][role="option"]');
    }

    const targetIdx = Math.max(0, index - 1);
    if (targetIdx >= items.length) return null;

    await items[targetIdx].click();

    await smartWaitForSelector(page, [
      '[data-app-section="ReadingPane"]',
      '.ReadingPaneContainerClass',
      '[aria-label*="Reading"]',
      'article',
      '[data-app-section="ConversationContainer"]',
    ], 500);

    const detail = await safeEvaluate(page, () => {
      const readingPane =
        document.querySelector('[data-app-section="ReadingPane"]') ||
        document.querySelector(".ReadingPaneContainerClass") ||
        document.querySelector('[aria-label*="Reading"]') ||
        document.querySelector('[role="complementary"]') ||
        document.querySelector('[role="main"]');

      if (!readingPane) {
        const articleEl = document.querySelector('article') ||
          document.querySelector('[data-app-section="ConversationContainer"]') ||
          document.querySelector('[aria-label*="conversation"]') ||
          document.querySelector('[aria-label*="email"]');
        if (articleEl) {
          const bodyText = (articleEl as HTMLElement).innerText?.substring(0, 3000) || "";
          return { from: "", to: "", subject: "", body: bodyText, date: "" };
        }
        return { from: "", to: "", subject: "", body: "(Could not load email content)", date: "" };
      }

      const text = (readingPane as HTMLElement).innerText || "";
      const lines = text.split("\n").filter((l) => l.trim());

      let from = "";
      let to = "";
      let subject = "";
      let date = "";
      let bodyStart = 0;

      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        const line = lines[i];
        if (line.match(/^(From|De):/i)) from = line.replace(/^(From|De):\s*/i, "");
        else if (line.match(/^(To|Para|À):/i)) to = line.replace(/^(To|Para|À):\s*/i, "");
        else if (line.match(/^(Subject|Asunto|Objet):/i))
          subject = line.replace(/^(Subject|Asunto|Objet):\s*/i, "");
        else if (
          line.match(
            /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2}[\/:]\d{1,2})/i
          )
        )
          date = line;
        else if (!from && !subject && i < 3) {
          if (!subject) subject = line;
          else if (!from) from = line;
        }
        bodyStart = i + 1;
      }

      const body = lines.slice(bodyStart).join("\n").substring(0, 3000);

      return { from, to, subject, body, date };
    });

    return detail;
  } catch {
    return null;
  }
}

export async function navigateTeamsToChat(page: any): Promise<void> {
  try {
    const url = page.url();
    const isOnChat = url.includes("/conversations") || url.includes("/_#/conversations");

    if (!isOnChat) {
      console.log("[teams-adapter] Not on Chat view, navigating...");

      const chatNavClicked = await safeEvaluate(page, () => {
        const chatBtn = document.querySelector('[data-tid="app-bar-chat-button"]') ||
          document.querySelector('[aria-label="Chat"]') ||
          document.querySelector('[data-tid="chat-tab"]') ||
          document.querySelector('button[title="Chat"]');
        if (chatBtn) {
          (chatBtn as HTMLElement).click();
          return true;
        }

        const navItems = document.querySelectorAll('[role="tab"], [role="menuitem"], nav a, nav button');
        for (let i = 0; i < navItems.length; i++) {
          const item = navItems[i];
          const text = (item as HTMLElement).textContent?.trim() || "";
          const label = item.getAttribute("aria-label") || "";
          if (text === "Chat" || label.includes("Chat")) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (chatNavClicked) {
        await page.waitForTimeout(2000);
      } else {
        await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(3000);
      }
    }
  } catch (err: any) {
    console.error("[teams-adapter] Chat navigation error:", err.message);
  }
}

export async function getTeamsChats(): Promise<ChatSummary[]> {
  const page = getPage("teams");
  if (!page) return [];

  try {
    await navigateTeamsToChat(page);

    await smartWaitForSelector(page, [
      '[data-tid="chat-list-item"]',
      '[data-tid="left-rail-chat-list"]',
      '[role="list"][aria-label*="Chat"]',
    ]);

    let chats = await scrapeTeamsChatList(page);

    if (chats.length === 0) {
      console.log("[teams-adapter] First scrape returned 0 results, retrying...");
      await page.goto(TEAMS_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(3000);
      chats = await scrapeTeamsChatList(page);
    }

    if (chats.length === 0) {
      const url = page.url();
      const title = await page.title();
      console.log(`[teams-adapter] Empty scrape. URL: ${url}, Title: ${title}`);
    }

    return chats;
  } catch (err: any) {
    console.error("[teams-adapter] Scrape error:", err.message);
    const content = await getPageText("teams");
    if (!content) return [];

    const lines = content.split("\n").filter((l) => l.trim());
    const chats: ChatSummary[] = [];
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      chats.push({
        index: i + 1,
        name: lines[i].substring(0, 30),
        lastMessage: "",
        unread: false,
      });
    }
    return chats;
  }
}

async function scrapeTeamsChatList(page: any): Promise<ChatSummary[]> {
  return await safeEvaluate(page, () => {
    const results: Array<{
      index: number; name: string; lastMessage: string; unread: boolean;
    }> = [];

    const stripIconChars = (text: string): string => {
      return text.replace(/[\uE000-\uF8FF]/g, '').replace(/  +/g, ' ').trim();
    };

    let chatItems = document.querySelectorAll('[data-tid="chat-list-item"]');

    if (chatItems.length === 0) {
      const chatList = document.querySelector('[data-tid="left-rail-chat-list"]') ||
        document.querySelector('[role="list"][aria-label*="Chat"]') ||
        document.querySelector('[role="list"][aria-label*="chat"]');
      if (chatList) {
        chatItems = chatList.querySelectorAll('[role="listitem"]');
      }
    }

    if (chatItems.length === 0) {
      chatItems = document.querySelectorAll(
        '[role="listbox"] [role="option"], [role="treeitem"], .fui-ChatItem'
      );
    }

    const seen = new Set<Node>();
    let idx = 0;
    chatItems.forEach((item) => {
      if (idx >= 30) return;
      let dominated = false;
      seen.forEach((s) => { if (s.contains(item) || item.contains(s)) dominated = true; });
      if (dominated) return;
      seen.add(item);

      const el = item as HTMLElement;
      const rawText = el.innerText?.trim() || "";
      const text = stripIconChars(rawText);
      if (!text || text.length < 2) return;

      const lines = text.split("\n").filter((l) => l.trim());
      const ariaLabel = el.getAttribute("aria-label") || "";
      const isUnread =
        ariaLabel.toLowerCase().includes("unread") ||
        el.querySelector('[class*="unread"]') !== null ||
        el.querySelector('[data-tid="unread-count-badge"]') !== null ||
        el.querySelector('.badge') !== null;

      const titleEl = el.querySelector('[data-tid="chat-item-title"]');
      const msgEl = el.querySelector('[data-tid="chat-item-message"]');

      let name = titleEl ? stripIconChars(titleEl.textContent || "") : (lines[0]?.substring(0, 30) || "Chat");
      name = name.replace(/\s+\d{1,2}:\d{2}\s*(AM|PM|am|pm)?\s*$/, "")
                 .replace(/\s+(Yesterday|Today|\d+\s+days?\s+ago)\s*$/i, "")
                 .replace(/\s+((Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\/\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/i, "")
                 .trim();

      let lastMessage = "";
      if (msgEl) {
        lastMessage = stripIconChars(msgEl.textContent || "").substring(0, 60);
      } else {
        const filteredLines = lines.filter(l => !/^\d{1,2}$/.test(l.trim()));
        lastMessage = filteredLines.length > 1 ? (filteredLines[filteredLines.length - 1]?.substring(0, 60) || "") : "";
      }

      idx++;
      results.push({
        index: idx,
        name: name || "Chat",
        lastMessage,
        unread: isUnread,
      });
    });

    return results;
  });
}

async function scrollChatUp(page: any, scrollCount: number = 3): Promise<void> {
  try {
    for (let i = 0; i < scrollCount; i++) {
      const scrolled = await safeEvaluate(page, () => {
        const pane = document.querySelector('[data-tid="message-pane-list"]') ||
          document.querySelector('[role="main"] [role="list"]') ||
          document.querySelector('.message-list');
        if (!pane) return false;
        const el = pane as HTMLElement;
        const before = el.scrollTop;
        el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight);
        return el.scrollTop < before;
      });
      if (!scrolled) break;
      await page.waitForTimeout(600);
    }
  } catch {}
}

export async function readTeamsChat(index: number): Promise<ChatMessage[]> {
  const page = getPage("teams");
  if (!page) return [];

  try {
    let items = await page.$$('[data-tid="chat-list-item"]');
    if (items.length === 0) {
      const chatList = await page.$('[data-tid="left-rail-chat-list"]') ||
        await page.$('[role="list"][aria-label*="Chat"]') ||
        await page.$('[role="list"][aria-label*="chat"]');
      if (chatList) {
        items = await chatList.$$('[role="listitem"]');
      }
    }
    if (items.length === 0) {
      items = await page.$$('[role="listbox"] [role="option"], [role="treeitem"]');
    }

    const targetIdx = Math.max(0, index - 1);
    if (targetIdx >= items.length) return [];

    await items[targetIdx].click();

    await smartWaitForSelector(page, [
      '[data-tid="chat-pane-message"]',
      '[data-tid="messageBodyContent"]',
      '[data-tid="message-pane-list"]',
    ], 500);

    await scrollChatUp(page, 3);

    let messages = await scrapeTeamsMessages(page);

    if (messages.length === 0) {
      await page.waitForTimeout(1000);
      messages = await scrapeTeamsMessages(page);
    }

    return messages;
  } catch (err: any) {
    console.error("[teams-adapter] readTeamsChat error:", err.message);
    return [];
  }
}

async function scrapeTeamsMessages(page: any): Promise<ChatMessage[]> {
  return await safeEvaluate(page, () => {
    const results: Array<{ sender: string; text: string; time: string }> = [];

    let msgElements = document.querySelectorAll('[data-tid="chat-pane-message"]');

    if (msgElements.length === 0) {
      msgElements = document.querySelectorAll('[data-tid="messageBodyContent"]');
    }

    if (msgElements.length === 0) {
      const pane = document.querySelector('[data-tid="message-pane-list"]') ||
        document.querySelector('[role="main"] [role="list"]');
      if (pane) {
        msgElements = pane.querySelectorAll('[role="listitem"]');
      }
    }

    if (msgElements.length === 0) {
      msgElements = document.querySelectorAll('.message-body, [role="listitem"]');
    }

    const seen = new Set<Node>();
    msgElements.forEach((el) => {
      let dominated = false;
      seen.forEach((s) => { if (s.contains(el) || el.contains(s)) dominated = true; });
      if (dominated) return;
      seen.add(el);

      const htmlEl = el as HTMLElement;
      const text = htmlEl.innerText?.trim() || "";
      if (!text || text.length < 2) return;

      const lines = text.split("\n").filter((l) => l.trim());

      let sender = lines[0]?.substring(0, 30) || "";
      let msgText = "";
      let time = "";

      const timeMatch = sender.match(/^(.+?)\s+(\d{1,2}:\d{2}\s*(AM|PM|am|pm)?)\s*$/);
      if (timeMatch) {
        sender = timeMatch[1];
        time = timeMatch[2];
      }

      msgText = lines.slice(1).join(" ").substring(0, 200) || lines[0]?.substring(0, 200) || "";

      results.push({ sender, text: msgText, time });
    });

    return results.slice(-30);
  });
}

export async function sendTeamsMessage(text: string): Promise<boolean> {
  const page = getPage("teams");
  if (!page) return false;

  try {
    const composeBox = await page.$(
      '[data-tid="ckeditor"] [contenteditable="true"], [role="textbox"][contenteditable="true"], .cke_editable'
    );

    if (composeBox) {
      await composeBox.click();
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function replyOutlookEmail(text: string): Promise<boolean> {
  const page = getPage("outlook");
  if (!page) return false;

  try {
    const replyBtn = await page.$(
      'button[aria-label*="Reply"], button[title*="Reply"], [data-icon-name="Reply"]'
    );
    if (replyBtn) {
      await replyBtn.click();
      await page.waitForTimeout(1000);
    }

    const composeBox = await page.$(
      '[role="textbox"][contenteditable="true"], [aria-label*="Message body"], div[contenteditable="true"]'
    );

    if (composeBox) {
      await composeBox.click();
      await page.keyboard.type(text);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export async function sendOutlookReply(): Promise<boolean> {
  const page = getPage("outlook");
  if (!page) return false;

  try {
    const sendBtn = await page.$(
      'button[aria-label*="Send"], button[title*="Send"]'
    );
    if (sendBtn) {
      await sendBtn.click();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
