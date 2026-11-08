// The bridge alarm panel: each alarm is raised by a sensor condition and
// stays on the list until it has cleared AND been acknowledged, as on a real
// alarm and monitoring system. Unacknowledged alarms sound the buzzer.

export class Alarms {
  constructor() {
    this.list = new Map();     // id -> { id, text, sev, active, acked, since }
    this.version = 0;
  }

  // Report a condition every frame (or when it changes).
  set(id, active, text, sev = 'alarm') {
    let a = this.list.get(id);
    if (active) {
      if (!a) {
        a = { id, text, sev, active: true, acked: false, since: Date.now() };
        this.list.set(id, a);
        this.version++;
      } else {
        if (!a.active) { a.active = true; a.acked = false; a.since = Date.now(); this.version++; }
        if (text && a.text !== text) { a.text = text; this.version++; }
      }
    } else if (a && a.active) {
      a.active = false;
      if (a.acked) this.list.delete(id);
      this.version++;
    }
  }

  ack(id) {
    const a = this.list.get(id);
    if (!a) return;
    a.acked = true;
    if (!a.active) this.list.delete(id);
    this.version++;
  }

  ackAll() {
    for (const id of [...this.list.keys()]) this.ack(id);
  }

  get unacked() {
    let n = 0;
    for (const a of this.list.values()) if (!a.acked) n++;
    return n;
  }

  // most urgent first: unacknowledged, then alarms before warnings, newest
  sorted() {
    return [...this.list.values()].sort((a, b) => (a.acked - b.acked) || ((a.sev === 'alarm' ? 0 : 1) - (b.sev === 'alarm' ? 0 : 1)) || (b.since - a.since));
  }
}
