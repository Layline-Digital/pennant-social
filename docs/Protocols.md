# Connecting Protocols

## 1. Bluesky (ATProto)
1. In Bluesky, go to Settings -> Privacy and Security -> App Passwords.
2. Create an App Password labeled Pennant.
3. In Pennant Hoist, click Config -> Connect Account -> ATProto and paste your password.

## 2. Mastodon (ActivityPub)
1. On your instance, go to Preferences -> Development -> New Application.
2. Grant read/write scopes, submit, and copy your Access Token.
3. In Pennant Hoist, select ActivityPub and paste your token.

## 3. Nostr
1. In the composer, toggle NOSTR to arm it.
2. Paste your nsec1 private key or 32-byte hex key.
3. Notes sign locally in the memory enclave and publish to relays.