// Runs worker(item) over items with bounded concurrency. Never rejects:
// each result is { status: 'fulfilled', value } or { status: 'rejected', reason },
// in the same order as items.
export async function runPooled(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
