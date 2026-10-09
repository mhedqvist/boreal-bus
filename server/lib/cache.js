// Small in-memory TTL cache. When full, the oldest-inserted entry is evicted.
export class TtlCache {
  constructor({ maxEntries = 1000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  get size() {
    return this.entries.size;
  }
}
