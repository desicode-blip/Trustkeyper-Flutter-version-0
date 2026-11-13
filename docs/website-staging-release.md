# Staging website publication

## Published result

The website/admin bundle and the three scoped functions are deployed to project
`trustkeyper`. Both `trustkeyper.com` and `www.trustkeyper.com` serve the new
homepage over valid HTTPS. All nine public pages and the admin entry return 200;
the former broker URL redirects to the property-agent page, and Login still
opens the existing customer app. The live admin login renders without browser
errors. Hindi/Telugu, all four enquiry role branches, the phone fallback and
local-only OTP preview were checked. Phone width was checked for horizontal
overflow and corrected without changing the staging design.

Validation passed: 271 backend tests, 19 tooling tests, four new Flutter widget
tests, targeted Flutter analysis, and the admin release build. Live negative
smoke checks reject unauthenticated inbox/update requests, invalid targets,
fixture proofs and unavailable SMS sends. They did not send mail or create a
production lead. Customer-app Hosting version `98c9c96515804f9f` and the Firebase
Auth configuration were compared before/after and are unchanged. Deployment
evidence is local and ignored under `output/website-release`.

An authenticated production-admin inbox session and actual OTP/Gmail receipt
still require a controlled user test. No password, OTP or customer record was
read or created to bypass that check. The implementation remains on local
feature branch `codex/publish-staging-website`; no branch merge or Git push was
part of this publication.

## Scope

This release takes the public website from `origin/staging` commit `a63d303`.
Its homeowner, property-agent, builder, multilingual and supporting pages are
built from `website/site/src`, not the earlier recovered static website.

The public Firebase Hosting site remains `trustkeyper-website`, with the existing
`trustkeyper.com` and `www.trustkeyper.com` mappings. Login still opens
`https://trustkeyper.web.app/#/login`. No DNS, mail DNS, billing, app-hosting
release, native app, payment service, authentication account or security rules
are changed by this website release.

Ajay separately requested an admin enquiry inbox and notification emails to
`amanmaheshwari900@gmail.com`, and approved the website/admin bundle and exactly
three enquiry functions, including their public HTTPS entry. The two admin
callables still require an authenticated, active administrator from `users`.
No role is granted by an email address alone.

## Website enquiries

The three website endpoints are handled by `websiteEnquiry` in the existing
Firebase Functions codebase, using the existing `RESEND_API_KEY` and
`EMAIL_OTP_SECRET`. The unmodified standalone Dart backend under `website/api`
is a design/reference implementation, not an additional deployed service.

Real email OTP works on every deployed website hostname; only loopback previews
accept the displayed fixture code, and those previews cannot send an enquiry.
The website OTP is isolated from app-login challenges, creates no Auth account,
uses single-use codes, and produces a scoped 30-minute enquiry proof. Rate
limits and hashed code storage are server-enforced. A proof cannot create
multiple enquiries. Resend retries use the same provider idempotency key.

MSG91/DLT credentials are not configured. The phone choice therefore offers
email verification or WhatsApp instead of pretending that an SMS was sent.
App phone login is unchanged.

New enquiries are stored in `websiteContactRequests`, along with delivery state.
Their notification goes only to `amanmaheshwari900@gmail.com` and links to
`https://trustkeyper.com/admin/#/admin/enquiries`. The visitor's verified email is
the reply-to address. If notification delivery fails, the lead remains in the
admin inbox and the website reports the failure with a retry option. Do not
claim Gmail delivery solely from provider acceptance.

OTP challenges, rate-limit records and proof-use records are in the server-only
`websiteEmailChallenges`, `websiteContactRates` and `websiteContactProofs`
collections. Existing Firestore catch-all rules deny direct client access.

## Admin portal

The same Flutter admin dashboard has a Website enquiries section, status
filters, search, pagination, contact actions and audited internal notes/status
updates. The first page refreshes every 30 seconds while open. Old enquiries
from the original contact function remain visible in the same collection.

`admin_main.dart` is an admin-only entry point sharing the app's existing
dashboard, authentication, widgets and workflows. Its build lives at `/admin/`
on the website Hosting site; the customer app at `trustkeyper.web.app` is not
rebuilt or redeployed. Use the website footer's Admin portal link or the URL
above. The older admin page inside the unchanged customer app does not acquire
new code from this isolated deployment.

## Build and checks

Use pinned Flutter 3.38.6 and Python 3.10 or newer. Python file IO is explicitly
UTF-8 so Hindi/Telugu are preserved on Windows and macOS.

```powershell
.\scripts\build-public-website.ps1 -Flutter C:\path\to\flutter\bin\flutter.bat
npm --prefix functions test
node --test scripts/test/*.test.cjs
```

On macOS, run `python3 website/site/build.py`, then build the admin entry point
with `flutter build web --target lib/admin_main.dart --base-href /admin/
--pwa-strategy=none --output ABSOLUTE_CHECKOUT/output/website-release/admin` from
`apps/flutter_app`, and run `node scripts/assemble-website.cjs` from the root.
Restore dependencies with the committed lockfile first. Use an absolute output
path to avoid the Windows shader compiler's relative-output issue.

The website builder clears `website/site/dist`. Always assemble the admin bundle
after that step and do not run the static-only build again before publication.
`node scripts/preview-website.cjs` serves the assembled files on loopback port
8096 and blocks real contact submissions.

## Approved deployment boundary

```powershell
firebase deploy --project trustkeyper --account ajay@trustkeyper.com --only functions:authentication:websiteEnquiry,functions:authentication:readWebsiteEnquiries,functions:authentication:updateWebsiteEnquiry
firebase deploy --config firebase.website.json --project trustkeyper --account ajay@trustkeyper.com --only hosting
```

The organisation disallows `allUsers` invoker grants. With Ajay's specific
approval, only the three new services have the Cloud Run Invoker IAM check
disabled. Their container/traffic/scaling configuration is compared before and
after. Do not alter organisation policies or other services to work around this.

Verify all website routes, valid HTTPS on both domains, the app Login handoff,
the isolated admin login, rejection of unauthenticated inbox calls, and unchanged
customer-app Hosting release. A real visitor code, successful enquiry and Gmail
receipt must still be checked with a controlled inbox; synthetic unit/browser
fixtures do not certify live delivery or an authenticated production session.
