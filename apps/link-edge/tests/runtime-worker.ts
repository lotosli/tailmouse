import { ShortInvitation as ProductionShortInvitation } from '../src/short-invitation.ts';
export { default } from '../src/index.ts';

// This class is only selected by the local integration test's inline config.
// Production fetch/alarm behavior is inherited without an HTTP testing route.
export class ShortInvitation extends ProductionShortInvitation {
  async inspectForTest() {
    const values = await this.ctx.storage.list();
    return JSON.stringify({
      keys: [...values.keys()],
      ...(values.has('mapping') ? { mapping: values.get('mapping') } : {}),
      alarm: await this.ctx.storage.getAlarm(),
    });
  }

  async expireForTest(scheduleCleanup: boolean): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const mapping =
        await this.ctx.storage.get<Record<string, unknown>>('mapping');
      if (!mapping) throw new Error('Synthetic mapping is missing.');
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.put('mapping', {
          ...mapping,
          expiresAt: Date.now() - 1,
        });
        if (scheduleCleanup) await transaction.setAlarm(Date.now() + 20);
      });
    });
  }

  async earlyAlarmForTest(): Promise<void> {
    await super.alarm();
  }

  async failedCleanupForTest(): Promise<string> {
    const storage = this.ctx.storage;
    const deleteAll = storage.deleteAll;
    storage.deleteAll = () =>
      Promise.reject(new Error('SYNTHETIC_PRIVATE_STORAGE_FAILURE'));
    try {
      await super.alarm();
      return 'unexpected_success';
    } catch (error) {
      return error instanceof Error ? error.message : 'unexpected_error';
    } finally {
      storage.deleteAll = deleteAll;
    }
  }
}
