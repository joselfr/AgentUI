import { useEffect, useMemo, useState } from 'react';
import type { Capabilities } from '@agentui/shared';
import { checkFile, isImage } from '../../attachments';

/** Fichiers en cours de rédaction : validation selon les capacités de l'agent, aperçus des images, message d'erreur. */
export function useAttachments(attach: Capabilities['attachments']) {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const previews = useMemo(() => files.map((f) => (isImage(f.type) ? URL.createObjectURL(f) : '')), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);
  return {
    files, previews, error,
    add: (list: FileList | File[]) => {
      let next = files; const errs: string[] = [];
      for (const f of Array.from(list)) { const e = checkFile(f, next, attach); if (e) errs.push(e); else next = [...next, f]; }
      setFiles(next); setError(errs.join(' '));
    },
    remove: (i: number) => setFiles(files.filter((_, j) => j !== i)),
    clear: () => { setFiles([]); setError(''); },
    restore: (f: File[]) => setFiles(f),
    dismissError: () => setError(''),
  };
}
