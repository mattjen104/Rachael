// Rachael LilyGo T-Keyboard remote — dual-mode shell
//
//   CHAT    — direct-to-OpenRouter chat (preserved bit-for-bit from the prior
//             keyboard firmware: prompt → POST /chat/completions → reply on OLED).
//             This is the **default** mode at boot when no Rachael pairing exists.
//   RACHAEL — pairs with the Rachael server, opens a TLS WebSocket to
//             /ws/keyboard, dispatches each line as a queued instruction, and
//             renders status frames.
//
// Mode switch chord:  Sym+R → RACHAEL,  Sym+C → CHAT,  Sym+N → start pairing,
//                     Sym+P → poll pair status.
// Output paging:      Up / Down arrow keys page through long results
//                     (Sym+, / Sym+. also work as a fallback on devices whose
//                      arrow keys are remapped).
//
// Transport: WiFi + TLS only. https:// + wss:// are the only schemes used.
//            There is no plaintext fallback.
//            * Rachael server (pairing REST + WebSocket) — TLS validation is
//              strict: requires either a pinned root CA in NVS (`rootCa`) or
//              an explicit `:tls insecure` opt-in. Defaults to strict.
//            * OpenRouter (CHAT mode) — uses a separate TLS client. Because
//              ESP32 has no system root-CA store, public APIs like
//              openrouter.ai are reached with `setInsecure()` by default
//              (matching the prior CHAT firmware bit-for-bit). Optionally
//              pin a CA via `:tls openrouter-ca <PEM>`. The Rachael pin is
//              never reused for OpenRouter.
//
// Reconnect: exponential backoff 1s → 2s → 4s → … capped at 60s, with jitter.
//
// NVS keys:  ssid, pass, serverHost, serverPort, deviceToken, pendingToken,
//            mode (chat|rachael), openrouterKey, openrouterModel,
//            rootCa (Rachael server pin), tlsInsecure (Rachael, off by default),
//            openrouterCa (optional pin for OpenRouter).

#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <BBQ10Keyboard.h>

#define OLED_W 128
#define OLED_H 64
#define LINE_W 21
#define MAX_PAGE_LINES 6

Adafruit_SSD1306 oled(OLED_W, OLED_H, &Wire, -1);
BBQ10Keyboard kb;
Preferences prefs;
using namespace websockets;
WebsocketsClient ws;

enum Mode { MODE_CHAT, MODE_RACHAEL };
Mode currentMode = MODE_CHAT;   // default — overridden in setup() once we know if a token exists

bool symHeld = false;
bool linkUp = false;
String inputLine = "";
String pendingTakeoverId = "";

struct Page { String text; };
Page pages[8];
int pageCount = 0;
int pageIdx = 0;

// Backoff state
uint32_t backoffMs = 1000;
const uint32_t MAX_BACKOFF_MS = 60000;
uint32_t nextReconnectAt = 0;

unsigned long lastPing = 0;
const unsigned long PING_MS = 20000;

// Spinner
const char SPINNER[] = "|/-\\";
uint8_t spinnerIdx = 0;
bool spinnerActive = false;
unsigned long spinnerNextTick = 0;

// ──────────────────────────────────────────────────────────────────────────────
// NVS helpers
String nvsGet(const char* key, const char* def = "") {
  prefs.begin("rachael", true); String v = prefs.getString(key, def); prefs.end(); return v;
}
void nvsSet(const char* key, const String& val) {
  prefs.begin("rachael", false); prefs.putString(key, val); prefs.end();
}
bool nvsGetBool(const char* key, bool def) {
  prefs.begin("rachael", true); bool v = prefs.getBool(key, def); prefs.end(); return v;
}
void nvsSetBool(const char* key, bool val) {
  prefs.begin("rachael", false); prefs.putBool(key, val); prefs.end();
}

// ──────────────────────────────────────────────────────────────────────────────
// OLED renderer with paging + corner glyphs
void cornerGlyph() {
  oled.setTextSize(1);
  oled.setCursor(OLED_W - 12, 0);
  oled.print(currentMode == MODE_RACHAEL ? "R" : "C");
  if (currentMode == MODE_RACHAEL) {
    oled.fillRect(OLED_W - 5, 1, 4, 4, linkUp ? SSD1306_WHITE : SSD1306_BLACK);
    oled.drawRect(OLED_W - 5, 1, 4, 4, SSD1306_WHITE);
  }
  if (spinnerActive) {
    oled.setCursor(OLED_W - 18, 0);
    char s[2] = { SPINNER[spinnerIdx & 3], 0 };
    oled.print(s);
  }
}

void splitPages(const String& text) {
  pageCount = 0;
  pageIdx = 0;
  String cur = "";
  int lineCount = 0;
  for (size_t i = 0; i < text.length(); ) {
    int end = i + LINE_W;
    if (end > (int)text.length()) end = text.length();
    int nl = text.indexOf('\n', i);
    if (nl != -1 && nl < end) end = nl;
    String line = text.substring(i, end);
    if (cur.length() > 0) cur += "\n";
    cur += line;
    lineCount++;
    if (lineCount >= MAX_PAGE_LINES) {
      pages[pageCount++] = { cur }; cur = ""; lineCount = 0;
      if (pageCount >= 8) break;
    }
    i = end + (nl == end ? 1 : 0);
  }
  if (cur.length() > 0 && pageCount < 8) pages[pageCount++] = { cur };
}

void render() {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 0);

  if (pageCount > 0) {
    oled.println(pages[pageIdx].text);
    if (pageCount > 1) {
      oled.setCursor(0, OLED_H - 18);
      oled.printf("[%d/%d] sym+./, page", pageIdx + 1, pageCount);
    }
  } else {
    oled.println(currentMode == MODE_RACHAEL ? "RACHAEL ready" : "CHAT ready");
  }

  oled.drawFastHLine(0, OLED_H - 10, OLED_W, SSD1306_WHITE);
  oled.setCursor(0, OLED_H - 8);
  oled.print(">");
  oled.print(inputLine.substring(max(0, (int)inputLine.length() - (LINE_W - 2))));

  cornerGlyph();
  oled.display();
}

void showStatus(const String& s) { splitPages(s); render(); }

void startSpinner() { spinnerActive = true; spinnerNextTick = millis(); }
void stopSpinner()  { spinnerActive = false; render(); }

// ──────────────────────────────────────────────────────────────────────────────
// Wi-Fi
bool connectWiFi() {
  String ssid = nvsGet("ssid");
  String pass = nvsGet("pass");
  if (ssid.length() == 0) { showStatus("No Wi-Fi.\nUse :wifi <ssid> <pass>"); return false; }
  showStatus("WiFi: " + ssid + "…");
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), pass.c_str());
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) { delay(250); }
  if (WiFi.status() != WL_CONNECTED) { showStatus("WiFi failed"); return false; }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// TLS — the Rachael server uses strict pinning by default; OpenRouter uses
// the prior firmware's permissive default (setInsecure) so CHAT keeps working
// out of the box on devices without a system CA store. The two configs are
// kept separate; the Rachael pin is never reused for OpenRouter.

void applyRachaelTls(WiFiClientSecure& client) {
  String ca = nvsGet("rootCa");
  if (ca.length() > 0) {
    client.setCACert(ca.c_str());
  } else if (nvsGetBool("tlsInsecure", false)) {
    client.setInsecure();
  }
  // else: connection will fail closed; user must `:tls pin <pem>` or `:tls insecure`.
}

void applyOpenRouterTls(WiFiClientSecure& client) {
  String ca = nvsGet("openrouterCa");
  if (ca.length() > 0) client.setCACert(ca.c_str());
  else                 client.setInsecure();   // matches prior CHAT firmware default
}

// ──────────────────────────────────────────────────────────────────────────────
// Pairing flow (HTTPS only)
bool startPairing() {
  String host = nvsGet("serverHost");
  int port = nvsGet("serverPort", "443").toInt();
  if (host.length() == 0) { showStatus("No server. :host <h> <p>"); return false; }

  WiFiClientSecure client;
  applyRachaelTls(client);
  HTTPClient http;
  String url = String("https://") + host + ":" + port + "/api/keyboard/pair/start";
  if (!http.begin(client, url)) { showStatus("pair: tls init fail"); return false; }
  int code = http.POST("");
  if (code != 200) { showStatus("pair start fail " + String(code)); http.end(); return false; }
  String body = http.getString();
  http.end();

  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, body)) { showStatus("pair: bad json"); return false; }
  String pairCode = doc["code"].as<String>();
  String pendingToken = doc["pendingToken"].as<String>();
  nvsSet("pendingToken", pendingToken);

  showStatus("Pair code:\n  " + pairCode + "\n\nEnter in web UI,\nthen sym+P");
  return true;
}

bool pollPairing() {
  String host = nvsGet("serverHost");
  int port = nvsGet("serverPort", "443").toInt();
  String pendingToken = nvsGet("pendingToken");
  if (pendingToken.length() == 0) return false;

  WiFiClientSecure client;
  applyRachaelTls(client);
  HTTPClient http;
  String url = String("https://") + host + ":" + port +
               "/api/keyboard/pair/status?pendingToken=" + pendingToken;
  if (!http.begin(client, url)) return false;
  int code = http.GET();
  if (code != 200) { http.end(); return false; }
  String body = http.getString();
  http.end();

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, body)) return false;
  String status = doc["status"].as<String>();
  if (status == "confirmed") {
    nvsSet("deviceToken", pendingToken);
    nvsSet("pendingToken", "");
    showStatus("Paired! Switching to RACHAEL");
    currentMode = MODE_RACHAEL;
    nvsSet("mode", "rachael");
    backoffMs = 1000;
    return true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket (wss only)
void onWsMessage(WebsocketsMessage m) {
  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, m.data())) return;
  String kind = doc["kind"].as<String>();
  String text = doc["text"].as<String>();
  if (kind == "status" && text.indexOf("executing") >= 0) startSpinner();
  else if (kind == "result" || kind == "echo" || kind == "error") stopSpinner();
  if (kind == "prompt" && doc["meta"].containsKey("takeoverPointId")) {
    pendingTakeoverId = doc["meta"]["takeoverPointId"].as<String>();
    showStatus("WAIT: " + text + "\n\nY/N to answer");
  } else {
    showStatus("[" + kind + "]\n" + text);
  }
}

void scheduleReconnect() {
  // exponential backoff with jitter, capped
  uint32_t jitter = (uint32_t)random(0, (long)(backoffMs / 2));
  nextReconnectAt = millis() + backoffMs + jitter;
  backoffMs = min((uint32_t)(backoffMs * 2), MAX_BACKOFF_MS);
}

void onWsEvent(WebsocketsEvent ev, String) {
  if (ev == WebsocketsEvent::ConnectionOpened) {
    linkUp = true; backoffMs = 1000; render();
  } else if (ev == WebsocketsEvent::ConnectionClosed) {
    linkUp = false; render(); scheduleReconnect();
  }
}

bool connectWs() {
  String host = nvsGet("serverHost");
  int port = nvsGet("serverPort", "443").toInt();
  String token = nvsGet("deviceToken");
  if (host.length() == 0 || token.length() == 0) {
    showStatus("Not paired. sym+N to pair");
    return false;
  }
  String url = String("wss://") + host + ":" + port + "/ws/keyboard?token=" + token;
  ws.onMessage(onWsMessage);
  ws.onEvent(onWsEvent);

  // TLS config for ArduinoWebsockets — pinned CA if available.
  String ca = nvsGet("rootCa");
  if (ca.length() > 0) ws.setCACert(ca.c_str());
  else if (nvsGetBool("tlsInsecure", false)) ws.setInsecure();
  // else: connect attempt will fail, prompting the user to configure TLS.

  bool ok = ws.connect(url);
  linkUp = ok;
  if (!ok) scheduleReconnect();
  return ok;
}

void wsSendLine(const String& text) {
  if (!linkUp) { showStatus("not linked"); return; }
  StaticJsonDocument<512> doc;
  doc["kind"] = "line"; doc["text"] = text; doc["ts"] = (uint32_t)(millis());
  String out; serializeJson(doc, out); ws.send(out);
}

void wsSendAnswer(const String& yn) {
  if (!linkUp || pendingTakeoverId.length() == 0) return;
  StaticJsonDocument<256> doc;
  doc["kind"] = "answer"; doc["value"] = yn; doc["takeoverPointId"] = pendingTakeoverId;
  doc["ts"] = (uint32_t)(millis());
  String out; serializeJson(doc, out); ws.send(out);
  pendingTakeoverId = "";
}

// ──────────────────────────────────────────────────────────────────────────────
// CHAT mode — preserved direct-to-OpenRouter behavior.
//
// This mirrors the original keyboard firmware: build a chat completion POST,
// stream/parse a single-shot reply, render it on the OLED. Configure with:
//   :openrouter <api-key>
//   :model <model-id>            (default: openrouter/auto)
void chatHandle(const String& prompt) {
  String apiKey = nvsGet("openrouterKey");
  String model = nvsGet("openrouterModel", "openrouter/auto");
  if (apiKey.length() == 0) { showStatus("Set key:\n:openrouter <key>"); return; }

  startSpinner();
  WiFiClientSecure client;
  applyOpenRouterTls(client);
  HTTPClient http;
  if (!http.begin(client, "https://openrouter.ai/api/v1/chat/completions")) {
    stopSpinner(); showStatus("chat: tls init fail"); return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + apiKey);
  http.addHeader("HTTP-Referer", "https://rachael.local/keyboard");
  http.addHeader("X-Title", "Rachael LilyGo Keyboard");

  StaticJsonDocument<1024> req;
  req["model"] = model;
  JsonArray msgs = req.createNestedArray("messages");
  JsonObject m = msgs.createNestedObject();
  m["role"] = "user";
  m["content"] = prompt;
  req["max_tokens"] = 256;

  String body; serializeJson(req, body);
  int code = http.POST(body);
  String resp = http.getString();
  http.end();
  stopSpinner();

  if (code != 200) { showStatus("chat err " + String(code) + "\n" + resp.substring(0, 80)); return; }

  StaticJsonDocument<4096> doc;
  if (deserializeJson(doc, resp)) { showStatus("chat: bad json"); return; }
  String content = doc["choices"][0]["message"]["content"] | "";
  showStatus(content.length() > 0 ? content : "(empty reply)");
}

// ──────────────────────────────────────────────────────────────────────────────
// Local config commands typed at the prompt
//   :wifi <ssid> <pass>
//   :host <host> <port>          (TLS only; default port 443)
//   :openrouter <api-key>
//   :model <model-id>
//   :tls insecure                — opt-in to allow connecting without a pinned CA
//   :tls strict                  — require a pinned CA (default)
//   :mode chat|rachael
//   :pair                        — request a pairing code
//   :poll                        — poll pairing status
//   :reset                       — clear NVS
bool handleLocalCommand(const String& line) {
  if (!line.startsWith(":")) return false;
  int sp1 = line.indexOf(' ');
  String cmd = sp1 == -1 ? line.substring(1) : line.substring(1, sp1);
  String rest = sp1 == -1 ? "" : line.substring(sp1 + 1);

  if (cmd == "wifi") {
    int sp = rest.indexOf(' ');
    if (sp == -1) { showStatus(":wifi <ssid> <pass>"); return true; }
    nvsSet("ssid", rest.substring(0, sp));
    nvsSet("pass", rest.substring(sp + 1));
    showStatus("Wi-Fi saved. Reboot."); return true;
  }
  if (cmd == "host") {
    int sp = rest.indexOf(' ');
    String host = sp == -1 ? rest : rest.substring(0, sp);
    String port = sp == -1 ? String("443") : rest.substring(sp + 1);
    nvsSet("serverHost", host);
    nvsSet("serverPort", port);
    showStatus("Server: https://" + host + ":" + port); return true;
  }
  if (cmd == "openrouter") {
    nvsSet("openrouterKey", rest);
    showStatus("OpenRouter key saved."); return true;
  }
  if (cmd == "model") {
    nvsSet("openrouterModel", rest);
    showStatus("Model: " + rest); return true;
  }
  if (cmd == "tls") {
    if (rest == "insecure") { nvsSetBool("tlsInsecure", true); showStatus("Rachael TLS: insecure"); }
    else if (rest == "strict") { nvsSetBool("tlsInsecure", false); showStatus("Rachael TLS: strict"); }
    else if (rest.startsWith("pin ")) { nvsSet("rootCa", rest.substring(4)); showStatus("Rachael CA pinned."); }
    else if (rest.startsWith("openrouter-ca ")) { nvsSet("openrouterCa", rest.substring(14)); showStatus("OpenRouter CA pinned."); }
    else { showStatus(":tls strict|insecure|pin <PEM>|openrouter-ca <PEM>"); }
    return true;
  }
  if (cmd == "mode") {
    if (rest == "chat") { currentMode = MODE_CHAT; nvsSet("mode", "chat"); }
    else { currentMode = MODE_RACHAEL; nvsSet("mode", "rachael"); }
    showStatus("Mode: " + String(currentMode == MODE_RACHAEL ? "RACHAEL" : "CHAT")); return true;
  }
  if (cmd == "pair") { startPairing(); return true; }
  if (cmd == "poll") { pollPairing(); return true; }
  if (cmd == "reset") {
    prefs.begin("rachael", false); prefs.clear(); prefs.end();
    showStatus("NVS cleared. Reboot."); return true;
  }
  showStatus("unknown: " + cmd); return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode switching
void switchMode(Mode m) {
  currentMode = m;
  nvsSet("mode", m == MODE_RACHAEL ? "rachael" : "chat");
  if (m == MODE_RACHAEL && !linkUp) {
    if (nvsGet("deviceToken").length() == 0) { showStatus("RACHAEL: not paired\nsym+N to pair"); return; }
    backoffMs = 1000;
    connectWs();
  }
  showStatus(String("→ ") + (m == MODE_RACHAEL ? "RACHAEL" : "CHAT"));
}

void onSubmit(const String& line) {
  if (handleLocalCommand(line)) return;
  if (currentMode == MODE_RACHAEL) wsSendLine(line);
  else                              chatHandle(line);
}

void pagePrev() { if (pageIdx > 0) { pageIdx--; render(); } }
void pageNext() { if (pageIdx + 1 < pageCount) { pageIdx++; render(); } }

void onChar(char c) {
  if (c == 0x1A) { symHeld = true; return; }       // Sym modifier
  // Up/Down arrow keys page through long output (BBQ10 emits 0x11/0x12 for
  // up/down by default; some firmwares emit 0xB5/0xB6 — handle both).
  if (c == 0x11 || c == (char)0xB5) { pagePrev(); return; }
  if (c == 0x12 || c == (char)0xB6) { pageNext(); return; }
  if (symHeld) {
    if (c == 'r' || c == 'R') { switchMode(MODE_RACHAEL); symHeld = false; return; }
    if (c == 'c' || c == 'C') { switchMode(MODE_CHAT);    symHeld = false; return; }
    if (c == 'p' || c == 'P') { pollPairing();            symHeld = false; return; }
    if (c == 'n' || c == 'N') { startPairing();           symHeld = false; return; }
    if (c == ',')             { pagePrev(); symHeld = false; return; }
    if (c == '.')             { pageNext(); symHeld = false; return; }
    symHeld = false;
  }
  if (pendingTakeoverId.length() > 0 && (c == 'y' || c == 'Y')) { wsSendAnswer("Y"); return; }
  if (pendingTakeoverId.length() > 0 && (c == 'n' || c == 'N')) { wsSendAnswer("N"); return; }
  if (c == '\n' || c == '\r') { String l = inputLine; inputLine = ""; render(); onSubmit(l); return; }
  if (c == 0x08 && inputLine.length() > 0) { inputLine.remove(inputLine.length() - 1); render(); return; }
  if (c >= 0x20 && c < 0x7F) { inputLine += c; render(); }
}

// ──────────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Wire.begin();
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  oled.clearDisplay();
  kb.begin();
  kb.setBacklight(0.5f);
  randomSeed(esp_random());

  // Default mode = CHAT (preserves prior firmware behavior). RACHAEL only if a
  // pairing already exists *and* user previously selected RACHAEL.
  String mode = nvsGet("mode", "chat");
  bool hasToken = nvsGet("deviceToken").length() > 0;
  currentMode = (mode == "rachael" && hasToken) ? MODE_RACHAEL : MODE_CHAT;

  showStatus("Booting…");
  if (!connectWiFi()) return;

  if (currentMode == MODE_RACHAEL) {
    if (!connectWs()) {
      if (!hasToken) startPairing();
    } else {
      showStatus("Linked");
    }
  } else {
    showStatus("CHAT ready");
  }
}

void loop() {
  if (currentMode == MODE_RACHAEL) {
    ws.poll();
    if (linkUp && millis() - lastPing > PING_MS) {
      lastPing = millis(); ws.send("{\"kind\":\"ping\"}");
    }
    // Reconnect with exponential backoff
    if (!linkUp && nvsGet("deviceToken").length() > 0 && WiFi.status() == WL_CONNECTED &&
        millis() >= nextReconnectAt) {
      connectWs();
    }
  }

  if (spinnerActive && millis() >= spinnerNextTick) {
    spinnerIdx++; spinnerNextTick = millis() + 120; render();
  }

  int n = kb.keyCount();
  while (n-- > 0) {
    BBQ10Keyboard::KeyEvent ev = kb.keyEvent();
    if (ev.state == BBQ10Keyboard::StatePress) onChar(ev.key);
  }
  delay(10);
}
