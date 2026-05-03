import { describe, it, expect } from "vitest";
import {
  redactString,
  redactTraceEvent,
  redactTraceEvents,
  mintRawUnlock,
  consumeRawUnlock,
  renderRedactedSvg,
  loadRedactionPolicy,
  reloadRedactionPolicy,
} from "../server/redaction";

describe("redactString", () => {
  it("masks SSN, phone, email, MRN, DOB, and long digit runs", () => {
    const inputs: Array<[string, string]> = [
      ["SSN 123-45-6789", "ssn"],
      ["call (415) 555-0199", "phone"],
      ["a@b.co", "email"],
      ["MRN: 1234567", "mrn"],
      ["DOB 03/14/1985", "dob"],
      ["acct 12345678", "long-digit-run"],
    ];
    for (const [text, expectedHit] of inputs) {
      const out = redactString(text);
      expect(out.value, `"${text}" should be redacted`).not.toEqual(text);
      expect(out.hits).toContain(expectedHit);
    }
  });

  it("leaves non-PII content unchanged", () => {
    const out = redactString("hello world v2");
    expect(out.value).toBe("hello world v2");
    expect(out.hits).toEqual([]);
  });
});

describe("redactTraceEvent", () => {
  const event = {
    id: "rt-1",
    ts: 0,
    runId: "r1",
    stepIndex: 0,
    kind: "observe",
    surfaceId: "s1",
    surfaceKind: "som",
    observation: { kind: "som", digest: "abc", imageRef: "img-123" },
    reason: "patient MRN: 9988776 entered",
    metadata: { note: "call 415-555-0199" },
  };

  it("masks PHI in nested fields by default", () => {
    const r = redactTraceEvent(event);
    expect(r.rawAvailable).toBe(false);
    expect(r.redacted.reason).toContain("[MRN]");
    expect((r.redacted.metadata as any).note).toContain("[PHONE]");
    expect((r.redacted.observation as any).imageRef).toBe("[REDACTED]");
    expect(r.redactedFields.length).toBeGreaterThan(0);
  });

  it("returns raw payload when raw=true", () => {
    const r = redactTraceEvent(event, { raw: true });
    expect(r.rawAvailable).toBe(true);
    expect(r.redacted.reason).toBe(event.reason);
    expect((r.redacted.observation as any).imageRef).toBe("img-123");
  });
});

describe("redactTraceEvents (batch)", () => {
  it("redacts every event and totals the hit count", () => {
    const events = [
      { id: "1", reason: "MRN 1234567" },
      { id: "2", reason: "no pii" },
      { id: "3", reason: "phone (415) 555-0199" },
    ] as Array<Record<string, unknown>>;
    const out = redactTraceEvents(events);
    expect(out.events.length).toBe(3);
    expect(out.redactedFieldCount).toBeGreaterThan(0);
    expect(out.rawAvailable).toBe(false);
  });
});

describe("raw-unlock tokens", () => {
  it("mints a token that can be consumed once for the same runId", () => {
    const { token } = mintRawUnlock("run-x", "analyst-1", "patient asked", "principal-A");
    const ok = consumeRawUnlock(token, "run-x", "principal-A");
    expect(ok).not.toBeNull();
    expect(ok?.actor).toBe("analyst-1");
  });

  it("rejects tokens for other runIds", () => {
    const { token } = mintRawUnlock("run-x", "a", "r", "principal-A");
    expect(consumeRawUnlock(token, "run-y", "principal-A")).toBeNull();
  });

  it("rejects tokens presented by a different principal", () => {
    const { token } = mintRawUnlock("run-x", "a", "r", "principal-A");
    // Same runId, same TTL, but different principal — must be rejected.
    expect(consumeRawUnlock(token, "run-x", "principal-B")).toBeNull();
    // Original principal still works.
    expect(consumeRawUnlock(token, "run-x", "principal-A")).not.toBeNull();
  });

  it("rejects unknown tokens", () => {
    expect(consumeRawUnlock("bogus", "run-x", "principal-A")).toBeNull();
    expect(consumeRawUnlock(undefined, "run-x", "principal-A")).toBeNull();
  });

  it("is reusable within TTL (session-mode) but explicit revoke locks it", async () => {
    const { token } = mintRawUnlock("run-z", "a", "reason", "principal-A");
    const { revokeRawUnlock } = await import("../server/redaction");
    expect(consumeRawUnlock(token, "run-z", "principal-A")).not.toBeNull();
    expect(consumeRawUnlock(token, "run-z", "principal-A")).not.toBeNull();
    expect(revokeRawUnlock(token)).toBe(true);
    expect(consumeRawUnlock(token, "run-z", "principal-A")).toBeNull();
  });
});

describe("redaction policy", () => {
  it("loads default policy with non-zero patterns", () => {
    reloadRedactionPolicy();
    const p = loadRedactionPolicy();
    expect(p.patterns.length).toBeGreaterThan(0);
    expect(p.stripImageRefs).toBe(true);
  });
});

describe("renderRedactedSvg", () => {
  it("fail-closed: NEVER embeds image bytes when raw=false even with regions configured", () => {
    // SVG <image href="data:...base64,..."> is trivially reversible by
    // extracting the data URL, so non-raw mode must never embed bytes.
    const svg = renderRedactedSvg(
      { width: 200, height: 100, bytes: Buffer.from("FAKEBYTES"), mime: "image/png" },
      [{ x: 10, y: 20, w: 30, h: 40, reason: "PHI" }],
      { raw: false },
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="200"');
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("base64");
    expect(svg).toContain("PHI region");
    expect(svg).toContain("unlock raw");
  });

  it("fail-closed: NO image bytes when raw=false and no regions configured", () => {
    const svg = renderRedactedSvg(
      { width: 100, height: 100, bytes: Buffer.from("BYTES"), mime: "image/png" },
      [],
      { raw: false },
    );
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("base64");
  });

  it("embeds image bytes when raw=true and applies region overlays", () => {
    const svg = renderRedactedSvg(
      { width: 100, height: 100, bytes: Buffer.from("BYTES"), mime: "image/png" },
      [{ x: 0, y: 0, w: 50, h: 50, reason: "x" }],
      { raw: true },
    );
    expect(svg).toContain("<image");
    expect(svg).toContain("REDACTED");
  });

  it("renders placeholder when raw=true but no bytes available", () => {
    const svg = renderRedactedSvg({ width: 50, height: 50 }, [], { raw: true });
    expect(svg).not.toContain("<image");
    expect(svg).toContain("not persisted");
  });
});
