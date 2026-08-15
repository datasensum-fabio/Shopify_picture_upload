export async function runConcurrent(items, concurrency, worker, onProgress = () => {}) {
  if (!items.length) return;
  let nextIndex = 0;
  let completed = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
      completed++;
      onProgress(completed, items.length, index);
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, runWorker));
}
