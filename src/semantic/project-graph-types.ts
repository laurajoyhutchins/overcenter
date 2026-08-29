import type { CanonicalCommand } from './canonical-commands.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ProjectNodeState = 'DONE' | 'OFF_NOMINAL' | 'WAITING' | 'READY';
export type ProjectBindingPhase = 'ACQUIRE' | 'COMMIT' | 'CONFIRM';

export type OperatorExecutor = {
  readonly kind: 'operator';
  readonly command: CanonicalCommand;
  readonly role?: never;
  readonly skill?: never;
};

export type AgentExecutor = {
  readonly kind: 'agent';
  readonly role: string;
  readonly skill: string;
  readonly command?: never;
};

export type Executor = OperatorExecutor | AgentExecutor;

export type FromPhaseInputSource = {
  readonly from: string;
  readonly literal?: never;
};

export type LiteralPhaseInputSource = {
  readonly literal: JsonValue;
  readonly from?: never;
};

export type PhaseInputSource = FromPhaseInputSource | LiteralPhaseInputSource;

export type PhaseBinding = {
  readonly primitive: CanonicalCommand;
  readonly evidence: readonly string[];
  readonly input: Readonly<Record<string, PhaseInputSource>>;
};

export type PhaseBindings = Readonly<Partial<Record<ProjectBindingPhase, PhaseBinding>>>;