import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createWebsiteContactSender, createWebsiteContactService, validateWebsiteContact, WebsiteContactError } from '../website-contact.js';

const clientHash = 'a'.repeat(64);
function input(overrides = {}) {
  return { requestId: randomUUID(), firstName: 'Website', lastName: 'Tester', phone: '9000000001', email: '', role: 'property_owner', serviceTiming: 'exploring', message: 'Local automated test only.', website: '', ...overrides };
}
function setup() {
  const documents = new Map();
  const emails = [];
  let timestamp = 10000000;
  let fail = false;
  let queue = Promise.resolve();
  const store = {
    transaction(handler) {
      const operation = queue.then(async () => {
        const draft = structuredClone(documents);
        const result = await handler({ get: async path => draft.get(path), set: (path, value) => draft.set(path, value) });
        documents.clear();
        for (const [path, value] of draft) documents.set(path, value);
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
    update: async (path, data) => documents.set(path, { ...documents.get(path), ...data }),
  };
  const service = createWebsiteContactService({ store, now: () => timestamp, sendMail: async payload => {
    emails.push(payload);
    if (fail) throw new Error('Provider unavailable');
    return { id: 'local-provider-id' };
  } });
  return { service, documents, emails, advance: duration => { timestamp += duration; }, failMail: value => { fail = value; } };
}

test('contact validates all fields and does not preserve arbitrary properties', () => {
  const values = validateWebsiteContact(input({ firstName: ' Website ', privileged: true }));
  assert.equal(values.firstName, 'Website');
  assert.equal(values.privileged, undefined);
  assert.throws(() => validateWebsiteContact(input({ phone: '1111111111', role: 'admin', message: '' })), error => {
    assert.equal(error.status, 400);
    assert.deepEqual(Object.keys(error.fields).sort(), ['message', 'phone', 'role']);
    return true;
  });
  for (const overrides of [{ email: 'bad@' }, { firstName: 'bad\nname' }, { lastName: '' }, { message: 'x'.repeat(5001) }, { serviceTiming: 'unknown' }]) assert.throws(() => validateWebsiteContact(input(overrides)), WebsiteContactError);
});

test('successful enquiry is private and retries do not send duplicate email', async () => {
  const fixture = setup();
  const submission = input();
  assert.deepEqual(await fixture.service.submit(submission, clientHash), { accepted: true });
  assert.deepEqual(await fixture.service.submit(submission, clientHash), { accepted: true });
  assert.equal(fixture.emails.length, 1);
  const lead = [...fixture.documents].find(([path]) => path.startsWith('websiteContactRequests/'))[1];
  assert.equal(lead.status, 'delivered');
  assert.equal(lead.providerId, 'local-provider-id');
  assert.equal(lead.ip, undefined);
});

test('concurrent retries send only once and changed payload or client is rejected', async () => {
  const fixture = setup();
  const submission = input();
  const results = await Promise.allSettled([fixture.service.submit(submission, clientHash), fixture.service.submit(submission, clientHash)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(fixture.emails.length, 1);
  await assert.rejects(fixture.service.submit({ ...submission, message: 'Changed' }, clientHash), { status: 409 });
  await assert.rejects(fixture.service.submit(submission, 'b'.repeat(64)), { status: 409 });
});

test('rate limiting is atomic and expires after an hour', async () => {
  const fixture = setup();
  for (let index = 0; index < 5; index++) await fixture.service.submit(input(), clientHash);
  await assert.rejects(fixture.service.submit(input(), clientHash), { status: 429 });
  fixture.advance(3600000);
  await fixture.service.submit(input(), clientHash);
  assert.equal(fixture.emails.length, 6);
});

test('failed delivery is never reported as successful and retry keeps provider idempotency key', async () => {
  const fixture = setup();
  const submission = input();
  fixture.failMail(true);
  await assert.rejects(fixture.service.submit(submission, clientHash), { status: 503 });
  await assert.rejects(fixture.service.submit(submission, clientHash), { status: 429 });
  fixture.advance(60001);
  fixture.failMail(false);
  assert.deepEqual(await fixture.service.submit(submission, clientHash), { accepted: true });
  assert.equal(fixture.emails[0].idempotencyKey, fixture.emails[1].idempotencyKey);
});

test('honeypot and malformed operation IDs cannot create a lead', async () => {
  const fixture = setup();
  await fixture.service.submit(input({ website: 'bot' }), clientHash);
  assert.equal(fixture.documents.size, 0);
  await assert.rejects(fixture.service.submit(input({ requestId: '-'.repeat(36) }), clientHash), { status: 400 });
  assert.equal(fixture.emails.length, 0);
});

test('email is sent only to company inbox, using fixed headers and optional reply-to', async () => {
  let captured;
  const sender = createWebsiteContactSender({ apiKey: 'local-test-placeholder', fetchRequest: async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ id: 'test-id' }) };
  } });
  await sender({ values: validateWebsiteContact(input({ email: 'local@example.test', message: '<script>not HTML</script>' })), idempotencyKey: 'local-key' });
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.deepEqual(captured.body.to, ['info@trustkeyper.com']);
  assert.equal(captured.body.reply_to, 'local@example.test');
  assert.equal(captured.body.html, undefined);
  assert.equal(captured.options.headers['Idempotency-Key'], 'local-key');
  assert.equal(captured.body.subject, 'New TrustKeyper website enquiry');
});

test('email sender requires confirmed provider acceptance', async () => {
  for (const response of [{ ok: false }, { ok: true, json: async () => ({}) }]) {
    const sender = createWebsiteContactSender({ apiKey: 'local-test-placeholder', fetchRequest: async () => response });
    await assert.rejects(sender({ values: validateWebsiteContact(input()), idempotencyKey: 'local-key' }));
  }
});
