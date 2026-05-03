import type {
  Action,
  Observation,
  ObservationKind,
  SurfaceDescriptor,
  Verifier,
  VerifierResult,
} from "./types";

// ---------------------------------------------------------------------------
// Surface — runtime contract an adapter implements.
//
// `descriptor` is the value-shape registered with the bus. `observe`,
// `act`, and `verify` are the verbs the bus calls. Adapters may throw to
// signal hard failures; verifiers should prefer returning `unknown` over
// throwing when they can't decide.
// ---------------------------------------------------------------------------

export interface Surface {
  readonly descriptor: SurfaceDescriptor;
  observe(kinds: ObservationKind[]): Promise<Observation[]>;
  act(action: Action): Promise<ActResult>;
  verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult>;
  dispose?(): Promise<void> | void;
}

export interface ActResult {
  ok: boolean;
  error?: string;
  observations?: Observation[];
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transport — how a bus reaches a surface.
//
// The in-process transport just calls the Surface directly. A future
// "queue" transport would serialize into the existing control-bus +
// extension-poller queue; a future "websocket" transport would reach a
// remote agent. Callers don't change.
// ---------------------------------------------------------------------------

export interface Transport {
  readonly name: string;
  registerSurface(surface: Surface): void;
  unregisterSurface(surfaceId: string): void;
  listSurfaces(): SurfaceDescriptor[];
  observe(surfaceId: string, kinds: ObservationKind[]): Promise<Observation[]>;
  act(surfaceId: string, action: Action): Promise<ActResult>;
  verify(surfaceId: string, verifier: Verifier, observation?: Observation): Promise<VerifierResult>;
}

export class SurfaceNotFoundError extends Error {
  constructor(public readonly surfaceId: string) {
    super(`Surface not found: ${surfaceId}`);
    this.name = "SurfaceNotFoundError";
  }
}

export class InProcessTransport implements Transport {
  readonly name = "in-process";
  private surfaces = new Map<string, Surface>();

  registerSurface(surface: Surface): void {
    this.surfaces.set(surface.descriptor.id, surface);
  }

  unregisterSurface(surfaceId: string): void {
    const s = this.surfaces.get(surfaceId);
    if (s?.dispose) {
      void Promise.resolve(s.dispose());
    }
    this.surfaces.delete(surfaceId);
  }

  listSurfaces(): SurfaceDescriptor[] {
    return Array.from(this.surfaces.values()).map((s) => s.descriptor);
  }

  private get(surfaceId: string): Surface {
    const s = this.surfaces.get(surfaceId);
    if (!s) throw new SurfaceNotFoundError(surfaceId);
    return s;
  }

  observe(surfaceId: string, kinds: ObservationKind[]): Promise<Observation[]> {
    return this.get(surfaceId).observe(kinds);
  }

  act(surfaceId: string, action: Action): Promise<ActResult> {
    return this.get(surfaceId).act(action);
  }

  verify(surfaceId: string, verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    return this.get(surfaceId).verify(verifier, observation);
  }
}

// ---------------------------------------------------------------------------
// ComputerUseBus — the only thing callers should hold.
//
// The bus is transport-agnostic. Today it wraps `InProcessTransport`; later
// adapters can register against a queue- or socket-backed transport without
// any caller change.
// ---------------------------------------------------------------------------

export class ComputerUseBus {
  constructor(private transport: Transport = new InProcessTransport()) {}

  get transportName(): string {
    return this.transport.name;
  }

  registerSurface(surface: Surface): void {
    this.transport.registerSurface(surface);
  }

  unregisterSurface(surfaceId: string): void {
    this.transport.unregisterSurface(surfaceId);
  }

  listSurfaces(): SurfaceDescriptor[] {
    return this.transport.listSurfaces();
  }

  observe(surfaceId: string, kinds: ObservationKind[]): Promise<Observation[]> {
    return this.transport.observe(surfaceId, kinds);
  }

  act(surfaceId: string, action: Action): Promise<ActResult> {
    return this.transport.act(surfaceId, action);
  }

  verify(surfaceId: string, verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    return this.transport.verify(surfaceId, verifier, observation);
  }
}
