import { createHmac } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { createWebsiteContactSender, createWebsiteContactService, WebsiteContactError } from './website-contact.js';

const resendApiKey = defineSecret('RESEND_API_KEY');
const origins = new Set(['https://trustkeyper.com', 'https://www.trustkeyper.com', 'https://trustkeyper-website.web.app', 'https://trustkeyper-website.firebaseapp.com']);

export const submitWebsiteContact = onRequest({
  region: 'asia-south1', invoker: 'public', maxInstances: 2, timeoutSeconds: 30,
  cpu: 'gcf_gen1', concurrency: 1, memory: '256MiB', secrets: [resendApiKey],
}, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.set('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'POST') return response.status(405).set('Allow', 'POST').json({ accepted: false });
  if (!origins.has(request.get('Origin'))) return response.status(403).json({ accepted: false });
  if (!request.is('application/json')) return response.status(415).json({ accepted: false });
  if (Buffer.byteLength(JSON.stringify(request.body ?? {})) > 24000) return response.status(413).json({ accepted: false });
  const database = getFirestore();
  const key = resendApiKey.value();
  const service = createWebsiteContactService({
    sendMail: createWebsiteContactSender({ apiKey: key }),
    store: {
      transaction: handler => database.runTransaction(transaction => handler({
        get: async path => (await transaction.get(database.doc(path))).data(),
        set: (path, data) => transaction.set(database.doc(path), data),
      })),
      update: (path, data) => database.doc(path).update(data),
    },
  });
  try {
    const clientHash = createHmac('sha256', key).update(request.ip || 'unknown').digest('hex');
    return response.status(200).json(await service.submit(request.body, clientHash));
  } catch (error) {
    const known = error instanceof WebsiteContactError;
    return response.status(known ? error.status : 503).json({ accepted: false, ...(known && error.fields ? { fields: error.fields } : {}) });
  }
});
