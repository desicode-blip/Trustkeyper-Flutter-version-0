import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

const minute = 60000;
const hour = 60 * minute;
const optionsByRole = new Map([
  ['property_owner', ['Tenant finding', 'Rent collection', 'Home servicing', 'Repairs & renovation', 'Property tax', "Care while I'm away", 'Car care']],
  ['tenant', ['Find a home to rent', 'Verified owner', 'Rent agreement', 'Move-in help', 'Repairs while I stay']],
  ['broker', ['Earn from every visit', 'List my properties', 'Rent agreements', 'Partner with TrustKeyper']],
  ['builder', ['Post-sales care', 'Construction updates', 'ERP & automation', 'Security automation', 'White label']],
]);
const timings = new Set(['immediately', 'within_1_month', 'within_3_months', 'within_6_months', 'exploring']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const indianMobile = /^(?:\+91)?([6-9]\d{9})$/;
const digestPattern = /^[a-f0-9]{64}$/;
export const WEBSITE_PHONE_PROJECT_ID = 'trustkeyper-website-otp';

export class WebsiteEnquiryError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function reject(status, code, message, fields) {
  return new WebsiteEnquiryError(status, code, message, fields);
}

function contactTarget(input) {
  const target = typeof input?.target === 'string' ? input.target.trim() : '';
  if (input?.channel === 'phone') {
    const number = indianMobile.exec(target);
    if (!number) throw reject(400, 'invalid-target', 'Enter a valid 10-digit Indian mobile number.');
    return { channel: 'phone', target: `+91${number[1]}` };
  }
  if (input?.channel !== 'email' || target.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw reject(400, 'invalid-target', 'Enter a valid email address.');
  return { channel: 'email', target: target.toLowerCase() };
}

function nextRate(previous, now, duration, maximum) {
  const rate = previous && now - previous.startedAt < duration ? previous : { startedAt: now, count: 0 };
  if (rate.count >= maximum) throw reject(429, 'rate-limited', 'Too many attempts. Please try again later.');
  return { startedAt: rate.startedAt, count: rate.count + 1 };
}

function equalDigest(first, second) {
  return typeof first === 'string' && typeof second === 'string' && digestPattern.test(first) && digestPattern.test(second) && timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}

export function createWebsiteEnquiryService({ store, sendCode, verifyPhoneToken, sendEnquiry, secret, now = Date.now, generateId = randomUUID,
  generateCode = () => randomInt(0, 1000000).toString().padStart(6, '0') }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Website enquiry signing is not configured.');
  const digest = value => createHmac('sha256', secret).update(`website-enquiry-v1:${value}`).digest('hex');
  const ratePath = key => `websiteContactRates/${digest(key)}`;
  const challengePath = email => `websiteEmailChallenges/${digest(email)}`;
  function proof(channel, target, challengeId, expiresAt) {
    const body = Buffer.from(JSON.stringify({ purpose: 'website-enquiry-v1', channel, [channel]: target, challengeId, expiresAt })).toString('base64url');
    return `${body}.${digest(`proof:${body}`)}`;
  }
  function readProof(token) {
    if (typeof token !== 'string' || token.length > 1600) return null;
    const [body, signature, extra] = token.split('.');
    if (extra || !equalDigest(signature, digest(`proof:${body}`))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      const validChallenge = (data.channel === 'email' && uuid.test(data.challengeId)) || (data.channel === 'phone' && digestPattern.test(data.challengeId));
      return data.purpose === 'website-enquiry-v1' && validChallenge && typeof data[data.channel] === 'string' &&
        typeof data.expiresAt === 'number' && data.expiresAt > now() ? data : null;
    } catch { return null; }
  }

  async function request(input, ip) {
    const { channel, target } = contactTarget(input);
    if (channel === 'phone') throw reject(400, 'phone-client-required', 'Use the phone number form to request an SMS code.');
    const timestamp = now();
    const challengeId = generateId();
    const code = generateCode();
    const path = challengePath(target);
    await store.transaction(async transaction => {
      const ipPath = ratePath(`send-ip:${ip || 'unknown'}`);
      const globalPath = ratePath('send-global');
      const [previous, ipRate, globalRate] = await Promise.all([transaction.get(path), transaction.get(ipPath), transaction.get(globalPath)]);
      if (previous?.lockedUntil > timestamp) throw reject(429, 'locked', 'Too many incorrect codes. Try again after 15 minutes.');
      if (previous && timestamp - previous.requestedAt < 30000) throw reject(429, 'too-soon', 'Wait 30 seconds before requesting another code.');
      const targetRate = nextRate(previous?.rate, timestamp, hour, 5);
      const nextIp = nextRate(ipRate, timestamp, hour, 10);
      const nextGlobal = nextRate(globalRate, timestamp, 24 * hour, 200);
      transaction.set(ipPath, nextIp);
      transaction.set(globalPath, nextGlobal);
      transaction.set(path, { challengeId, hash: digest(`code:${target}:${challengeId}:${code}`), requestedAt: timestamp,
        expiresAt: timestamp + 10 * minute, attempts: 0, status: 'pending', rate: targetRate });
    });
    try {
      await sendCode({ email: target, code, challengeId });
    } catch {
      await store.transaction(async transaction => {
        const current = await transaction.get(path);
        if (current?.challengeId === challengeId) transaction.set(path, { ...current, status: 'failed' });
      });
      throw reject(502, 'delivery-failed', 'The code could not be sent. Please try again shortly or contact us on WhatsApp.');
    }
    await store.transaction(async transaction => {
      const current = await transaction.get(path);
      if (current?.challengeId !== challengeId || current.status !== 'pending') throw reject(409, 'replaced', 'Request a new code.');
      transaction.set(path, { ...current, status: 'sent', expiresAt: now() + 10 * minute });
    });
    return { sent: true, challengeId, resendAfterSeconds: 30, expiresInSeconds: 600 };
  }

  async function verify(input, ip) {
    const { channel, target } = contactTarget(input);
    if (channel === 'phone') return verifyPhone(input, target, ip);
    if (!uuid.test(input?.challengeId ?? '') || typeof input?.code !== 'string' || !/^\d{6}$/.test(input.code)) throw reject(400, 'invalid-code', 'Enter the six-digit code.');
    const path = challengePath(target);
    const result = await store.transaction(async transaction => {
      const ipPath = ratePath(`verify-ip:${ip || 'unknown'}`);
      const [current, ipRate] = await Promise.all([transaction.get(path), transaction.get(ipPath)]);
      const timestamp = now();
      const nextIp = nextRate(ipRate, timestamp, hour, 60);
      transaction.set(ipPath, nextIp);
      if (current?.lockedUntil > timestamp || current?.attempts >= 5) return 'locked';
      if (!current || current.status !== 'sent' || current.challengeId !== input.challengeId || current.expiresAt <= timestamp) return 'expired';
      if (!equalDigest(current.hash, digest(`code:${target}:${input.challengeId}:${input.code}`))) {
        const attempts = current.attempts + 1;
        transaction.set(path, { ...current, attempts, ...(attempts >= 5 ? { lockedUntil: timestamp + 15 * minute } : {}) });
        return attempts >= 5 ? 'locked' : 'incorrect';
      }
      transaction.set(path, { ...current, status: 'used', usedAt: timestamp });
      return 'verified';
    });
    if (result === 'locked') throw reject(429, 'locked', 'Too many incorrect codes. Try again after 15 minutes.');
    if (result === 'expired') throw reject(400, 'expired', 'This code expired or was already used. Request a new code.');
    if (result === 'incorrect') return { verified: false };
    return { verified: true, token: proof(channel, target, input.challengeId, now() + 30 * minute), expiresInSeconds: 1800 };
  }

  async function verifyPhone(input, phone, ip) {
    if (typeof verifyPhoneToken !== 'function') throw reject(503, 'phone-unavailable', 'SMS verification is not available yet.');
    const invalid = () => reject(400, 'invalid-phone-verification', 'Verify this phone number with a new SMS code.');
    if (typeof input.idToken !== 'string' || input.idToken.length > 5000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(input.idToken)) throw invalid();
    await store.transaction(async transaction => {
      const path = ratePath(`verify-phone-ip:${ip || 'unknown'}`);
      transaction.set(path, nextRate(await transaction.get(path), now(), hour, 60));
    });
    let claims;
    try { claims = await verifyPhoneToken(input.idToken); }
    catch { throw invalid(); }
    const verifiedAt = claims?.auth_time * 1000;
    const timestamp = now();
    if (claims?.aud !== WEBSITE_PHONE_PROJECT_ID || claims.iss !== `https://securetoken.google.com/${WEBSITE_PHONE_PROJECT_ID}` ||
      claims.firebase?.sign_in_provider !== 'phone' || claims.phone_number !== phone || typeof claims.uid !== 'string' || !claims.uid ||
      !Number.isInteger(claims.auth_time) || verifiedAt > timestamp + 30000 || timestamp - verifiedAt > 5 * minute) throw invalid();
    const challengeId = digest(`phone-verification:${JSON.stringify([claims.uid, phone, claims.auth_time])}`);
    const expiresAt = verifiedAt + 30 * minute;
    return { verified: true, token: proof('phone', phone, challengeId, expiresAt), expiresInSeconds: Math.floor((expiresAt - timestamp) / 1000) };
  }

  async function submit(input, ip) {
    if (typeof input?.website === 'string' && input.website.trim()) return { accepted: true };
    const verified = readProof(input?.otpToken);
    const values = Object.fromEntries(['firstName', 'lastName', 'email', 'phone', 'role', 'serviceTiming', 'message'].map(field =>
      [field, typeof input?.[field] === 'string' ? input[field].trim() : '']));
    if (values.lastName === '-') values.lastName = '';
    values.email = values.email.toLowerCase();
    const fields = {};
    if (!values.firstName || values.firstName.length > 100 || values.lastName.length > 100 || /[\r\n\x00-\x1f]/.test(values.firstName + values.lastName)) fields.name = 'Enter your name (up to 100 characters per part).';
    const allowedOptions = optionsByRole.get(values.role);
    if (!allowedOptions) fields.role = 'Select your role.';
    const selectedOptions = input?.selectedOptions;
    if (selectedOptions !== undefined) {
      if (!Array.isArray(selectedOptions) || !allowedOptions || selectedOptions.length > allowedOptions.length ||
        new Set(selectedOptions).size !== selectedOptions.length || selectedOptions.some(option => !allowedOptions.includes(option))) {
        fields.selectedOptions = 'Select valid options for your role.';
      } else if (selectedOptions.length) {
        values.selectedOptions = [...selectedOptions];
      }
    }
    if (!timings.has(values.serviceTiming)) fields.serviceTiming = 'Select when you need this service.';
    if (!values.message || values.message.length > 5000 || /\x00/.test(values.message)) fields.message = 'Enter a message of up to 5000 characters.';
    if (verified?.channel === 'phone') {
      const phone = indianMobile.exec(values.phone);
      if (!phone || verified.phone !== `+91${phone[1]}` || values.email) fields.contact = 'Please verify your phone number again.';
      else values.phone = verified.phone;
    } else if (!verified || verified.email !== values.email || values.phone) {
      fields.contact = 'Please verify your email address or phone number again.';
    }
    if (!uuid.test(input?.requestId ?? '')) fields.requestId = 'Refresh the page and try again.';
    if (Object.keys(fields).length) throw reject(400, 'invalid-fields', 'Please check your enquiry.', fields);
    const requestHash = digest(`request:${input.requestId}`);
    const path = `websiteContactRequests/${requestHash}`;
    const proofPath = `websiteContactProofs/${digest(input.otpToken)}`;
    const payloadHash = digest(JSON.stringify(values));
    const reserved = await store.transaction(async transaction => {
      const ipPath = ratePath(`contact-ip:${ip || 'unknown'}`);
      const [previous, usedProof, ipRate] = await Promise.all([transaction.get(path), transaction.get(proofPath), transaction.get(ipPath)]);
      const timestamp = now();
      if (previous) {
        if (previous.payloadHash !== payloadHash || previous.proofHash !== digest(input.otpToken)) throw reject(409, 'changed-request', 'Refresh before sending a different enquiry.');
        if (previous.deliveryStatus === 'delivered') return false;
        if (previous.attempts >= 3 || timestamp - previous.attemptedAt < minute) throw reject(429, 'too-soon', 'Wait a minute before trying again.');
      }
      if (usedProof && usedProof.requestHash !== requestHash) throw reject(409, 'used-proof', 'Your enquiry was already received. Verify your contact details again to send another.');
      const nextIp = nextRate(ipRate, timestamp, hour, 10);
      transaction.set(ipPath, nextIp);
      transaction.set(proofPath, { requestHash, expiresAt: verified.expiresAt });
      transaction.set(path, { ...values, verifiedChannel: verified.channel, status: 'new', deliveryStatus: 'sending',
        payloadHash, proofHash: digest(input.otpToken), createdAt: previous?.createdAt ?? timestamp, attemptedAt: timestamp,
        attempts: (previous?.attempts ?? 0) + 1 });
      return true;
    });
    if (!reserved) return { accepted: true };
    try {
      const result = await sendEnquiry({ values, idempotencyKey: `website-enquiry-${requestHash}` });
      if (!result?.id) throw new Error('Email acceptance was not confirmed.');
      await store.update(path, { deliveryStatus: 'delivered', deliveredAt: now(), providerId: result.id });
      return { accepted: true };
    } catch {
      await store.update(path, { deliveryStatus: 'unconfirmed' }).catch(() => {});
      throw reject(503, 'delivery-unconfirmed', 'We saved your enquiry but could not confirm the notification email. Please retry in a minute or contact us on WhatsApp.');
    }
  }
  return { request, verify, submit };
}

export function createWebsiteMailSender({ apiKey, fetchRequest = fetch }) {
  async function deliver(message, idempotencyKey) {
    if (!apiKey) throw new Error('Website email is not configured.');
    const response = await fetchRequest('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from: 'TrustKeyper Website <noreply@trustkeyper.com>', ...message }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Email provider rejected delivery.');
    const result = await response.json();
    if (typeof result.id !== 'string' || !result.id) throw new Error('Email provider did not confirm acceptance.');
    return { id: result.id };
  }
  return {
    sendCode: ({ email, code, challengeId }) => deliver({ to: [email], subject: 'Your TrustKeyper website verification code',
      text: `Your TrustKeyper website enquiry code is ${code}. It expires in 10 minutes. Do not share this code. If you did not request it, ignore this email.` }, `website-code-${challengeId}`),
    sendEnquiry: ({ values, idempotencyKey }) => {
      const options = values.selectedOptions?.length ? `Selected options:\n${values.selectedOptions.map(option => `- ${option}`).join('\n')}\n\n` : '';
      return deliver({ to: ['amanmaheshwari900@gmail.com'], ...(values.email ? { reply_to: values.email } : {}),
        subject: 'New TrustKeyper website enquiry', text: `Name: ${values.firstName} ${values.lastName}\n${values.email ? `Verified email: ${values.email}` : `Verified phone: ${values.phone}`}\nRole: ${values.role}\nTiming: ${values.serviceTiming}\n\n${options}${values.message}\n\nOpen the admin enquiries inbox: https://trustkeyper.com/admin/#/admin/enquiries` }, idempotencyKey);
    },
  };
}
