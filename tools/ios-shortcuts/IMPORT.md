# Building the Rachael Bridge Shortcuts on iPhone

Apple does not let third parties ship pre-signed `.shortcut` files without a
Developer account, so build each Shortcut once on the phone using the steps
below. Total time: ~10 minutes.

## 1. Rachael Bridge (entry point)

1. Shortcuts app → **+** → **Add Action** → search **Get Contents of URL**.
2. URL: paste your bridge URL (shown in Rachael's pairing screen), e.g.
   `https://rachael.example.com/api/ios/devices/<id>/queue`.
3. Method: **GET**. Headers: add `X-Device-Token` with the token from pairing.
4. Add **Repeat with Each** over the response → **Get Dictionary Value** → key
   `action`.
5. Add **If** → action equals `send-imessage` → **Run Shortcut** (the helper),
   passing the args dictionary. Repeat the If/Else branches for every helper.
6. After each helper, **Get Contents of URL** to
   `POST .../queue/<id>/result` with the helper's result.
7. Name it **Rachael Bridge**. Add to Home Screen if desired.

For polling transport, add a **Personal Automation** → "Time of Day" → run
every 5 minutes → **Run Shortcut: Rachael Bridge**.

## 2. send-imessage

1. **+** → search **Send Message** → set Recipient and Message to "Shortcut
   Input → Dictionary Value (recipient, body)".
2. End with **Stop and Output** → text "ok".
3. Name: **send-imessage**.

## 3. open-url

1. **+** → **URL** → set to "Dictionary Value (url) of Shortcut Input".
2. **Open URLs**. Output "ok".
3. Name: **open-url**.

## 4. run-named-shortcut

1. **Run Shortcut** with name = "Dictionary Value (name) of Shortcut Input"
   and input = "Dictionary Value (input)".
2. Output the run result.
3. Name: **run-named-shortcut**.

## 5. set-timer

1. **Start Timer** with duration = "Dictionary Value (seconds) of Shortcut
   Input" seconds. Output "ok".
2. Name: **set-timer**.

## 6. append-note

1. **Find Notes** where Folder is "Dictionary Value (folder)".
2. **Append to Note** the body. Output "ok".
3. Name: **append-note**.

## 7. append-reminder

1. **Add New Reminder** to list "Dictionary Value (list)" with title "body".
2. Output "ok".
3. Name: **append-reminder**.

## 8. query-health

1. **Find Health Sample** for type matching "Dictionary Value (metric)".
2. Output the most recent value.
3. Name: **query-health**.

## Verifying

Run **Rachael Bridge** manually once. The Cockpit Audit tab should show
`ios/ios-shortcuts/<action>` lines as you exercise each helper.
