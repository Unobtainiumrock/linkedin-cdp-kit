import type { DiscoveryBatch, DiscoverySource } from '../src/pipeline/discovery.js';

/**
 * Example custom discovery source — register in your hooks or CLI wiring.
 */
export class ExampleRangeSource implements DiscoverySource {
  readonly id = 'example-range';
  constructor(
    private readonly slugs: Array<{ slug: string; name: string }>,
    private cursor = 0,
  ) {}

  fetchBatch(cursor: string | null, budget: number): DiscoveryBatch {
    const start = cursor ? Number.parseInt(cursor, 10) : this.cursor;
    const slice = this.slugs.slice(start, start + budget);
    const next = start + slice.length;
    return {
      candidates: slice.map((s) => ({ ...s, sourceId: this.id })),
      nextCursor: next >= this.slugs.length ? null : String(next),
      exhausted: next >= this.slugs.length,
    };
  }
}

export default { ExampleRangeSource };