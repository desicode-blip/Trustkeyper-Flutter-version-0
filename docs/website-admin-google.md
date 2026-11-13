# Website admin Google sign-in

The website admin entry point offers **Continue with Google**. The existing
email/password fallback and linked-phone challenge remain available. The
customer app does not show the new Google button.

The `authorizeWebsiteAdminGoogle` callable requires a fresh Firebase Google
session and a Google ID token issued to the configured OAuth client. The
verified email and Google subject must match the Firebase session and its live
provider record. The server accepts only the four approved email addresses;
TrustKeyper work addresses must be Google Workspace accounts for the domain.

On first approved sign-in, the callable adds the `admin` role without removing
existing roles and binds the email to that Firebase UID and Google subject in
`websiteAdminGoogleBindings`. It never grants admin to paused or disabled
accounts. To revoke a grant, remove the `admin` role and retain the binding so a
repeat sign-in cannot recreate the grant.

## Production activation

After explicit release approval, enable the Google provider in the existing
`trustkeyper` Firebase Authentication project and verify the website's authorized
domains. Do not change existing providers or the separate website OTP project.
Set `ADMIN_GOOGLE_OAUTH_CLIENT_ID` to the Google provider's web client ID in the
ignored `functions/.env.trustkeyper` file. Do not add its OAuth client secret to
this file or to the repository.

Deploy only the new `authorizeWebsiteAdminGoogle` callable and the website
Hosting bundle containing the isolated admin build. If the organization policy
requires separate Cloud Run ingress configuration, scope it only to this new
callable and confirm its application-level authentication still rejects
anonymous requests. Verify one approved sign-in and one rejected sign-in before
considering activation complete.

## Activation record

Google sign-in is enabled in project `trustkeyper` with public name TrustKeyper
and support email `info@trustkeyper.com`. Website Hosting release
`95e6141bf1fb906a` contains the admin login button; the customer app and enquiry
functions were not changed. Only `authorizeWebsiteAdminGoogle` received public
HTTPS entry through the approved Cloud Run invoker-check setting; anonymous
requests still return `UNAUTHENTICATED`. The Google account chooser opens from
the live portal. On 10 November 2026, `ajay@trustkeyper.com` completed Google
sign-in and opened the full admin dashboard at `https://trustkeyper.com/admin#/admin`.
The user confirmed the dashboard opened, and the authenticated dashboard was
visually verified. The other three approved accounts have not been individually
tested end to end; allowlist rejection is covered by automated tests.
