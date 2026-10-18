// French demo content (default) for fake-agent.mjs: scheduled tasks, cron messages, scenarios.
const now = Date.now();
/** Demo scheduled tasks ("Tasks" page): their dedicated chat receives the cron messages. */
export const JOBS = [
  { id: 'j1', name: 'Résumé du matin', schedule: 'tous les jours à 7 h 30', mode: 'agent', prompt: 'Résume mon agenda, mes mails importants et la météo du jour.', enabled: true, nextRunAt: now + 14 * 3600e3, lastRunAt: now - 10 * 3600e3, lastStatus: 'ok', deliverTo: 'cron-resume-matin' },
  { id: 'j2', name: 'Veille concurrents', schedule: 'toutes les heures', mode: 'agent', prompt: 'Surveille les annonces des concurrents et ne me préviens que s’il y a du nouveau.', enabled: true, nextRunAt: now + 35 * 60e3, lastRunAt: now - 25 * 60e3, lastStatus: 'ok', deliverTo: 'cron-veille' },
  { id: 'j3', name: 'Sauvegarde nocturne', schedule: 'tous les jours à 3 h', mode: 'script', script: 'backup.sh --all', enabled: true, nextRunAt: now + 12 * 3600e3, lastRunAt: now - 12 * 3600e3, lastStatus: 'error', lastError: 'Script exited with code 1\nstderr:\nrsync: write failed: No space left on device (28)', deliverTo: 'cron-sauvegarde' },
];

/** Proactive cron messages sent to the connection: each one arrives in the dedicated "⏰ name" chat. */
export const CRON_MESSAGES = [
  { conversationId: 'cron-veille', title: '⏰ Veille concurrents', text: 'Rien de nouveau chez vos concurrents depuis la dernière vérification.' },
  { conversationId: 'cron-sauvegarde', title: '⏰ Sauvegarde nocturne', text: '⚠️ **La sauvegarde a échoué** : plus d’espace disponible sur le disque (98 %).\n\nJe peux libérer de la place en supprimant les anciennes sauvegardes — dites-moi si vous voulez que je m’en charge.' },
  { conversationId: 'cron-resume-matin', title: '⏰ Résumé du matin', text: '**Bonjour ! Voici votre journée.**\n\n- 🗓️ **9 h 30** — Réunion client Aerotech (salle Clément Ader)\n- ✉️ 3 mails importants, dont une réponse du comptable\n- ☀️ 21 °C et ensoleillé à Toulouse\n\n```widget\n{"type":"table","arguments":{"title":"Agenda du jour","columns":[{"label":"Heure"},{"label":"Rendez-vous"},{"label":"Lieu"}],"rows":[["09:30","Réunion client Aerotech","Salle Clément Ader"],["12:30","Déjeuner avec Sigma","Le Bibent"],["15:00","Point projet","Visio"]]}}\n```' },
];

/** Scenarios: the first one whose keyword appears in the user's message is played. */
export const SCENARIOS = [
  {
    match: /ventes|chiffre/i,
    intro: 'Voici l’évolution du chiffre d’affaires, comparée à l’an dernier.',
    tools: [
      ['chart', { kind: 'line', title: 'Chiffre d’affaires mensuel', unit: ' k€', x: ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep'], series: [{ name: '2025', y: [82, 88, 91, 97, 104, 99, 93, 90, 108] }, { name: '2026', y: [96, 103, 112, 121, 130, 128, 124, 119, 141] }] }],
    ],
    outro: 'Le mois de septembre atteint **141 k€**, soit **+31 %** par rapport à l’an dernier.',
  },
  {
    match: /compar|tableau/i,
    intro: 'Voici la comparaison des quatre offres, triable par colonne.',
    tools: [
      ['table', { title: 'Comparatif des offres', caption: 'Tarifs mensuels HT, octobre 2026', columns: [{ label: 'Offre' }, { label: 'Utilisateurs', kind: 'number' }, { label: 'Stockage', kind: 'number', unit: ' Go' }, { label: 'Prix', kind: 'number', unit: ' €' }, { label: 'Support' }], rows: [['Starter', 5, 50, 19, 'Email'], ['Équipe', 25, 500, 79, 'Chat'], ['Business', 100, 2000, 249, 'Prioritaire'], ['Entreprise', 500, 10000, 890, 'Dédié']] }],
    ],
    outro: 'L’offre **Équipe** offre le meilleur rapport prix par utilisateur (3,16 €).',
  },
  {
    match: /itin|rendez|carte|visite/i,
    intro: 'Voici le parcours de la journée, de la gare jusqu’au dernier rendez-vous.',
    tools: [
      ['map', { title: 'Tournée du jeudi', maps: true, points: [
        { lat: 43.6047, lon: 1.4442, title: 'Toulouse Matabiau', text: 'Départ **8 h 10**' },
        { lat: 43.6108, lon: 1.4537, title: 'Client Aerotech', text: 'RDV **9 h 30**, salle Clément Ader', maps: true },
        { lat: 43.5962, lon: 1.4380, title: 'Déjeuner — Le Bibent', text: 'Table réservée à **12 h 30**', maps: true },
        { lat: 43.5640, lon: 1.4670, title: 'Prestataire Sigma', text: 'RDV **15 h 00**' },
      ] }],
    ],
    outro: 'Environ **45 minutes** de transport au total, en métro et à pied.',
  },
  {
    match: /migr|déploie|deploie/i,
    intro: 'C’est parti, je lance la migration et je vous tiens au courant.',
    progress: { title: 'Migration vers la nouvelle base', steps: [
      ['Sauvegarde de la base actuelle', 'Dump de 2,4 Go'],
      ['Création du nouveau schéma', 'Version 14'],
      ['Copie des données', '1 280 000 lignes sur 1 800 000'],
      ['Vérification d’intégrité', ''],
      ['Bascule du trafic', ''],
    ] },
    outro: 'La migration est terminée, sans interruption de service.',
  },
  {
    match: /code|script|corrige/i,
    intro: 'J’ai trouvé l’origine du bug : la date était lue dans le mauvais fuseau horaire.',
    tools: [
      ['code', { filename: 'src/booking.ts', language: 'diff', start: 41, code: ' export function startOfDay(date: Date) {\n-  return new Date(date.setHours(0, 0, 0, 0));\n+  const d = new Date(date);\n+  d.setUTCHours(0, 0, 0, 0);\n+  return d;\n }', highlight: ['2-5'] }],
    ],
    outro: 'Le correctif ne modifie plus la date passée en paramètre. Je lance les tests ?',
  },
  {
    match: /supprim|nettoy/i,
    intro: 'Je suis prêt à nettoyer les anciennes sauvegardes.',
    blocking: ['confirm', { title: 'Supprimer 14 sauvegardes de plus de 90 jours ?', text: 'Cela libère **38 Go** sur le serveur. Les 3 plus récentes sont conservées. Cette action est définitive.', danger: true, yes: 'Supprimer', no: 'Garder' }],
  },
  {
    match: /voyage|réserv|reserv|planifi/i,
    intro: 'Pour préparer ce déplacement, j’ai besoin de quelques précisions.',
    blocking: ['form', { title: 'Préparer le déplacement', text: 'Je réserve dès que vous validez.', submit: 'Lancer la recherche', fields: [
      { name: 'dest', label: 'Destination', placeholder: 'Ville', required: true },
      { name: 'date', label: 'Départ', kind: 'date', required: true },
      { name: 'class', label: 'Confort', kind: 'select', options: ['Économique', 'Confort', 'Affaires'], default: 'Confort' },
      { name: 'bag', label: 'Bagage en soute', kind: 'checkbox' },
    ] }],
  },
];

export const FALLBACK = { intro: 'Bien reçu ! Dites-moi *ventes*, *comparatif*, *itinéraire*, *migration*, *code*, *supprimer* ou *voyage* pour voir les widgets.' };
export const REASONING = 'Je regarde ce qu’il faut afficher.';
export const ACK = 'Compris, c’est noté. Je m’en occupe !';
