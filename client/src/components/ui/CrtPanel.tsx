import React from "react";
import { useCrtTheme } from "@/lib/crt-theme";

interface CrtPanelProps {
  children: React.ReactNode;
  className?: string;
  scanlineIntensity?: number;
  noiseIntensity?: number;
  glowBar?: boolean;
  style?: React.CSSProperties;
}

export default function CrtPanel({
  children,
  className = "",
  scanlineIntensity = 0.06,
  noiseIntensity = 0.15,
  glowBar = true,
  style,
}: CrtPanelProps) {
  const { t } = useCrtTheme();

  return (
    <div
      className={`crt-panel relative overflow-hidden ${className}`}
      style={{
        background: t.bg,
        ...style,
      }}
    >
      {children}

      <div
        className="pointer-events-none absolute inset-0 z-[2]"
        style={{
          background: `repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(0,0,0,${scanlineIntensity}) 1px, rgba(0,0,0,${scanlineIntensity}) 2px)`,
        }}
      />

      <div
        className="pointer-events-none absolute inset-0 z-[3]"
        style={{
          background: `radial-gradient(ellipse at center, transparent 70%, rgba(0,0,0,0.25) 100%)`,
        }}
      />

      {noiseIntensity > 0 && (
        <div
          className="pointer-events-none absolute inset-0 z-[5] crt-noise-layer"
          style={{
            opacity: noiseIntensity * 0.2,
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            backgroundSize: "80px 80px",
            mixBlendMode: "overlay",
          }}
        />
      )}

      {glowBar && (
        <div
          className="pointer-events-none absolute left-0 right-0 h-[4px] z-[4] crt-glowbar-anim"
          style={{
            background: `linear-gradient(180deg, transparent, rgba(${t.glow}, 0.04), transparent)`,
          }}
        />
      )}
    </div>
  );
}
