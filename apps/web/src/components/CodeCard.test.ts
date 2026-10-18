import { describe, expect, it } from 'vitest';
import { parseCode } from './CodeCard';

describe('parseCode : highlight', () => {
  it('accepts numbers, numeric strings and ranges', () => {
    const c = parseCode({ code: 'a\nb\nc\nd\ne\nf\ng\nh', highlight: [4, '7', '2-3', ' 5 '] });
    expect([...c!.highlight].sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 7]);
  });
  it('rejects anything that is not a line or a range', () => {
    for (const h of [['x'], ['0'], ['5-3'], ['1-'], [1.5], 'abc']) expect(parseCode({ code: 'a', highlight: h })).toBeUndefined();
  });
});
