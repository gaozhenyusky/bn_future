type QueueTask<T = unknown> = {
  key: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class RateLimitedQueue {
  private readonly concurrency: number;
  // 保持插入顺序，同时支持按 key 去重：同一 key 已在等待（pending）或
  // 执行中（inflight）就不再入队，返回同一个 promise。
  private readonly pendingTasks = new Map<string, QueueTask>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private activeCount = 0;

  constructor(options: { concurrency: number }) {
    if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error("RateLimitedQueue concurrency must be a positive integer");
    }

    this.concurrency = options.concurrency;
  }

  get size(): number {
    return this.pending.size + this.activeCount;
  }

  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const waiting = this.pending.get(key);
    if (waiting) {
      return waiting as Promise<T>;
    }

    const deferred = createDeferred<T>();
    const task: QueueTask<T> = {
      key,
      run,
      resolve: deferred.resolve,
      reject: deferred.reject,
    };
    this.pendingTasks.set(key, task as QueueTask);
    this.pending.set(key, deferred.promise);
    this.drain();

    this.inflight.set(key, deferred.promise);
    void deferred.promise.then(
      () => {
        this.inflight.delete(key);
      },
      () => {
        this.inflight.delete(key);
      },
    );

    return deferred.promise;
  }

  private drain() {
    while (this.activeCount < this.concurrency && this.pendingTasks.size > 0) {
      const firstKey = this.pendingTasks.keys().next().value as string | undefined;
      if (firstKey === undefined) {
        return;
      }

      const task = this.pendingTasks.get(firstKey);
      this.pendingTasks.delete(firstKey);
      this.pending.delete(firstKey);
      if (!task) {
        continue;
      }

      this.activeCount += 1;
      void this.runTask(task as QueueTask);
    }
  }

  private async runTask(task: QueueTask) {
    try {
      task.resolve(await task.run());
    } catch (error) {
      task.reject(error);
    } finally {
      this.activeCount -= 1;
      this.drain();
    }
  }
}
