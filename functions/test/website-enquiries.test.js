import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createWebsiteEnquiryService, createWebsiteMailSender, WEBSITE_PHONE_PROJECT_ID } from '../website-enquiries.js';
import { createWebsiteEnquiryAdminService } from '../website-enquiry-admin.js';

function fixture() {
  const documents = new Map();
  const messages = [], notifications = [];
  let time = 10000000, queue = Promise.resolve(), failCode = false, failNotification = false;
  const store = {
    transaction(handler) {
      const result = queue.then(async () => {
        const draft = structuredClone(documents);
        const answer = await handler({ get: async path => draft.get(path), set: (path, data) => draft.set(path, data), update: (path, data) => draft.set(path, { ...draft.get(path), ...data }) });
        documents.clear();
        for (const [path, data] of draft) documents.set(path, data);
        return answer;
      });
      queue = result.catch(() => {});
      return result;
    },
    update: async (path, data) => documents.set(path, { ...documents.get(path), ...data }),
    profile: async uid => documents.get(`users/${uid}`),
    list: async () => [...documents].filter(([path]) => /^websiteContactRequests\/[^/]+$/.test(path)).map(([path, data]) => ({ id: path.split('/')[1], data })),
  };
  const settings = { store, secret: 'local-test-only-secret-over-thirty-two-characters', now: () => time,
    generateCode: () => '652841',
    sendCode: async message => { if (failCode) throw new Error('Local provider failure'); messages.push(message); },
    sendEnquiry: async message => { notifications.push(message); if (failNotification) throw new Error('Local provider failure'); return { id: 'local-notification' }; },
  };
  const service = createWebsiteEnquiryService(settings);
  const target = { channel: 'email', target: 'local@example.test' };
  async function verified() {
    const sent = await service.request(target, 'local-ip');
    return (await service.verify({ ...target, challengeId: sent.challengeId, code: '652841' }, 'local-ip')).token;
  }
  const submission = (token, changes = {}) => ({ firstName: 'Local', lastName: '-', phone: '', email: target.target, role: 'builder', serviceTiming: 'exploring', message: 'Company: Local test fixture\nService: ERP and automation', requestId: randomUUID(), otpToken: token, ...changes });
  return { documents, store, service, target, messages, notifications, verified, submission, settings,
    advance: duration => { time += duration; }, failCode: value => { failCode = value; }, failNotification: value => { failNotification = value; } };
}

test('real verification proof is signed, scoped, single-use and stores no raw code', async () => {
  const flow = fixture();
  const sent = await flow.service.request(flow.target, 'local-ip');
  assert.equal(sent.sent, true);
  assert.equal(sent.code, undefined);
  assert.equal(flow.messages[0].code, '652841');
  assert.ok(!JSON.stringify([...flow.documents]).includes('652841'));
  const result = await flow.service.verify({ ...flow.target, challengeId: sent.challengeId, code: '652841' }, 'local-ip');
  assert.equal(result.verified, true);
  assert.equal(JSON.parse(Buffer.from(result.token.split('.')[0], 'base64url')).purpose, 'website-enquiry-v1');
  await assert.rejects(flow.service.verify({ ...flow.target, challengeId: sent.challengeId, code: '652841' }, 'local-ip'), { status: 400 });
});

test('phone sends fail honestly and email delivery failure cannot verify', async () => {
  const flow = fixture();
  await assert.rejects(flow.service.request({ channel: 'phone', target: '9000000001' }, 'local-ip'), { code: 'phone-client-required' });
  assert.equal(flow.documents.size, 0);
  flow.failCode(true);
  await assert.rejects(flow.service.request(flow.target, 'local-ip'), { status: 502 });
  const challenge = [...flow.documents].find(([path]) => path.startsWith('websiteEmailChallenges/'))[1];
  await assert.rejects(flow.service.verify({ ...flow.target, challengeId: challenge.challengeId, code: '652841' }, 'local-ip'), { status: 400 });
});

function phoneClaims(flow, changes = {}) {
  return { aud: WEBSITE_PHONE_PROJECT_ID, iss: `https://securetoken.google.com/${WEBSITE_PHONE_PROJECT_ID}`,
    uid: 'local-phone-visitor', auth_time: flow.settings.now() / 1000, phone_number: '+919000000001',
    firebase: { sign_in_provider: 'phone' }, ...changes };
}

test('Firebase SMS verifies only the requested number and creates a callback enquiry in the admin inbox', async () => {
  const flow = fixture();
  const claims = phoneClaims(flow);
  const service = createWebsiteEnquiryService({ ...flow.settings, verifyPhoneToken: async () => claims });
  const target = { channel: 'phone', target: '9000000001' };
  const attempt = { ...target, idToken: 'synthetic.phone.token' };
  await assert.rejects(service.verify({ ...attempt, target: '12345' }, 'local-ip'), { code: 'invalid-target' });
  await assert.rejects(service.verify({ ...attempt, target: '9000000002' }, 'local-ip'), { code: 'invalid-phone-verification' });
  const { token } = await service.verify(attempt, 'local-ip');
  flow.advance(1000);
  const repeated = await service.verify({ ...attempt, idToken: 'synthetic.refreshed.token', target: '+919000000001' }, 'local-ip');
  assert.equal(repeated.token, token);
  const input = flow.submission(token, { email: '', phone: target.target, role: 'property_owner', message: 'Property type: Apartment\nLocation: Gachibowli' });
  await assert.rejects(service.submit({ ...input, phone: '9000000002' }, 'local-ip'), { code: 'invalid-fields' });
  await assert.rejects(service.submit({ ...input, email: 'local@example.test' }, 'local-ip'), { code: 'invalid-fields' });
  assert.deepEqual(await service.submit(input, 'local-ip'), { accepted: true });
  await assert.rejects(service.submit({ ...input, requestId: randomUUID() }, 'local-ip'), { code: 'used-proof' });
  assert.equal(flow.notifications.length, 1);
  flow.documents.set('users/local-admin', { roles: ['admin'] });
  const admin = createWebsiteEnquiryAdminService({ auth: { uid: 'local-admin' }, store: flow.store });
  const [lead] = (await admin.list()).enquiries;
  assert.equal(lead.phone, '+919000000001');
  assert.equal(lead.email, '');
  assert.equal(lead.verifiedChannel, 'phone');
  assert.equal(lead.message, input.message);
  assert.doesNotMatch(JSON.stringify([...flow.documents]), /synthetic\.(?:phone|refreshed)\.token/);
});

test('website phone verification rejects expired, untrusted and non-phone Firebase tokens', async () => {
  const flow = fixture();
  let claims;
  const service = createWebsiteEnquiryService({ ...flow.settings, verifyPhoneToken: async () => {
    if (!claims) throw new Error('Local invalid signature fixture');
    return claims;
  } });
  const target = { channel: 'phone', target: '9000000001', idToken: 'synthetic.phone.token' };
  await assert.rejects(service.verify(target, 'local-ip'), { code: 'invalid-phone-verification' });
  for (const changes of [{ aud: 'trustkeyper' }, { iss: 'https://securetoken.google.com/another-project' },
    { firebase: { sign_in_provider: 'password' } }, { auth_time: flow.settings.now() / 1000 - 301 },
    { auth_time: flow.settings.now() / 1000 + 31 }, { uid: '' }, { phone_number: '' }]) {
    claims = phoneClaims(flow, changes);
    await assert.rejects(service.verify(target, 'local-ip'), { code: 'invalid-phone-verification' });
  }
  await assert.rejects(service.verify({ ...target, idToken: '', code: '123456' }, 'local-ip'), { code: 'invalid-phone-verification' });
  assert.equal(flow.notifications.length, 0);
});

test('phone exchange has an independent per-IP rate limit', async () => {
  const flow = fixture();
  const service = createWebsiteEnquiryService({ ...flow.settings, verifyPhoneToken: async () => phoneClaims(flow) });
  const target = { channel: 'phone', target: '9000000001', idToken: 'synthetic.phone.token' };
  for (let index = 0; index < 60; index++) assert.equal((await service.verify(target, 'local-ip')).verified, true);
  await assert.rejects(service.verify(target, 'local-ip'), { code: 'rate-limited' });
  const sent = await service.request(flow.target, 'local-ip');
  assert.equal((await service.verify({ ...flow.target, challengeId: sent.challengeId, code: '652841' }, 'local-ip')).verified, true);
});

test('wrong code attempts persist atomically and lock both verify and resend', async () => {
  const flow = fixture();
  const sent = await flow.service.request(flow.target, 'local-ip');
  for (let index = 0; index < 4; index++) assert.deepEqual(await flow.service.verify({ ...flow.target, challengeId: sent.challengeId, code: '000000' }, 'local-ip'), { verified: false });
  await assert.rejects(flow.service.verify({ ...flow.target, challengeId: sent.challengeId, code: '000000' }, 'local-ip'), { status: 429 });
  flow.advance(30001);
  await assert.rejects(flow.service.request(flow.target, 'local-ip'), { status: 429 });
  flow.advance(15 * 60000);
  assert.equal((await flow.service.request(flow.target, 'local-ip')).sent, true);
});

test('expired or replaced challenges cannot verify and resend respects cooldown', async () => {
  const flow = fixture();
  const first = await flow.service.request(flow.target, 'local-ip');
  await assert.rejects(flow.service.request(flow.target, 'local-ip'), { status: 429 });
  flow.advance(30001);
  const next = await flow.service.request(flow.target, 'local-ip');
  await assert.rejects(flow.service.verify({ ...flow.target, challengeId: first.challengeId, code: '652841' }, 'local-ip'), { status: 400 });
  flow.advance(600000);
  await assert.rejects(flow.service.verify({ ...flow.target, challengeId: next.challengeId, code: '652841' }, 'local-ip'), { status: 400 });
});

test('concurrent send and verify races produce one message and one proof', async () => {
  const flow = fixture();
  const sends = await Promise.allSettled([flow.service.request(flow.target, 'local-ip'), flow.service.request(flow.target, 'local-ip')]);
  assert.equal(flow.messages.length, 1);
  const challengeId = sends.find(result => result.status === 'fulfilled').value.challengeId;
  const verifies = await Promise.allSettled([flow.service.verify({ ...flow.target, challengeId, code: '652841' }, 'local-ip'), flow.service.verify({ ...flow.target, challengeId, code: '652841' }, 'local-ip')]);
  assert.equal(verifies.filter(result => result.status === 'fulfilled').length, 1);
});

test('per-email, per-IP and global delivery budgets are enforced', async () => {
  const flow = fixture();
  for (let index = 0; index < 5; index++) { await flow.service.request(flow.target, 'local-ip'); flow.advance(30001); }
  await assert.rejects(flow.service.request(flow.target, 'local-ip'), { status: 429 });
  const ipFlow = fixture();
  for (let index = 0; index < 10; index++) await ipFlow.service.request({ channel: 'email', target: `local${index}@example.test` }, 'one-ip');
  await assert.rejects(ipFlow.service.request({ channel: 'email', target: 'extra@example.test' }, 'one-ip'), { status: 429 });
  const globalFlow = fixture();
  for (let index = 0; index < 200; index++) await globalFlow.service.request({ channel: 'email', target: `local${index}@example.test` }, `ip-${index}`);
  await assert.rejects(globalFlow.service.request(flow.target, 'another-ip'), { status: 429 });
});

test('all four roles create private enquiries and retries do not duplicate email', async () => {
  for (const role of ['property_owner', 'tenant', 'broker', 'builder']) {
    const flow = fixture();
    const token = await flow.verified();
    const input = flow.submission(token, { role });
    assert.deepEqual(await flow.service.submit(input, 'local-ip'), { accepted: true });
    assert.deepEqual(await flow.service.submit(input, 'other-ip'), { accepted: true });
    assert.equal(flow.notifications.length, 1);
    const lead = [...flow.documents].find(([path]) => /^websiteContactRequests\/[^/]+$/.test(path))[1];
    assert.equal(lead.status, 'new');
    assert.equal(lead.verifiedChannel, 'email');
    assert.equal(lead.lastName, '');
    assert.equal(lead.otpToken, undefined);
    assert.equal(lead.ip, undefined);
  }
});

test('selected options are validated for each role and retained in the inbox and notification', async () => {
  const selections = {
    property_owner: ['Tenant finding', 'Rent collection', 'Home servicing', 'Repairs & renovation', 'Property tax', "Care while I'm away", 'Car care'],
    tenant: ['Verified owner', 'Move-in help'],
    broker: ['List my properties', 'Rent agreements'],
    builder: ['Construction updates', 'ERP & automation'],
  };
  for (const [role, selectedOptions] of Object.entries(selections)) {
    const flow = fixture();
    const input = flow.submission(await flow.verified(), { role, selectedOptions });
    for (const invalid of [['All of the above'], ['Unlisted option'], [selectedOptions[0], selectedOptions[0]], { selectedOptions }]) {
      await assert.rejects(flow.service.submit({ ...input, selectedOptions: invalid }, 'local-ip'), error => {
        assert.equal(error.code, 'invalid-fields');
        assert.ok(error.fields.selectedOptions);
        return true;
      });
    }
    assert.equal(flow.notifications.length, 0);
    assert.deepEqual(await flow.service.submit(input, 'local-ip'), { accepted: true });
    assert.deepEqual(flow.notifications[0].values.selectedOptions, selectedOptions);
    flow.documents.set('users/local-admin', { roles: ['admin'] });
    const admin = createWebsiteEnquiryAdminService({ auth: { uid: 'local-admin' }, store: flow.store });
    assert.deepEqual((await admin.list()).enquiries[0].selectedOptions, selectedOptions);
    await assert.rejects(flow.service.submit({ ...input, selectedOptions: selectedOptions.slice(1) }, 'local-ip'), { code: 'changed-request' });
  }
});

test('forged, expired, wrong-recipient and app-login tokens are rejected', async () => {
  const flow = fixture();
  const proof = await flow.verified();
  for (const token of ['preview', 'local-app-login-token', proof + 'x', proof.split('.')[0] + '.' + 'é'.repeat(64)]) await assert.rejects(flow.service.submit(flow.submission(token), 'local-ip'), { status: 400 });
  await assert.rejects(flow.service.submit(flow.submission(proof, { email: 'another@example.test' }), 'local-ip'), { status: 400 });
  await assert.rejects(flow.service.submit(flow.submission(proof, { phone: '9000000001' }), 'local-ip'), { status: 400 });
  flow.advance(1800000);
  await assert.rejects(flow.service.submit(flow.submission(proof), 'local-ip'), { status: 400 });
  assert.equal(flow.notifications.length, 0);
});

test('one verification cannot create several leads and operation IDs cannot change payload', async () => {
  const flow = fixture();
  const proof = await flow.verified();
  const input = flow.submission(proof);
  await flow.service.submit(input, 'local-ip');
  await assert.rejects(flow.service.submit(flow.submission(proof), 'local-ip'), { status: 409 });
  await assert.rejects(flow.service.submit({ ...input, message: 'Changed' }, 'local-ip'), { status: 409 });
  assert.equal(flow.notifications.length, 1);
});

test('notification failure preserves admin lead and retry uses the same provider key', async () => {
  const flow = fixture();
  const input = flow.submission(await flow.verified());
  flow.failNotification(true);
  await assert.rejects(flow.service.submit(input, 'local-ip'), { status: 503 });
  const lead = [...flow.documents].find(([path]) => /^websiteContactRequests\/[^/]+$/.test(path))[1];
  assert.equal(lead.status, 'new');
  assert.equal(lead.deliveryStatus, 'unconfirmed');
  flow.advance(60001); flow.failNotification(false);
  await flow.service.submit(input, 'local-ip');
  assert.equal(flow.notifications[0].idempotencyKey, flow.notifications[1].idempotencyKey);
});

test('honeypot, invalid fields and invalid IDs cannot send an enquiry', async () => {
  const flow = fixture();
  await flow.service.submit({ website: 'bot' }, 'local-ip');
  const proof = await flow.verified();
  await assert.rejects(flow.service.submit(flow.submission(proof, { role: 'admin', firstName: '', requestId: '../bad' }), 'local-ip'), error => {
    assert.equal(error.status, 400);
    assert.deepEqual(Object.keys(error.fields).sort(), ['name', 'requestId', 'role']);
    return true;
  });
  assert.equal(flow.notifications.length, 0);
});

test('mail notification goes only to Aman and contains the protected admin link', async () => {
  const calls = [];
  const mail = createWebsiteMailSender({ apiKey: 'local-test-only-placeholder', fetchRequest: async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ id: 'local-provider-id' }) };
  } });
  await mail.sendCode({ email: 'local@example.test', code: '652841', challengeId: 'local-challenge' });
  await mail.sendEnquiry({ values: fixture().submission('not-sent'), idempotencyKey: 'local-key' });
  await mail.sendEnquiry({ values: fixture().submission('not-sent', { email: '', phone: '+919000000001', selectedOptions: ['Construction updates', 'ERP & automation'] }), idempotencyKey: 'local-sms-key' });
  assert.deepEqual(calls[0].body.to, ['local@example.test']);
  assert.deepEqual(calls[1].body.to, ['amanmaheshwari900@gmail.com']);
  assert.equal(calls[1].body.reply_to, 'local@example.test');
  assert.ok(calls[1].body.text.includes('https://trustkeyper.com/admin/#/admin/enquiries'));
  assert.equal(calls[1].headers['Idempotency-Key'], 'local-key');
  assert.deepEqual(calls[2].body.to, ['amanmaheshwari900@gmail.com']);
  assert.equal(calls[2].body.reply_to, undefined);
  assert.match(calls[2].body.text, /Verified phone: \+919000000001/);
  assert.ok(calls[2].body.text.includes('Selected options:\n- Construction updates\n- ERP & automation\n\n'));
});

test('admin inbox rejects unauthenticated, non-admin, malformed roles and paused accounts', async () => {
  const flow = fixture();
  for (const profile of [undefined, { roles: ['broker'] }, { roles: 'admin' }, { roles: ['admin'], paused: true }]) {
    flow.documents.set('users/local-admin', profile);
    const admin = createWebsiteEnquiryAdminService({ auth: { uid: 'local-admin' }, store: flow.store });
    await assert.rejects(admin.list(), { code: 'permission-denied' });
    await assert.rejects(admin.update({ id: 'a'.repeat(64), status: 'new', note: '' }), { code: 'permission-denied' });
  }
  const anonymous = createWebsiteEnquiryAdminService({ auth: null, store: flow.store });
  await assert.rejects(anonymous.list(), { code: 'unauthenticated' });
});

test('admin can read sanitized leads and persist audited status changes', async () => {
  const flow = fixture();
  await flow.service.submit(flow.submission(await flow.verified()), 'local-ip');
  flow.documents.set('users/local-admin', { roles: ['admin'] });
  const admin = createWebsiteEnquiryAdminService({ auth: { uid: 'local-admin' }, store: flow.store, now: () => 20000000 });
  const page = await admin.list();
  assert.equal(page.enquiries.length, 1);
  assert.deepEqual(page.enquiries[0].selectedOptions, []);
  assert.equal(page.enquiries[0].proofHash, undefined);
  assert.equal(page.enquiries[0].payloadHash, undefined);
  assert.equal(page.enquiries[0].email, 'local@example.test');
  await admin.update({ id: page.enquiries[0].id, status: 'contacted', note: ' Called visitor ' });
  const updated = (await admin.list()).enquiries[0];
  assert.equal(updated.status, 'contacted');
  assert.equal(updated.note, 'Called visitor');
  assert.ok([...flow.documents.keys()].some(path => path.includes('/events/')));
  await assert.rejects(admin.list({ cursor: '../invalid' }), { code: 'invalid-argument' });
  await assert.rejects(admin.update({ id: page.enquiries[0].id, status: 'granted-admin', note: '' }), { code: 'invalid-argument' });
});
