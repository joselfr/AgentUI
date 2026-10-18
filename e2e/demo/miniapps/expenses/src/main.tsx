import { useState } from 'react';
import { Page, Card, Stack, Row, Text, Button, TextField, Select, List, ListItem, IconButton, Spinner, EmptyState, Alert, Chart, useApi, api, useLang } from '@agentui/ui';
import './styles.css';

type Expense = { id: string; label: string; amount: number; category: string; date: string };

const T = {
  fr: { title: 'Dépenses', month: 'Total du mois', count: 'Dépenses', byCat: 'Par catégorie', label: 'Libellé', amount: 'Montant', category: 'Catégorie', add: 'Ajouter', recent: 'Dernières dépenses', empty: 'Aucune dépense', cats: { food: 'Courses', transport: 'Transport', home: 'Maison', fun: 'Loisirs' }, del: 'Supprimer' },
  en: { title: 'Expenses', month: 'Month total', count: 'Expenses', byCat: 'By category', label: 'Label', amount: 'Amount', category: 'Category', add: 'Add', recent: 'Latest expenses', empty: 'No expenses', cats: { food: 'Groceries', transport: 'Transport', home: 'Home', fun: 'Leisure' }, del: 'Delete' },
};
const COLORS: Record<string, string> = { food: 'var(--au-accent)', transport: 'var(--au-secondary)', home: 'var(--au-warning)', fun: 'var(--au-info)' };

export default function App() {
  const lang = useLang();
  const t = lang.startsWith('fr') ? T.fr : T.en;
  const list = useApi<Expense[]>('expenses');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('food');
  const eur = (n: number) => new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(n);

  const add = async () => {
    if (!label.trim() || !(Number(amount) > 0)) return;
    await api.post('expenses', { label, amount: Number(amount), category });
    setLabel(''); setAmount('');
    list.reload();
  };

  const data = list.data ?? [];
  const total = data.reduce((s, e) => s + e.amount, 0);
  const cats = Object.keys(t.cats) as (keyof typeof t.cats)[];
  const sums = cats.map((c) => data.filter((e) => e.category === c).reduce((s, e) => s + e.amount, 0));

  return (
    <Page title={t.title}>
      <Stack>
        <div className="stats">
          <Card><div className="label">{t.month}</div><div className="value accent">{eur(total)}</div></Card>
          <Card><div className="label">{t.count}</div><div className="value">{data.length}</div></Card>
        </div>

        {list.loading && <Spinner center />}
        {list.error && <Alert severity="error">{list.error.message}</Alert>}

        <Card>
          <Text variant="subtitle">{t.byCat}</Text>
          <div style={{ marginTop: 8 }}>
            <Chart type="bar" labels={cats.map((c) => t.cats[c])} series={[{ name: t.byCat, data: sums.map((v) => Math.round(v * 100) / 100) }]} height={190} />
          </div>
        </Card>

        <Card>
          <div className="add">
            <TextField label={t.label} value={label} onChange={setLabel} onEnter={add} />
            <TextField label={t.amount} type="number" value={amount} onChange={setAmount} onEnter={add} />
            <Select label={t.category} value={category} onChange={setCategory} options={cats.map((c) => ({ value: c, label: t.cats[c] }))} />
            <Button icon="add" onClick={add}>{t.add}</Button>
          </div>
        </Card>

        <Text variant="subtitle">{t.recent}</Text>
        {!list.loading && data.length === 0 && <EmptyState icon="finance" title={t.empty} />}
        <Card padding={4}>
          <List>
            {data.slice(0, 8).map((e) => (
              <ListItem key={e.id}
                leading={<span className="cat-dot" style={{ background: COLORS[e.category] ?? 'var(--au-muted)' }} />}
                primary={e.label}
                secondary={`${t.cats[e.category as keyof typeof t.cats] ?? e.category} · ${new Date(e.date).toLocaleDateString(lang, { day: 'numeric', month: 'short' })}`}
                trailing={<Row gap={4}><span className="row-amount">{eur(e.amount)}</span><IconButton icon="delete" label={t.del} onClick={async () => { await api.delete(`expenses/${e.id}`); list.reload(); }} /></Row>} />
            ))}
          </List>
        </Card>
      </Stack>
    </Page>
  );
}
