import { Page, Card, Stack, Row, Text, Chip, Spinner, useApi, api, useLang } from '@agentui/ui';

type Habit = { id: string; name: string; emoji: string; days: string[] };

const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10); };

export default function App() {
  const lang = useLang();
  const fr = lang.startsWith('fr');
  const habits = useApi<Habit[]>('habits');
  const days = [6, 5, 4, 3, 2, 1, 0].map(day);
  const toggle = async (h: Habit, d: string) => { await api.post('habits', { id: h.id, day: d }); habits.reload(); };
  const streak = (h: Habit) => { let n = 0; while (h.days.includes(day(n))) n++; return n; };

  return (
    <Page title={fr ? 'Habitudes' : 'Habits'}>
      <Stack>
        {habits.loading && <Spinner center />}
        {habits.data?.map((h) => (
          <Card key={h.id}>
            <Stack gap={10}>
              <Row justify="space-between">
                <Text variant="subtitle">{h.emoji} {h.name}</Text>
                <Chip color={streak(h) >= 3 ? 'success' : undefined} label={`${streak(h)} ${fr ? 'j. de suite' : 'day streak'}`} />
              </Row>
              <Row gap={6}>
                {days.map((d) => {
                  const done = h.days.includes(d);
                  return (
                    <button key={d} onClick={() => toggle(h, d)} aria-label={d} aria-pressed={done}
                      style={{ flex: 1, minWidth: 0, height: 44, borderRadius: 'var(--au-radius-sm)', cursor: 'pointer', border: '1px solid var(--au-line)',
                        background: done ? 'var(--au-accent)' : 'var(--au-raised)', color: done ? 'var(--au-on-accent)' : 'var(--au-muted)', font: 'inherit', fontSize: '.857rem', fontWeight: 600 }}>
                      {new Date(d).toLocaleDateString(lang, { weekday: 'narrow' })}
                    </button>
                  );
                })}
              </Row>
            </Stack>
          </Card>
        ))}
      </Stack>
    </Page>
  );
}
