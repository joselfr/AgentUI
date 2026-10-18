import { useState } from 'react';
import { load, save } from '../../storage';

/** Boolean (collapsed/expanded section…) remembered in the browser. */
export function usePersistedToggle(key: string, initial = false): [boolean, () => void] {
  const [on, setOn] = useState(() => load(key, initial));
  return [on, () => setOn((o) => { save(key, !o); return !o; })];
}
