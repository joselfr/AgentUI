// Demo miniapps created by the fake agent through the same `miniapp.op` frames a real plugin sends
// (sources in e2e/demo/miniapps/<id>/{src,server}); the data is seeded with the `data` op.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('./miniapps/', import.meta.url).pathname;
const filesOf = (id) => {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, id, rel))) {
      const r = `${rel}/${e}`;
      if (statSync(join(root, id, r)).isDirectory()) walk(r);
      else out.push({ path: r, content: readFileSync(join(root, id, r), 'utf8') });
    }
  };
  for (const d of ['src', 'server']) walk(d);
  return out;
};

const ago = (days, h = 12) => { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const dayStr = (days) => ago(days).slice(0, 10);

const EXPENSES = [
  ['Courses Marché', 'Farmers market', 54.8, 'food', 0], ['Pass Navigo', 'Transit pass', 86.4, 'transport', 1], ['Restaurant Chez Léon', 'Dinner at Leon’s', 42.0, 'fun', 2],
  ['Électricité', 'Electricity', 71.35, 'home', 3], ['Boulangerie', 'Bakery', 8.6, 'food', 4], ['Cinéma', 'Cinema', 24.0, 'fun', 5],
  ['Covoiturage Lyon', 'Carpool to Lyon', 19.0, 'transport', 6], ['Courses Supermarché', 'Supermarket', 97.2, 'food', 8], ['Ampoules LED', 'LED bulbs', 18.9, 'home', 9], ['Concert', 'Concert', 38.0, 'fun', 11],
];

export const DEMO_MINIAPPS = (lang) => {
  const fr = lang !== 'en';
  return [
    {
      id: 'expenses', name: fr ? 'Dépenses' : 'Expenses', icon: 'finance',
      description: fr ? 'Suivi des dépenses du mois, par catégorie' : 'Monthly spending tracker by category',
      files: filesOf('expenses'),
      seed: EXPENSES.map(([fr_, en_, amount, category, d]) => ({ collection: 'expenses', doc: { label: fr ? fr_ : en_, amount, category, date: ago(d) } })),
    },
    {
      id: 'habits', name: fr ? 'Habitudes' : 'Habits', icon: 'checklist',
      description: fr ? 'Cochez vos habitudes jour après jour' : 'Tick off your habits day after day',
      files: filesOf('habits'),
      seed: [
        { collection: 'habits', doc: { name: fr ? 'Marcher 30 min' : 'Walk 30 min', emoji: '🚶', days: [0, 1, 2, 4, 5].map(dayStr) } },
        { collection: 'habits', doc: { name: fr ? 'Lire' : 'Read', emoji: '📖', days: [1, 2, 3, 5].map(dayStr) } },
        { collection: 'habits', doc: { name: fr ? 'Méditer' : 'Meditate', emoji: '🧘', days: [0, 2, 6].map(dayStr) } },
      ],
    },
  ];
};
