import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import { createWebsiteEnquiryService, createWebsiteMailSender, WEBSITE_PHONE_PROJECT_ID, WebsiteEnquiryError } from './website-enquiries.js';
import { createWebsiteEnquiryAdminService, WebsiteEnquiryAdminError } from './website-enquiry-admin.js';

const resendKey = defineSecret('RESEND_API_KEY');
const signingSecret = defineSecret('EMAIL_OTP_SECRET');
const origins = new Set(['https://trustkeyper.com', 'https://www.trustkeyper.com', 'https://trustkeyper-website.web.app', 'https://trustkeyper-website.firebaseapp.com']);

function verifyWebsitePhoneToken(token) {
  const app = getApps().find(candidate => candidate.name === WEBSITE_PHONE_PROJECT_ID) ??
    initializeApp({ projectId: WEBSITE_PHONE_PROJECT_ID }, WEBSITE_PHONE_PROJECT_ID);
  return getAuth(app).verifyIdToken(token);
}

export const websiteEnquiry = onRequest({ region: 'asia-south1', maxInstances: 2, timeoutSeconds: 40,
  cpu: 'gcf_gen1', concurrency: 1, memory: '256MiB', secrets: [resendKey, signingSecret] }, async (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.set('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'POST') return response.status(405).set('Allow', 'POST').json({ error: 'method-not-allowed' });
  if (!origins.has(request.get('Origin'))) return response.status(403).json({ error: 'origin-not-allowed' });
  if (!request.is('application/json')) return response.status(415).json({ error: 'json-required' });
  if (Buffer.byteLength(JSON.stringify(request.body ?? {})) > 24000) return response.status(413).json({ error: 'body-too-large' });
  const action = { '/api/otp/send': 'request', '/api/otp/verify': 'verify', '/api/contact': 'submit' }[request.path];
  if (!action) return response.status(404).json({ error: 'not-found' });
  const database = getFirestore();
  const service = createWebsiteEnquiryService({
    secret: signingSecret.value(), ...createWebsiteMailSender({ apiKey: resendKey.value() }),
    verifyPhoneToken: verifyWebsitePhoneToken,
    store: {
      transaction: handler => database.runTransaction(transaction => handler({
        get: async path => (await transaction.get(database.doc(path))).data(),
        set: (path, data) => transaction.set(database.doc(path), data),
      })),
      update: (path, data) => database.doc(path).update(data),
    },
  });
  try {
    return response.status(200).json(await service[action](request.body, request.ip));
  } catch (error) {
    const known = error instanceof WebsiteEnquiryError;
    return response.status(known ? error.status : 503).json({ error: known ? error.code : 'unavailable',
      message: known ? error.message : 'We could not complete this request. Please retry or contact us on WhatsApp.',
      ...(known && error.fields ? { fields: error.fields } : {}) });
  }
});

async function adminAction(request, action) {
  const database = getFirestore();
  const service = createWebsiteEnquiryAdminService({ auth: request.auth, store: {
    profile: async uid => (await database.doc(`users/${uid}`).get()).data(),
    list: async (cursor, count) => {
      let query = database.collection('websiteContactRequests').orderBy('createdAt', 'desc').limit(count);
      if (cursor) {
        const previous = await database.doc(`websiteContactRequests/${cursor}`).get();
        if (!previous.exists) throw new WebsiteEnquiryAdminError('invalid-argument', 'This inbox page expired. Return to the first page.');
        query = query.startAfter(previous);
      }
      return (await query.get()).docs.map(document => ({ id: document.id, data: document.data() }));
    },
    transaction: handler => database.runTransaction(transaction => handler({
      get: async path => (await transaction.get(database.doc(path))).data(),
      update: (path, data) => transaction.update(database.doc(path), data),
      set: (path, data) => transaction.set(database.doc(path), data),
    })),
  } });
  try { return await service[action](request.data ?? {}); }
  catch (error) {
    if (error instanceof WebsiteEnquiryAdminError) throw new HttpsError(error.code, error.message);
    throw new HttpsError('unavailable', 'The enquiries inbox could not be loaded. Please retry.');
  }
}

const adminOptions = { region: 'asia-south1', maxInstances: 2, timeoutSeconds: 30, cpu: 'gcf_gen1', concurrency: 1, memory: '256MiB' };
export const readWebsiteEnquiries = onCall(adminOptions, request => adminAction(request, 'list'));
export const updateWebsiteEnquiry = onCall({ ...adminOptions, invoker: 'public' }, request => adminAction(request, 'update'));
