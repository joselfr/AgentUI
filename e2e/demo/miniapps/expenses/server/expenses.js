// Handlers of the demo "Expenses" miniapp: list / add / remove, data kept in the miniapp's own collection.
export function GET(req, ctx) {
  return ctx.db.collection('expenses').find({}, { sort: 'date', desc: true });
}
export function POST(req, ctx) {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!String(b.label || '').trim() || !(amount > 0)) return ctx.status(400, { error: 'label and a positive amount are required' });
  return ctx.db.collection('expenses').insert({ label: String(b.label).trim().slice(0, 80), amount, category: String(b.category || 'other'), date: new Date().toISOString() });
}
export function DELETE(req, ctx) {
  ctx.db.collection('expenses').remove(req.path.slice(1));
  return { ok: true };
}
