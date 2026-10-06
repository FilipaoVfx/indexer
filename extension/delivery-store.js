/* Single-record journal: a failed write never replaces the last accepted state. */
(() => {
  const KEY = "delivery_state_v2";
  const empty = () => ({ version: 2, queue: [], failed: [], drafts: {}, jobs: {},
    receipts: {}, activity: [], counters: { captured: 0, delivered: 0, failed: 0 } });
  class DeliveryStore {
    constructor(storage) {
      this.storage = storage;
      this.data = empty();
      this.loading = null;
      this.loaded = false;
      this.tail = Promise.resolve();
    }
    load() {
      if (this.loaded) return Promise.resolve(this.data);
      if (!this.loading) {
        this.loading = (async () => {
          const saved = await this.storage.get([KEY, "ingest_queue_v1", "failed_queue_v1",
            "activity_log_v1", "counters_v1", "apiBaseUrl", "userId"]);
          if (saved[KEY]) {
            if (saved[KEY].version !== 2 || !Array.isArray(saved[KEY].queue) ||
                !Array.isArray(saved[KEY].failed)) throw new Error("delivery_journal_invalid");
            this.data = { ...empty(), ...saved[KEY] };
          } else {
            const migrate = item => ({ ...item, userId: item.userId || saved.userId || "local-user",
              apiBaseUrl: item.apiBaseUrl || saved.apiBaseUrl || "https://indexer-hzto.onrender.com",
              nextAttemptAt: 0 });
            const migrated = { ...empty(),
              queue: (saved.ingest_queue_v1 || []).map(migrate),
              failed: (saved.failed_queue_v1 || []).map(migrate),
              activity: saved.activity_log_v1 || [],
              counters: { ...empty().counters, ...(saved.counters_v1 || {}) } };
            await this.storage.set({ [KEY]: migrated });
            this.data = migrated;
            // The v2 journal is durable before obsolete copies are removed.
            await this.storage.remove(["ingest_queue_v1", "failed_queue_v1", "activity_log_v1", "counters_v1"]);
          }
          this.loaded = true;
          return this.data;
        })().catch(error => { this.loading = null; throw error; });
      }
      return this.loading;
    }
    update(change) {
      const operation = this.tail.then(async () => {
        await this.load();
        const draft = structuredClone(this.data);
        const result = change(draft);
        await this.storage.set({ [KEY]: draft });
        this.data = draft;
        return result;
      });
      this.tail = operation.catch(() => {});
      return operation;
    }
  }
  globalThis.IndexerDeliveryStore = DeliveryStore;
})();
