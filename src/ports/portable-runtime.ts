import type {
  RuntimeObserver,
  RuntimePublisher,
} from '../semantic/runtime-provenance.js';

export interface PortableRuntimePorts {
  readonly publisher: RuntimePublisher;
  readonly observer: RuntimeObserver;
}