import type { LogStore } from "./db/store";

export interface RetentionWorkerOptions {
  retentionDays: number;
  intervalMs: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

/** Runs retention out of band so ingestion requests never wait for cleanup. */
export class RetentionWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  public constructor(private readonly store: LogStore, private readonly options: RetentionWorkerOptions) {}

  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.options.onError?.(error));
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  public async runOnce(now = this.options.now?.() ?? new Date()): Promise<number | null> {
    if (this.running) {
      return null;
    }
    this.running = true;
    try {
      const cutoff = new Date(now.getTime() - this.options.retentionDays * 24 * 60 * 60 * 1000);
      return await this.store.deleteBefore(cutoff);
    } finally {
      this.running = false;
    }
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
