// English demo content for fake-agent.mjs (DEMO_LANG=en): same structure as content.fr.mjs.
const now = Date.now();
/** Demo scheduled tasks ("Tasks" page): their dedicated chat receives the cron messages. */
export const JOBS = [
  { id: 'j1', name: 'Morning briefing', schedule: 'every day at 7:30 am', mode: 'agent', prompt: 'Summarize my calendar, my important emails and today’s weather.', enabled: true, nextRunAt: now + 14 * 3600e3, lastRunAt: now - 10 * 3600e3, lastStatus: 'ok', deliverTo: 'cron-morning-briefing' },
  { id: 'j2', name: 'Competitor watch', schedule: 'every hour', mode: 'agent', prompt: 'Watch competitors’ announcements and only notify me if there is something new.', enabled: true, nextRunAt: now + 35 * 60e3, lastRunAt: now - 25 * 60e3, lastStatus: 'ok', deliverTo: 'cron-watch' },
  { id: 'j3', name: 'Nightly backup', schedule: 'every day at 3 am', mode: 'script', script: 'backup.sh --all', enabled: true, nextRunAt: now + 12 * 3600e3, lastRunAt: now - 12 * 3600e3, lastStatus: 'error', lastError: 'Script exited with code 1\nstderr:\nrsync: write failed: No space left on device (28)', deliverTo: 'cron-backup' },
];

/** Proactive cron messages sent to the connection: each one arrives in the dedicated "⏰ name" chat. */
export const CRON_MESSAGES = [
  { conversationId: 'cron-watch', title: '⏰ Competitor watch', text: 'Nothing new from your competitors since the last check.' },
  { conversationId: 'cron-backup', title: '⏰ Nightly backup', text: '⚠️ **The backup failed**: no space left on the disk (98%).\n\nI can free up space by deleting the old backups — tell me if you want me to take care of it.' },
  { conversationId: 'cron-morning-briefing', title: '⏰ Morning briefing', text: '**Good morning! Here is your day.**\n\n- 🗓️ **9:30 am** — Aerotech client meeting (Clément Ader room)\n- ✉️ 3 important emails, including a reply from the accountant\n- ☀️ 21 °C and sunny in Toulouse\n\n```widget\n{"type":"table","arguments":{"title":"Today’s schedule","columns":[{"label":"Time"},{"label":"Appointment"},{"label":"Place"}],"rows":[["09:30","Aerotech client meeting","Clément Ader room"],["12:30","Lunch with Sigma","Le Bibent"],["15:00","Project review","Video call"]]}}\n```' },
];

/** Scenarios: the first one whose keyword appears in the user's message is played. */
export const SCENARIOS = [
  {
    match: /sales|revenue/i,
    intro: 'Here is the revenue trend, compared with last year.',
    tools: [
      ['chart', { kind: 'line', title: 'Monthly revenue', unit: ' k€', x: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'], series: [{ name: '2025', y: [82, 88, 91, 97, 104, 99, 93, 90, 108] }, { name: '2026', y: [96, 103, 112, 121, 130, 128, 124, 119, 141] }] }],
    ],
    outro: 'September reaches **141 k€**, which is **+31%** compared with last year.',
  },
  {
    match: /compar|table/i,
    intro: 'Here is the comparison of the four plans, sortable by column.',
    tools: [
      ['table', { title: 'Plan comparison', caption: 'Monthly prices excl. VAT, October 2026', columns: [{ label: 'Plan' }, { label: 'Users', kind: 'number' }, { label: 'Storage', kind: 'number', unit: ' GB' }, { label: 'Price', kind: 'number', unit: ' €' }, { label: 'Support' }], rows: [['Starter', 5, 50, 19, 'Email'], ['Team', 25, 500, 79, 'Chat'], ['Business', 100, 2000, 249, 'Priority'], ['Enterprise', 500, 10000, 890, 'Dedicated']] }],
    ],
    outro: 'The **Team** plan has the best price per user (€3.16).',
  },
  {
    match: /route|visit|map/i,
    intro: 'Here is the day’s route, from the station to the last appointment.',
    tools: [
      ['map', { title: 'Thursday round', maps: true, points: [
        { lat: 43.6047, lon: 1.4442, title: 'Toulouse Matabiau', text: 'Departure **8:10 am**' },
        { lat: 43.6108, lon: 1.4537, title: 'Client Aerotech', text: 'Meeting **9:30 am**, Clément Ader room', maps: true },
        { lat: 43.5962, lon: 1.4380, title: 'Lunch — Le Bibent', text: 'Table booked at **12:30 pm**', maps: true },
        { lat: 43.5640, lon: 1.4670, title: 'Supplier Sigma', text: 'Meeting **3:00 pm**' },
      ] }],
    ],
    outro: 'About **45 minutes** of travel in total, by metro and on foot.',
  },
  {
    match: /migrat|deploy/i,
    intro: 'Here we go, I’m starting the migration and I’ll keep you posted.',
    progress: { title: 'Migration to the new database', steps: [
      ['Backing up the current database', '2.4 GB dump'],
      ['Creating the new schema', 'Version 14'],
      ['Copying the data', '1,280,000 rows out of 1,800,000'],
      ['Integrity check', ''],
      ['Switching traffic over', ''],
    ] },
    outro: 'The migration is complete, with no downtime.',
  },
  {
    match: /code|script|fix/i,
    intro: 'I found the cause of the bug: the date was read in the wrong time zone.',
    tools: [
      ['code', { filename: 'src/booking.ts', language: 'diff', start: 41, code: ' export function startOfDay(date: Date) {\n-  return new Date(date.setHours(0, 0, 0, 0));\n+  const d = new Date(date);\n+  d.setUTCHours(0, 0, 0, 0);\n+  return d;\n }', highlight: ['2-5'] }],
    ],
    outro: 'The fix no longer modifies the date passed as a parameter. Shall I run the tests?',
  },
  {
    match: /delet|clean/i,
    intro: 'I’m ready to clean up the old backups.',
    blocking: ['confirm', { title: 'Delete 14 backups older than 90 days?', text: 'This frees **38 GB** on the server. The 3 most recent ones are kept. This action is permanent.', danger: true, yes: 'Delete', no: 'Keep' }],
  },
  {
    match: /trip|travel|book/i,
    intro: 'To prepare this trip, I need a few details.',
    blocking: ['form', { title: 'Plan the trip', text: 'I’ll book as soon as you confirm.', submit: 'Start the search', fields: [
      { name: 'dest', label: 'Destination', placeholder: 'City', required: true },
      { name: 'date', label: 'Departure', kind: 'date', required: true },
      { name: 'class', label: 'Comfort', kind: 'select', options: ['Economy', 'Comfort', 'Business'], default: 'Comfort' },
      { name: 'bag', label: 'Checked baggage', kind: 'checkbox' },
    ] }],
  },
];

export const FALLBACK = { intro: 'Got it! Tell me *sales*, *comparison*, *route*, *migration*, *code*, *delete* or *trip* to see the widgets.' };

export const REASONING = 'Let me look at what needs to be displayed.';
export const ACK = 'Understood, noted. I’m on it!';
