import type {
  DomSnapshotObservation,
  Observation,
  UiaTreeObservation,
  Verifier,
  VerifierResult,
} from "../types";

// ---------------------------------------------------------------------------
// Standard verifier library — pure, cheap, client-side. Each verifier takes
// the latest Observation and returns a VerifierResult. Nothing here may make
// an LLM call: that's the whole point. If an observation kind can't answer
// the question, we return `unknown` and let the router escalate.
// ---------------------------------------------------------------------------

function textOf(obs: Observation): string {
  switch (obs.kind) {
    case "TextDump":
      return obs.text;
    case "DomSnapshot": {
      const d = obs as DomSnapshotObservation;
      const elText = (d.elements ?? []).map((e) => e.text ?? "").join(" ");
      return [d.title ?? "", d.text ?? "", elText, d.url ?? ""].join(" ");
    }
    case "UiaTree": {
      const u = obs as UiaTreeObservation;
      return [u.windowTitle ?? "", ...u.elements.map((e) => `${e.name ?? ""} ${e.hint ?? ""}`)].join(" ");
    }
    case "AxTree":
      return JSON.stringify((obs as { root: unknown }).root ?? "");
    case "SomScreenshot":
      return (obs as { marks: Array<{ label?: string }> }).marks.map((m) => m.label ?? "").join(" ");
    default:
      return "";
  }
}

function urlOf(obs: Observation): string | undefined {
  if (obs.kind === "DomSnapshot") return (obs as DomSnapshotObservation).url;
  return undefined;
}

function matches(haystack: string, needle: string, mode: "equals" | "contains" | "regex" = "contains"): boolean {
  if (mode === "equals") return haystack === needle;
  if (mode === "regex") {
    try { return new RegExp(needle).test(haystack); } catch { return false; }
  }
  return haystack.includes(needle);
}

export function evaluateVerifier(verifier: Verifier, observation: Observation): VerifierResult {
  switch (verifier.kind) {
    case "expectElement": {
      const t = verifier.target;
      const want = verifier.present !== false;
      if (observation.kind === "DomSnapshot") {
        const d = observation as DomSnapshotObservation;
        const hit = (d.elements ?? []).some((el) => {
          if (t.kind === "selector") return (el.tag ?? "").toLowerCase() === t.css.split(/[ .#\[]/)[0].toLowerCase();
          if (t.kind === "hint") return (el.text ?? "").toLowerCase().includes(t.key.toLowerCase());
          return false;
        });
        return { status: hit === want ? "pass" : "fail", evidence: hit ? "found" : "missing" };
      }
      if (observation.kind === "UiaTree") {
        const u = observation as UiaTreeObservation;
        const hit = u.elements.some((el) => {
          if (t.kind === "uia") {
            return (
              (!t.automationId || el.automationId === t.automationId) &&
              (!t.controlType || el.controlType === t.controlType) &&
              (!t.name || el.name === t.name)
            );
          }
          if (t.kind === "hint") return el.hint === t.key;
          return false;
        });
        return { status: hit === want ? "pass" : "fail", evidence: hit ? "found" : "missing" };
      }
      if (observation.kind === "SomScreenshot" && t.kind === "mark") {
        const marks = (observation as { marks: Array<{ mark: string }> }).marks;
        const hit = marks.some((m) => m.mark === t.mark);
        return { status: hit === want ? "pass" : "fail", evidence: hit ? "found" : "missing" };
      }
      return { status: "unknown", evidence: `expectElement on ${observation.kind} unsupported` };
    }
    case "expectText": {
      const haystack = textOf(observation);
      const hit = matches(haystack, verifier.text, verifier.match);
      return { status: hit ? "pass" : "fail", evidence: hit ? `text found in ${observation.kind}` : `not found in ${observation.kind}` };
    }
    case "expectUrl": {
      const url = urlOf(observation);
      if (!url) return { status: "unknown", evidence: `no url in ${observation.kind}` };
      const hit = matches(url, verifier.url, verifier.match);
      return { status: hit ? "pass" : "fail", evidence: url };
    }
    case "expectImageRegion": {
      if (observation.kind !== "RawScreenshot" && observation.kind !== "SomScreenshot") {
        return { status: "unknown", evidence: `expectImageRegion needs an image observation, got ${observation.kind}` };
      }
      if (!verifier.expectedDigest) return { status: "unknown", evidence: "no expectedDigest provided" };
      return { status: observation.digest === verifier.expectedDigest ? "pass" : "fail", observedDigest: observation.digest };
    }
    case "expectNoChange":
      return { status: observation.digest === verifier.sinceDigest ? "pass" : "fail", observedDigest: observation.digest };
    case "expectHash":
      return { status: observation.digest === verifier.digest ? "pass" : "fail", observedDigest: observation.digest };
  }
}
