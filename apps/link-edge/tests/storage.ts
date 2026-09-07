// A serialized, transactional storage model for deterministic unit tests.
export function storageState() {
  const records = new Map<string, unknown>();
  let alarm: number | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  const storage = {
    async get(key: string) {
      return structuredClone(records.get(key));
    },
    async put(key: string, value: unknown) {
      records.set(key, structuredClone(value));
    },
    async setAlarm(value: number) {
      alarm = value;
    },
    async getAlarm() {
      return alarm;
    },
    async deleteAll() {
      records.clear();
      alarm = null;
    },
    async transaction<T>(
      callback: (txn: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> {
      const before = structuredClone(records);
      const previousAlarm = alarm;
      try {
        return await callback(storage as unknown as DurableObjectTransaction);
      } catch (error) {
        records.clear();
        for (const [key, value] of before) records.set(key, value);
        alarm = previousAlarm;
        throw error;
      }
    },
  };
  const state = {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      const result = pending.then(callback);
      pending = result.catch(() => {});
      return result;
    },
  };
  return { records, storage, state: state as unknown as DurableObjectState };
}
