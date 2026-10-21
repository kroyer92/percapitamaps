// One lane of heavy work at a time (RENDER_CONCURRENCY), so the language model and the
// renderer never compete for the server's RAM.
import { config } from '../config.js';

type Task = { label: string; run: () => Promise<void> };

class WorkQueue {
  private pending: Task[] = [];
  private running = new Set<string>();

  add(label: string, run: () => Promise<void>): number {
    this.pending.push({ label, run });
    this.pump();
    return this.pending.length;
  }

  status() {
    return { running: [...this.running], waiting: this.pending.map((t) => t.label) };
  }

  private pump() {
    while (this.running.size < config.renderConcurrency && this.pending.length) {
      const task = this.pending.shift()!;
      this.running.add(task.label);
      task.run()
        .catch((e) => console.error(`[queue] ${task.label} failed:`, e))
        .finally(() => {
          this.running.delete(task.label);
          this.pump();
        });
    }
  }
}

export const queue = new WorkQueue();
