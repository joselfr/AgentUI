import { useEffect, useState } from 'react';
import { Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { AgentInfo, Skill } from '@agentui/shared';
import { api } from '../../api';
import Markdown from '../Markdown';
import { useBackClose } from '../../useBackClose';
import { card, useLoad, Page, Status, Pickers, useScope } from './shared';

/** Popup de lecture d'une skill : son SKILL.md (sans l'en-tête YAML) rendu en Markdown. */
function SkillDialog({ agentId, sub, skill, onClose }: { agentId?: string; sub?: string; skill?: Skill; onClose: () => void }) {
  useBackClose(!!skill, onClose);
  const [state, setState] = useState<{ content?: string; err?: string }>({});
  useEffect(() => {
    setState({});
    if (!skill || !agentId) return;
    let live = true;
    api.skill(agentId, skill.id, sub).then((r) => live && setState({ content: r.content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim() }))
      .catch((e) => live && setState({ err: e instanceof Error ? e.message : String(e) }));
    return () => { live = false; };
  }, [agentId, sub, skill]);
  return (
    <Dialog open={!!skill} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ fontWeight: 650 }}>{skill?.name}</DialogTitle>
      <DialogContent dividers>
        {state.err ? <Typography color="error" variant="body2">{state.err}</Typography>
          : state.content === undefined ? <CircularProgress size={20} />
          : <Markdown>{state.content}</Markdown>}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Fermer</Button></DialogActions>
    </Dialog>);
}

export function SkillsPage({ agents }: { agents: AgentInfo[] }) {
  const sc = useScope(agents, (a) => a.capabilities.skills);
  const skills = useLoad<Skill[]>(() => (sc.agent ? api.skills(sc.agent.id, sc.sub) : Promise.resolve([])), [sc.agent?.id, sc.sub]);
  const [open, setOpen] = useState<Skill>();
  return (
    <Page title="Skills" actions={<Pickers agents={sc.ok} agentId={sc.agent?.id} sub={sc.sub} onAgent={sc.setAgent} onSub={sc.setSub} subs={sc.subs} />}>
      <Status loading={skills.loading} err={skills.err} empty={!sc.agent || !skills.data?.length} />
      <Box sx={{ display: 'grid', gap: 1 }}>
        {skills.data?.map((s) => (
          <Box key={s.id} sx={{ ...card, cursor: 'pointer' }} onClick={() => setOpen(s)}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{s.name}</Typography>
              {s.description && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{s.description}</Typography>}
              {s.category && <Chip size="small" label={s.category} sx={{ mt: 0.75 }} />}
            </Box>
          </Box>))}
      </Box>
      <SkillDialog agentId={sc.agent?.id} sub={sc.sub} skill={open} onClose={() => setOpen(undefined)} />
    </Page>
  );
}
