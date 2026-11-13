import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineString } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { OAuth2Client } from 'google-auth-library';
import { AdminGoogleAccessError, authorizeAdminGoogleAccess } from './admin-google-access.js';

const oauthAudience = defineString('ADMIN_GOOGLE_OAUTH_CLIENT_ID', { default: '' });
const google = new OAuth2Client();

export const authorizeWebsiteAdminGoogle = onCall({ region: 'asia-south1', invoker: 'private', maxInstances: 2, timeoutSeconds: 30,
  cpu: 'gcf_gen1', concurrency: 1, memory: '256MiB' }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in with Google first.');
  const audience = oauthAudience.value().trim();
  if (!audience.endsWith('.apps.googleusercontent.com')) throw new HttpsError('failed-precondition', 'Google admin sign-in is not configured yet.');
  const database = getFirestore();
  try {
    return await authorizeAdminGoogleAccess({
      auth: request.auth,
      googleIdToken: request.data?.googleIdToken,
      verifyGoogle: async idToken => (await google.verifyIdToken({ idToken, audience })).getPayload(),
      readUser: uid => getAuth().getUser(uid),
      store: { transaction: handler => database.runTransaction(transaction => handler({
        get: async path => (await transaction.get(database.doc(path))).data(),
        merge: (path, data) => transaction.set(database.doc(path), data, { merge: true }),
        create: (path, data) => transaction.create(database.doc(path), data),
      })) },
    });
  } catch (error) {
    if (error instanceof AdminGoogleAccessError) throw new HttpsError(error.code, error.message);
    throw new HttpsError('unavailable', 'Could not confirm Google admin access. Please try again.');
  }
});
