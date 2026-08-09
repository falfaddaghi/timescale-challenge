import { createApp } from "./http/app";
import { loadConfig } from "./config";
import { createLogStore } from "./db/factory";
import { RetentionWorker } from "./retention";

export async function main(): Promise<void> {
  const config = loadConfig();
  const store = createLogStore(config);
  const app = createApp({
    store,
    bodyLimit: config.bodyLimitBytes,
    ready: false,
    logger: true,
  });
  const retention = new RetentionWorker(store, {
    retentionDays: config.retentionDays,
    intervalMs: config.retentionIntervalMs,
    onError: (error) => app.log.error(error),
  });
  app.addHook("onClose", async () => retention.stop());

  try {
    await store.migrate();
    await store.configureRetention?.(config.retentionDays);
    await store.ping();
    app.markReady();
    await app.listen({ host: config.host, port: config.port });
    retention.start();
  } catch (error) {
    app.log.error(error);
    await app.close().catch(() => undefined);
    throw error;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
