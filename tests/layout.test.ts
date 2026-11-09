import { describe, it, expect } from 'vitest';
import { separateRegions } from '../src/ui/layout';
import { sortRegions, type Region } from '../src/engine/model';

describe('Bereiche trennen', () => {
  it('removes overlaps and keeps the evaluation order', () => {
    const regions: Region[] = [
      { id: 'a', type: 'math', x: 0, y: 0, src: 'a' },
      { id: 'b', type: 'math', x: 100, y: 10, src: 'b' },   // overlaps a (a is wide)
      { id: 'c', type: 'math', x: 300, y: 10, src: 'c' },   // same row as b, no overlap of its own
      { id: 'd', type: 'math', x: 0, y: 30, src: 'd' },
    ];
    const size: Record<string, [number, number]> = { a: [250, 40], b: [80, 20], c: [80, 20], d: [80, 20] };
    const out = separateRegions(regions, r => ({ x: r.x, y: r.y, w: size[r.id][0], h: size[r.id][1] }));
    const boxes = out.map(r => ({ id: r.id, x: r.x, y: r.y, w: size[r.id][0], h: size[r.id][1] }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i], q = boxes[j];
      const overlap = p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;
      expect(overlap, `${p.id}/${q.id}`).toBe(false);
    }
    expect(sortRegions(out).map(r => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(out.find(r => r.id === 'b')!.y).toBe(out.find(r => r.id === 'c')!.y);
  });
});
