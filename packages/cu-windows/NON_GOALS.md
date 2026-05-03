# Non-goals — `@rachael/cu-windows` v0.x

- **No macOS or Linux desktop adapters.** AT-SPI and AX are explicit
  v1.x candidates, not v0.x.
- **No shipped ONNX checkpoints.** The OmniParser ONNX files are large
  (>100 MB) and have their own license; the sidecar loads them from a
  configurable `models/` directory.
- **No GPU-required path.** CPU is the supported runtime. GPU is an
  opportunistic speedup if `onnxruntime-gpu` is installed.
- **No remote-host orchestration.** The sidecar is meant to run on the
  same host as the surfaces it controls. Cross-host control is a
  user-supplied transport concern.
- **No screen recording.** The Citrix adapter takes single screenshots on
  demand; continuous recording is out of scope.
- **No keystroke/mouse keyloggers.** The adapters issue Action verbs;
  they do not observe ambient input.
- **No PHI exfiltration paths.** All observation bytes stay local; the
  HTTP server defaults to `127.0.0.1`. Re-binding to `0.0.0.0` is
  considered a misconfiguration and is documented as such.
- **No skill execution.** Recipes are routed via [`@rachael/cu-skills`](../cu-skills).
