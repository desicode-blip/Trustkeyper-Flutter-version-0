import { createHash } from 'node:crypto';

export class WebsiteContactError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export function validateWebsiteContact(input) {
  const fields = {};
  const values = {};
  for (const field of ['firstName', 'lastName', 'phone', 'email', 'role', 'serviceTiming', 'message']) {
    values[field] = typeof input?.[field] === 'string' ? input[field].trim() : '';
  }
  for (const field of ['firstName', 'lastName']) {
    if (!values[field] || values[field].length > 100 || /[\r\n\x00-\x1f]/.test(values[field])) fields[field] = 'Enter a name of up to 100 characters';
  }
  if (!/^[6-9]\d{9}$/.test(values.phone)) fields.phone = 'Enter a valid 10-digit mobile number';
  if (values.email && (values.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))) fields.email = 'Enter a valid email address';
  if (!['property_owner', 'tenant', 'broker'].includes(values.role)) fields.role = 'Select your role';
  if (!['immediately', 'within_1_month', 'within_3_months', 'within_6_months', 'exploring'].includes(values.serviceTiming)) fields.serviceTiming = 'Select when you need this service';
  if (!values.message || values.message.length > 5000 || /\x00/.test(values.message)) fields.message = 'Enter a message of up to 5000 characters';
  if (Object.keys(fields).length) throw new WebsiteContactError(400, 'Please check the highlighted fields.', fields);
  return values;
}

export function createWebsiteContactService({ store, sendMail, now = Date.now }) {
  return {
    async submit(input, clientHash) {
      if (typeof input?.website === 'string' && input.website.trim()) return { accepted: true };
      const values = validateWebsiteContact(input);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input?.requestId ?? '') || !/^[a-f0-9]{64}$/.test(clientHash ?? '')) throw new WebsiteContactError(400, 'Please refresh the page and try again.');
      const requestHash = createHash('sha256').update(input.requestId).digest('hex');
      const payloadHash = createHash('sha256').update(JSON.stringify(values)).digest('hex');
      const leadPath = `websiteContactRequests/${requestHash}`;
      const reserved = await store.transaction(async transaction => {
        const previous = await transaction.get(leadPath);
        const limitPath = `websiteContactLimits/${clientHash}`;
        const limit = await transaction.get(limitPath);
        const timestamp = now();
        if (previous) {
          if (previous.payloadHash !== payloadHash || previous.clientHash !== clientHash) throw new WebsiteContactError(409, 'Please refresh the page before sending a different message.');
          if (previous.status === 'delivered') return false;
          if (timestamp - previous.attemptedAt < 60000 || previous.attempts >= 3) throw new WebsiteContactError(429, 'Please wait before trying again.');
        }
        const count = limit && timestamp - limit.startedAt < 3600000 ? limit.count : 0;
        if (count >= 5) throw new WebsiteContactError(429, 'Too many requests. Please try again later.');
        transaction.set(limitPath, { count: count + 1, startedAt: count ? limit.startedAt : timestamp });
        transaction.set(leadPath, { ...values, clientHash, payloadHash, status: 'sending', attempts: (previous?.attempts ?? 0) + 1, createdAt: previous?.createdAt ?? timestamp, attemptedAt: timestamp });
        return true;
      });
      if (!reserved) return { accepted: true };
      try {
        const result = await sendMail({ values, idempotencyKey: `website-contact-${requestHash}` });
        if (!result?.id) throw new Error('No delivery confirmation');
        await store.update(leadPath, { status: 'delivered', deliveredAt: now(), providerId: result.id });
        return { accepted: true };
      } catch {
        await store.update(leadPath, { status: 'delivery-unconfirmed' }).catch(() => {});
        throw new WebsiteContactError(503, 'Your message could not be confirmed. Please retry or email info@trustkeyper.com.');
      }
    },
  };
}

export function createWebsiteContactSender({ apiKey, fetchRequest = fetch }) {
  return async ({ values, idempotencyKey }) => {
    if (!apiKey) throw new Error('Email delivery is not configured.');
    const response = await fetchRequest('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        from: 'TrustKeyper Website <noreply@trustkeyper.com>', to: ['info@trustkeyper.com'],
        ...(values.email ? { reply_to: values.email } : {}),
        subject: 'New TrustKeyper website enquiry',
        text: `Name: ${values.firstName} ${values.lastName}\nPhone: +91 ${values.phone}\nEmail: ${values.email || 'Not provided'}\nRole: ${values.role}\nService timing: ${values.serviceTiming}\n\n${values.message}`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Email provider rejected delivery.');
    const result = await response.json();
    if (typeof result.id !== 'string' || !result.id) throw new Error('Email provider did not confirm acceptance.');
    return { id: result.id };
  };
}
