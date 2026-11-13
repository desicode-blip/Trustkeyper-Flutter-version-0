import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeAdminGoogleAccess } from '../admin-google-access.js';

const emails = ['ajaybhatnagar1712@gmail.com', 'ajay@trustkeyper.com', 'info@trustkeyper.com', 'amanmaheshwari900@gmail.com'];

function fixture(email = emails[0]) {
  const uid = 'local-admin';
  const subject = 'local-google-subject';
  const now = () => 1793600000000;
  const token = { email, email_verified: true, auth_time: now() / 1000,
    firebase: { sign_in_provider: 'google.com', identities: { 'google.com': [subject] } } };
  const claims = { email, sub: subject, email_verified: true, ...(email.endsWith('@trustkeyper.com') ? { hd: 'trustkeyper.com' } : {}) };
  const user = { uid, email, emailVerified: true, providerData: [{ providerId: 'google.com', uid: subject, email }] };
  const profilePath = `users/${uid}`;
  const bindingPath = `websiteAdminGoogleBindings/${email}`;
  const documents = new Map([[profilePath, { email, roles: ['broker'], name: 'Existing profile' }]]);
  let writes = 0;
  const store = { transaction: async handler => handler({
    get: async key => documents.get(key),
    merge: (key, data) => { writes++; documents.set(key, { ...documents.get(key), ...data }); },
    create: (key, data) => { assert.ok(!documents.has(key)); writes++; documents.set(key, data); },
  }) };
  const authorize = (overrides = {}) => authorizeAdminGoogleAccess({ auth: { uid, token }, googleIdToken: 'local.test.token',
    now, store, verifyGoogle: async () => claims, readUser: async () => user, ...overrides });
  return { uid, subject, token, user, claims, profilePath, bindingPath, documents, authorize, writes: () => writes };
}

test('only the four approved identities receive full admin and retain existing profile data', async () => {
  for (const email of emails) {
    const flow = fixture(email);
    assert.deepEqual(await flow.authorize(), { authorized: true });
    assert.deepEqual(flow.documents.get(flow.profilePath), { email, roles: ['broker', 'admin'], name: 'Existing profile' });
    assert.equal(flow.documents.get(flow.bindingPath).googleSubject, flow.subject);
    assert.deepEqual(await flow.authorize(), { authorized: true });
    assert.equal(flow.writes(), 2);
  }
});

test('a first-time approved Google user can get an admin profile', async () => {
  const flow = fixture();
  flow.documents.delete(flow.profilePath);
  await flow.authorize();
  assert.deepEqual(flow.documents.get(flow.profilePath), { email: emails[0], roles: ['admin'] });
});

test('missing, unlisted, stale, mismatched or non-Google identities cannot grant access', async () => {
  const outsider = fixture('someone@example.test');
  await assert.rejects(outsider.authorize(), { code: 'permission-denied' });
  assert.equal(outsider.writes(), 0);
  const flow = fixture();
  await assert.rejects(flow.authorize({ auth: null }), { code: 'unauthenticated' });
  for (const token of [{ ...flow.token, email_verified: false }, { ...flow.token, auth_time: flow.token.auth_time - 301 },
    { ...flow.token, firebase: { sign_in_provider: 'password', identities: flow.token.firebase.identities } }]) {
    await assert.rejects(flow.authorize({ auth: { uid: flow.uid, token } }), { code: 'permission-denied' });
  }
  await assert.rejects(flow.authorize({ verifyGoogle: async () => ({ ...flow.claims, sub: 'different-subject' }) }), { code: 'permission-denied' });
  await assert.rejects(flow.authorize({ verifyGoogle: async () => { throw new Error('Local invalid signature fixture'); } }), { code: 'permission-denied' });
  await assert.rejects(flow.authorize({ readUser: async () => ({ ...flow.user, disabled: true }) }), { code: 'permission-denied' });
  assert.equal(flow.writes(), 0);
});

test('work email must be managed by the expected Google Workspace domain', async () => {
  const flow = fixture(emails[1]);
  for (const hd of [undefined, 'another.example']) {
    await assert.rejects(flow.authorize({ verifyGoogle: async () => ({ ...flow.claims, hd }) }), { code: 'permission-denied' });
  }
  assert.equal(flow.writes(), 0);
});

test('paused, revoked and replaced account bindings cannot re-grant admin', async () => {
  const paused = fixture();
  paused.documents.set(paused.profilePath, { roles: ['admin'], paused: true });
  await assert.rejects(paused.authorize(), { code: 'permission-denied' });
  assert.equal(paused.writes(), 0);
  const flow = fixture();
  await flow.authorize();
  flow.documents.set(flow.profilePath, { roles: ['broker'] });
  await assert.rejects(flow.authorize(), { code: 'permission-denied' });
  flow.documents.set(flow.profilePath, { roles: ['admin'] });
  flow.documents.set(flow.bindingPath, { uid: 'old-uid', googleSubject: flow.subject });
  await assert.rejects(flow.authorize(), { code: 'permission-denied' });
  assert.equal(flow.writes(), 2);
});
