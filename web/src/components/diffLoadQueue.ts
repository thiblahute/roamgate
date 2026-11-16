/** Files one batched request asks for at most (the server takes 32). */
export const DIFF_LOAD_BATCH_MAX = 16;

type Batch<T> = {
  key: string;
  item: unknown;
  run: (items: unknown[]) => Promise<Array<T | Error>>;
};

/** One queue per connection also bounds rapid file selections across panels. */
export function createDiffLoadQueue() {
  const pending: Array<{
    key?: string;
    wanted: () => boolean;
    run: () => Promise<{ diff: string }>;
    batch?: Batch<{ diff: string }>;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }> = [];
  let active = 0;
  let concurrency = 2;
  let fastResponses = 0;
  let scheduled = false;

  const adapt = (elapsed: number, bytes: number) => {
    if (elapsed > 400 || bytes >= 128 * 1024) {
      concurrency = Math.max(1, Math.floor(concurrency / 2));
      fastResponses = 0;
    } else if (elapsed < 100 && bytes < 64 * 1024) {
      fastResponses += 1;
      if (fastResponses >= concurrency * 2) {
        concurrency = Math.min(8, concurrency + 1);
        fastResponses = 0;
      }
    }
  };

  const pump = () => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].wanted()) continue;
      pending.splice(index, 1)[0].reject(new Error("diff request retired"));
    }
    // A batch carries many files in one round trip: two always run at once,
    // whatever the per-file adaptation says, so a slow link never serializes
    // the review.
    while (
      pending.length &&
      active < (pending[0].batch ? Math.max(2, concurrency) : concurrency)
    ) {
      const task = pending.shift()!;
      active += 1;
      const started = performance.now();
      if (task.batch) {
        const batch = task.batch;
        const tasks = [task];
        for (
          let index = 0;
          index < pending.length && tasks.length < DIFF_LOAD_BATCH_MAX;
        ) {
          if (pending[index].batch?.key === batch.key)
            tasks.push(pending.splice(index, 1)[0]);
          else index += 1;
        }
        void batch
          .run(tasks.map((each) => each.batch!.item))
          .then(
            (results) =>
              tasks.forEach((each, index) => {
                const result = results[index];
                if (result instanceof Error) each.reject(result);
                else if (result === undefined)
                  each.reject(new Error("diff request lost"));
                else each.resolve(result);
              }),
            (error: Error) => tasks.forEach((each) => each.reject(error)),
          )
          .finally(() => {
            active -= 1;
            pump();
          });
        continue;
      }
      void task
        .run()
        .then((file) => {
          adapt(performance.now() - started, (file.diff?.length ?? 0) * 2);
          task.resolve(file);
        }, task.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    prioritize(key: string) {
      const index = pending.findIndex((task) => task.key === key);
      if (index > 0) pending.unshift(pending.splice(index, 1)[0]);
    },
    request<T extends { diff: string }>(
      run: () => Promise<T>,
      wanted: () => boolean,
      priority = false,
      key?: string,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const task = { key, run, wanted, resolve, reject };
        if (priority) pending.unshift(task);
        else pending.push(task);
        pump();
      });
    },
    /**
     * Like request, but tasks of one `batch.key` queued together go as one
     * `batch.run` call (up to DIFF_LOAD_BATCH_MAX items). The pump waits a
     * microtask so files asked in one go share a batch.
     */
    requestBatched<T extends { diff: string }>(
      batch: {
        key: string;
        item: unknown;
        run: (items: unknown[]) => Promise<Array<T | Error>>;
      },
      wanted: () => boolean,
      priority = false,
      key?: string,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const task = {
          key,
          run: () => Promise.reject(new Error("batched")),
          batch: batch as Batch<{ diff: string }>,
          wanted,
          resolve,
          reject,
        };
        if (priority) pending.unshift(task);
        else pending.push(task);
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          pump();
        });
      });
    },
  };
}
