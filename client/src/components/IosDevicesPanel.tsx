import React, { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

interface IosDevice {
  id: number;
  kind: "ios-shortcuts" | "ios-wda";
  name: string;
  armed: boolean;
  lastSeen: string | null;
  createdAt: string;
  revoked: boolean;
}

interface PairingCodeResponse {
  code: string;
  expiresAt: string;
}

export default function IosDevicesPanel() {
  const [devices, setDevices] = useState<IosDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState<{ kind: string; code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await apiRequest("GET", "/api/ios/devices");
      setDevices(await r.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const startPair = async (kind: "ios-shortcuts" | "ios-wda") => {
    setError(null);
    try {
      const r = await apiRequest("POST", "/api/ios/pair/start", { kind });
      const data = (await r.json()) as PairingCodeResponse;
      setPairing({ kind, code: data.code, expiresAt: data.expiresAt });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggleArmed = async (d: IosDevice) => {
    try {
      await apiRequest("PATCH", `/api/ios/devices/${d.id}`, { armed: !d.armed });
      await refresh();
    } catch (e: any) { setError(e.message); }
  };

  const revoke = async (d: IosDevice) => {
    if (!confirm(`Revoke ${d.name}? The device will stop working immediately.`)) return;
    try {
      await apiRequest("DELETE", `/api/ios/devices/${d.id}`);
      await refresh();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="p-2 font-mono text-xs" data-testid="ios-devices-panel">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-muted-foreground">iOS DEVICES</span>
        <button
          data-testid="button-pair-shortcuts"
          className="px-2 py-0.5 border border-border hover:bg-primary/10 cursor-pointer"
          onClick={() => startPair("ios-shortcuts")}
        >
          + Shortcuts
        </button>
        <button
          data-testid="button-pair-wda"
          className="px-2 py-0.5 border border-border hover:bg-primary/10 cursor-pointer"
          onClick={() => startPair("ios-wda")}
        >
          + WDA
        </button>
        <button
          data-testid="button-refresh-devices"
          className="px-2 py-0.5 border border-border hover:bg-primary/10 cursor-pointer ml-auto"
          onClick={refresh}
        >
          refresh
        </button>
      </div>

      {error && <div className="text-red-400 mb-2" data-testid="text-error">{error}</div>}

      {pairing && (
        <div className="border border-yellow-500/40 bg-yellow-500/10 p-2 mb-2" data-testid="pairing-code-card">
          <div className="text-yellow-300 font-bold">Pairing code for {pairing.kind}</div>
          <div className="text-2xl font-bold tracking-widest my-1" data-testid="text-pairing-code">{pairing.code}</div>
          <div className="text-muted-foreground text-[10px]">
            Enter this code on the iPhone bridge (Shortcuts) or in <code>tools/ios-wda/.env</code> (WDA).
            Expires {new Date(pairing.expiresAt).toLocaleTimeString()}.
          </div>
          <button
            data-testid="button-dismiss-pairing"
            className="mt-1 underline cursor-pointer"
            onClick={() => setPairing(null)}
          >
            dismiss
          </button>
        </div>
      )}

      {loading && <div className="text-muted-foreground" data-testid="text-loading">Loading…</div>}

      {!loading && devices.length === 0 && (
        <div className="text-muted-foreground py-2" data-testid="text-empty">
          No iOS devices paired yet. Click + Shortcuts or + WDA to begin.
        </div>
      )}

      {devices.map(d => (
        <div key={d.id} className="flex items-center gap-2 py-1 border-b border-border/30" data-testid={`row-device-${d.id}`}>
          <span className="text-[10px] text-muted-foreground w-20 shrink-0">{d.kind}</span>
          <span className="flex-1 truncate">{d.name}</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {d.lastSeen ? `seen ${new Date(d.lastSeen).toLocaleTimeString()}` : "never seen"}
          </span>
          <button
            data-testid={`button-toggle-armed-${d.id}`}
            className={`px-1.5 py-0.5 text-[10px] cursor-pointer ${
              d.armed ? "bg-red-500/20 text-red-300" : "bg-blue-500/20 text-blue-300"
            }`}
            onClick={() => toggleArmed(d)}
          >
            {d.armed ? "ARMED" : "echo-only"}
          </button>
          <button
            data-testid={`button-revoke-${d.id}`}
            className="px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-400/10 cursor-pointer"
            onClick={() => revoke(d)}
          >
            revoke
          </button>
        </div>
      ))}
    </div>
  );
}
