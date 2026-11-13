# Trust Keyper version 0 source archive

This repository preserves three independent local source snapshots. It is not
the release repository and none of its branches should be deployed directly.

| Branch | Snapshot |
| --- | --- |
| `main` | Website and admin worktree, including the latest local website enquiry and Google admin sign-in work |
| `version-0-primary` | Previous primary Flutter and Firebase checkout, including local source changes |
| `version-0-website-restore` | Earlier Flutter checkout and its restored public website |

Each branch contains a source snapshot, not the old repository history. Local
Firebase client configuration, credentials, signing material, generated builds,
customer data, and operational files with configured test logins are excluded.
Use environment-specific Firebase client configuration if restoring a snapshot.

Aman's newer TK2 application is maintained separately on the `staging` branch
of `desicode-blip/Trustkeyper-Flutter`. This archive does not replace it.
