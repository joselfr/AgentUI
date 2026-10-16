import { describe, expect, it } from 'vitest';
import { parseCode } from './CodeCard';

describe('parseCode : highlight', () => {
  it('accepte numéros, numéros en chaîne et plages', () => {
    const c = parseCode({ code: 'a\nb\nc\nd\ne\nf\ng\nh', highlight: [4, '7', '2-3', ' 5 '] });
    expect([...c!.highlight].sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 7]);
  });
  it('rejette ce qui n\'est pas une ligne ou une plage', () => {
    for (const h of [['x'], ['0'], ['5-3'], ['1-'], [1.5], 'abc']) expect(parseCode({ code: 'a', highlight: h })).toBeUndefined();
  });
});
