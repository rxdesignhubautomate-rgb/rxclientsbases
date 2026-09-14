import { assertLocalMigrationEnvironment } from '../src/migrations/client-classification-backfill.js';
import { backfillMarketingHistoryPage } from '../src/migrations/marketing-history-backfill.js';
assertLocalMigrationEnvironment(process.env);
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.length ? value.join('=') : true]; }));
if (Object.keys(args).some(key => !['org-id', 'cursor', 'limit', 'commit', 'dry-run', 'restart'].includes(key)) || args.commit && args['dry-run']) throw new Error('Invalid migration options');
const { initializeApp, deleteApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { FirestoreStore } = await import('../src/repositories/firestore-store.js');
const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT }, 'local-marketing-history');
try { console.log(JSON.stringify(await backfillMarketingHistoryPage(new FirestoreStore(getFirestore(app)), { orgId: args['org-id'], cursor: args.cursor, limit: Number(args.limit || 100), commit: args.commit === true, restart: args.restart === true }), null, 2)); }
finally { await deleteApp(app); }
