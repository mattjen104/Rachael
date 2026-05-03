# openrouter-model-scout

[← Back to index](./README.md)

- **Type:** monitor
- **Schedule:** every 12h (`0 6,18 * * *`)
- **Enabled:** yes
- **Cost tier:** cheap
- **Tags:** program
- **Last successful run:** 2026-04-01 18:01Z

## Description

Check model availability on OpenRouter. Tests core models (DeepSeek, Claude), queries live pricing from /api/v1/models, auto-updates roster pricing, and flags offline models.

## Health (last 35 days)

- ✅ Successful runs: **5**
- ❌ Errored runs: **31**
- Total runs in window: 36

Top error patterns:
- `Error: column "subject" does not exist` × 31

## Successful runs (newest first)

<a id="run-307"></a>
### 2026-04-01 18:01Z — run #307

model: `inline-code` · tokens: 0 · metric: 3

**Summary:**

```
Model Scout: 3/5 core models working ¦ Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (1060ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not
```

<details><summary>Raw output</summary>

```
Model Scout: 3/5 core models working | Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (1060ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not a valid model ID (24ms)\n[+] qwen-2.5-72b-instruct OK (989ms)\n[-] claude-3.5-sonnet ERR: Provider returned error (3676ms)\n[+] claude-sonnet-4 OK (668ms)
```

</details>

<a id="run-299"></a>
### 2026-04-01 16:16Z — run #299

model: `inline-code` · tokens: 0 · metric: 3

**Summary:**

```
Model Scout: 3/5 core models working ¦ Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (708ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not a
```

<details><summary>Raw output</summary>

```
Model Scout: 3/5 core models working | Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (708ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not a valid model ID (27ms)\n[+] qwen-2.5-72b-instruct OK (857ms)\n[-] claude-3.5-sonnet ERR: Provider returned error (608ms)\n[+] claude-sonnet-4 OK (1942ms)
```

</details>

<a id="run-289"></a>
### 2026-03-31 18:01Z — run #289

model: `inline-code` · tokens: 0 · metric: 4

**Summary:**

```
Model Scout: 4/5 core models working ¦ Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (1273ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not
```

<details><summary>Raw output</summary>

```
Model Scout: 4/5 core models working | Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (1273ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not a valid model ID (137ms)\n[+] qwen-2.5-72b-instruct OK (27555ms)\n[+] claude-3.5-sonnet OK (2494ms)\n[+] claude-sonnet-4 OK (1490ms)
```

</details>

<a id="run-285"></a>
### 2026-03-31 17:43Z — run #285

model: `inline-code` · tokens: 0 · metric: 3

**Summary:**

```
Model Scout: 3/5 core models working ¦ Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (454ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not a
```

<details><summary>Raw output</summary>

```
Model Scout: 3/5 core models working | Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (454ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not a valid model ID (24ms)\n[-] qwen-2.5-72b-instruct ERR: Provider returned error (5149ms)\n[+] claude-3.5-sonnet OK (1886ms)\n[+] claude-sonnet-4 OK (804ms)
```

</details>

<a id="run-269"></a>
### 2026-03-31 01:58Z — run #269

model: `inline-code` · tokens: 0 · metric: 4

**Summary:**

```
Model Scout: 4/5 core models working ¦ Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (1438ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not
```

<details><summary>Raw output</summary>

```
Model Scout: 4/5 core models working | Pricing updated for 10 models, Discovered 5 new models, 6 proposals\n[+] deepseek-chat OK (1438ms)\n[-] deepseek-reasoner ERR: deepseek/deepseek-reasoner is not a valid model ID (21ms)\n[+] qwen-2.5-72b-instruct OK (204ms)\n[+] claude-3.5-sonnet OK (867ms)\n[+] claude-sonnet-4 OK (925ms)
```

</details>
