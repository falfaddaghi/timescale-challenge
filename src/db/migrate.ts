import { loadConfig } from "../config";
import { createLogStore } from "./factory";

async function migrate(): Promise<void> {
  const config = loadConfig();
  const store = createLogStore(config);
  try {
    await store.migrate();
  } finally {
    await store.close?.();
  }
}

if (require.main === module) {
  void migrate().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { migrate };
