# Public website and Flutter app

## Restoration status — 25 October 2026

Ajay approved publication of the restored website-first flow, its single contact
function, and the two website domain transfers. The public site is deployed at
`https://trustkeyper-website.web.app`. All eight public routes respond correctly,
and Login opens `https://trustkeyper.web.app/#/login`.

Both custom domains have replacement associations on the public site. The first
attempt to release the old associations produced a transient 404 while Firebase
still cached the old ownership records. Those recoverable associations were
restored as a fallback; the app site itself was never deleted. Do not release
them again until the replacement is active and serving the public website.
GoDaddy now has
`hosting-site=trustkeyper-website` at `@` and a `www` CNAME pointing to
`trustkeyper-website.web.app`; the apex Firebase A record is unchanged. Google
and Cloudflare DNS checks return these new values. At the last verification,
Firebase's ownership checker still cached the previous values, so custom-domain
handover/certificate propagation remains pending. Do not mark that step accepted
until both actual domains serve the marketing page over valid HTTPS.

The contact function is deployed. With Ajay's separate approval, only its Cloud
Run Invoker IAM check was disabled to allow public enquiries; its container,
traffic, scaling and network settings were compared and remain unchanged.
Production smoke checks confirm method rejection, origin rejection and specific
field-validation errors without writing a lead or sending an email. Actual inbox
delivery has not been exercised by this release. Local checks passed 265 backend
and 19 tooling tests. The existing app Hosting release remains the 13 October
release, version `98c9c96515804f9f`. All 11 non-website DNS records match the
pre-transfer export exactly.

The public TrustKeyper website is a separate static Firebase Hosting site. Its
original public pages, styling, fonts and images were recovered from the retained
website backup. No retired application packages, authentication runtime, server,
Vercel configuration or old repository history is restored.

## Destinations

- `trustkeyper.com` and `www.trustkeyper.com`: public website, site
  `trustkeyper-website` after the approved domain transfer.
- `https://trustkeyper.web.app/#/login`: existing Flutter application.
- Sign Up/Login and broker registration buttons open that Flutter login.
- Existing `#/...` app links on a custom domain are forwarded to the same path
  on `trustkeyper.web.app`, preserving document-request links.

Public source lives in `apps/flutter_app/website`. `firebase.website.json` is
deliberately separate from `firebase.json`. The app's existing Hosting settings,
deployment scripts and release remain untouched. There is no production SPA
catch-all on the public website; its eight public routes are real static pages.

## Local checks

```sh
node --test scripts/test/public-website.test.cjs
node --test functions/test/website-contact.test.js
node scripts/preview-public-website.cjs
```

The preview binds only to localhost on port 8095. Contact submissions always fail
locally rather than sending real enquiries or claiming delivery. The local-only
`/__responsive-preview` route displays phone and tablet layouts; it is not a
deployed file.

## Contact form

The same-origin `/api/contact` rewrite invokes `submitWebsiteContact` in
`asia-south1`. This one function uses the existing `RESEND_API_KEY` secret, sends
only to `info@trustkeyper.com`, and never sends to a visitor-controlled recipient.
It checks input server-side, limits attempts per pseudonymous client hash,
rejects honeypot submissions, and makes delivery retries idempotent. Success is
shown only after the provider accepts the enquiry. Network/provider failures
leave the form available for retry with an email fallback.

Enquiries and attempt limits are stored in the server-only
`websiteContactRequests` and `websiteContactLimits` collections, denied by the
existing catch-all Firestore rules. No public read permission or Auth changes
are needed. The visitor email is optional and used only as the enquiry reply-to.
Do not put production contact data in fixtures, repository files or logs.

## Release boundary

Production publication needs approval of the concrete scope: create the public
Hosting site, deploy its static files and the single contact function, move only
the two website custom-domain associations, and update their ownership TXT/www
CNAME. The apex Firebase A record remains `199.36.158.100`.

Do not deploy the app Hosting target, all functions, rules, indexes, payment
services or another project's resources as part of this release. Preserve mail
records, nameservers, billing, existing Auth settings, and the app site's live
release. Verify both custom-domain certificates, public navigation and the Login
handoff, then compare the email DNS records to the saved zone export.

After approval, the website-only Hosting command is:

```sh
firebase deploy --config firebase.website.json --project trustkeyper --only hosting --account ajay@trustkeyper.com
```

The contact function is a separate scoped deployment using the root configuration:

```sh
firebase deploy --project trustkeyper --only functions:authentication:submitWebsiteContact --account ajay@trustkeyper.com
```

These commands are documentation, not permission to release. Do not change IAM,
billing, credentials, or unrelated services to bypass a deployment error.
