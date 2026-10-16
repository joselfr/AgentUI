import { useState } from 'react';
import { load, save } from '../../storage';

/** Booléen (section repliée/dépliée…) mémorisé dans le navigateur. */
export function usePersistedToggle(key: string, initial = false): [boolean, () => void] {
  const [on, setOn] = useState(() => load(key, initial));
  return [on, () => setOn((o) => { save(key, !o); return !o; })];
}
