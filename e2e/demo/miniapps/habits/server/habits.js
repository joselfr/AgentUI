// Handlers of the demo "Habits" miniapp: one document per habit with the list of days it was done.
export function GET(req, ctx) {
  return ctx.db.collection('habits').find({}, { sort: '_createdAt' });
}
export function POST(req, ctx) {
  // toggle a day: { id, day: 'YYYY-MM-DD' }
  const h = ctx.db.collection('habits').get(req.body.id);
  if (!h) return ctx.status(404, { error: 'Unknown habit' });
  const days = h.days.includes(req.body.day) ? h.days.filter((d) => d !== req.body.day) : [...h.days, req.body.day];
  return ctx.db.collection('habits').update(h.id, { days });
}
