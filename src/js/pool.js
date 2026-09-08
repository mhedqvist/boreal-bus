// Runs async tasks with a bounded concurrency, instead of Promise.all firing
// everything at once - needed here because a full town-wide scan can touch
// 40+ stops or 200+ call ids (see docs/initial_plan.md rate-limit notes).
export async function runPooled(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}
