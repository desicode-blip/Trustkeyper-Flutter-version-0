export class WebsiteEnquiryAdminError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function admin(profile, auth) {
  if (!auth?.uid) throw new WebsiteEnquiryAdminError('unauthenticated', 'Log in with your admin account.');
  if (!Array.isArray(profile?.roles) || !profile.roles.includes('admin') || profile.paused === true) throw new WebsiteEnquiryAdminError('permission-denied', 'An active admin account is required.');
}

function publicRecord(record) {
  const data = record.data;
  return { id: record.id, firstName: data.firstName ?? '', lastName: data.lastName ?? '', email: data.email ?? '',
    phone: data.phone ?? '', role: data.role ?? '', serviceTiming: data.serviceTiming ?? '', message: data.message ?? '',
    selectedOptions: Array.isArray(data.selectedOptions) ? data.selectedOptions.filter(option => typeof option === 'string') : [],
    status: ['new', 'contacted', 'closed'].includes(data.status) ? data.status : 'new',
    deliveryStatus: data.deliveryStatus ?? data.status ?? 'unknown', createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null, note: data.adminNote ?? '', verifiedChannel: data.verifiedChannel ?? '' };
}

export function createWebsiteEnquiryAdminService({ auth, store, now = Date.now }) {
  return {
    async list(input = {}) {
      if (!auth?.uid) admin(null, auth);
      admin(await store.profile(auth.uid), auth);
      const cursor = input.cursor ?? '';
      if (typeof cursor !== 'string' || (cursor && !/^[a-f0-9]{64}$/.test(cursor))) throw new WebsiteEnquiryAdminError('invalid-argument', 'Invalid inbox page.');
      const records = await store.list(cursor, 51);
      const page = records.slice(0, 50);
      return { enquiries: page.map(publicRecord), nextCursor: records.length > 50 ? page[page.length - 1].id : null };
    },
    async update(input) {
      if (!auth?.uid) admin(null, auth);
      if (!/^[a-f0-9]{64}$/.test(input?.id ?? '') || !['new', 'contacted', 'closed'].includes(input?.status) ||
        typeof input?.note !== 'string' || input.note.length > 2000) throw new WebsiteEnquiryAdminError('invalid-argument', 'Choose a valid status and a note of up to 2000 characters.');
      return store.transaction(async transaction => {
        const path = `websiteContactRequests/${input.id}`;
        const [profile, lead] = await Promise.all([transaction.get(`users/${auth.uid}`), transaction.get(path)]);
        admin(profile, auth);
        if (!lead) throw new WebsiteEnquiryAdminError('not-found', 'This enquiry was not found. Refresh the inbox.');
        const timestamp = now();
        transaction.update(path, { status: input.status, adminNote: input.note.trim(), updatedAt: timestamp, updatedBy: auth.uid });
        transaction.set(`${path}/events/${timestamp}-${auth.uid}`, { action: 'enquiry-updated', status: input.status, actorUid: auth.uid, createdAt: timestamp });
        return { saved: true };
      });
    },
  };
}
