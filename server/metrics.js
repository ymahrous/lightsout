// A small Prometheus text exporter: counters, gauges read on demand, one latency histogram.
const BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];

export class Metrics {
  constructor() { this.counters = new Map(); this.gauges = new Map(); this.hist = new Map(); }
  inc(name, n = 1) { this.counters.set(name, (this.counters.get(name) || 0) + n); }
  gauge(name, read) { this.gauges.set(name, read); }
  observe(name, ms) {
    let h = this.hist.get(name);
    if (!h) { h = { b: new Array(BUCKETS.length + 1).fill(0), sum: 0, n: 0 }; this.hist.set(name, h); }
    let i = 0; while (i < BUCKETS.length && ms > BUCKETS[i]) i++;
    h.b[i]++; h.sum += ms; h.n++;
  }
  get(name) { return this.counters.get(name) || 0; }
  render() {
    const out = [];
    for (const [k, v] of this.counters) out.push(`# TYPE lom_${k}_total counter`, `lom_${k}_total ${v}`);
    for (const [k, read] of this.gauges) out.push(`# TYPE lom_${k} gauge`, `lom_${k} ${read()}`);
    for (const [k, h] of this.hist) {
      out.push(`# TYPE lom_${k}_ms histogram`);
      let acc = 0;
      BUCKETS.forEach((le, i) => { acc += h.b[i]; out.push(`lom_${k}_ms_bucket{le="${le}"} ${acc}`); });
      out.push(`lom_${k}_ms_bucket{le="+Inf"} ${h.n}`, `lom_${k}_ms_sum ${h.sum.toFixed(1)}`, `lom_${k}_ms_count ${h.n}`);
    }
    return out.join('\n') + '\n';
  }
}
