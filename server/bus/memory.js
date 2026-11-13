// In-process fan-out. Give several buses the same hub to simulate several servers in one process.
import { EventEmitter } from 'node:events';

export class MemoryBus {
  constructor(hub = new EventEmitter()) {
    this.hub = hub; this.hub.setMaxListeners(0);
    this.subs = new Map();
    this.onMessage = () => {};
  }
  async init() { return true; }
  async ping() {}
  async close() { for (const [code, fn] of this.subs) this.hub.off(code, fn); this.subs.clear(); }
  async subscribe(code) {
    if (this.subs.has(code)) return;
    const fn = raw => { const m = JSON.parse(raw); this.onMessage(code, m.v, m.G); };
    this.subs.set(code, fn); this.hub.on(code, fn);
  }
  async unsubscribe(code) { const fn = this.subs.get(code); if (fn) { this.hub.off(code, fn); this.subs.delete(code); } }
  /** `json` is the already-serialised room state. */
  async publish(code, v, json) { const raw = `{"v":${v},"G":${json}}`; queueMicrotask(() => this.hub.emit(code, raw)); }
}
