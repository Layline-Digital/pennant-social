
##### Q: Do I have to leave my computer on for scheduled posts to publish?
It depends on which scheduling mode you select in the composer:
- **Standard (Local Workstation Outbox):** Your post is saved in your local database. It dispatches while Pennant is active. If your laptop is asleep at the scheduled time, it dispatches the moment your machine wakes up and connects to Wi-Fi.
- **Unattended Edge Sync:** Checking the *"Unattended Edge Sync"* toggle in the composer offloads the timer to the 24/7 Cloudflare Edge Relay. Your post will fire at the exact minute required even if your workstation is completely turned off.

##### Q: If I use Unattended Edge Sync, are my private keys and passwords safe?
Yes, by architectural design:
- **Nostr (Zero Key Custody):** Your computer signs the post locally with your private key before sending it to the cloud. The cloud worker only holds the pre-signed text and never possesses your private key (`nsec`).
- **Bluesky:** Your App Password is encrypted locally using AES-256-GCM before transmission. It can be revoked at any time from your Bluesky account settings.
- **Mastodon:** Handled directly by your instance's native server-side scheduling.

##### Q: What is the difference between connecting Nostr with an Extension vs. a Key?
- **Browser Extension (Zero Custody):** Uses an extension like Alby or nos2x. Pennant never handles or sees your private key.
- **Direct Key (`nsec`):** Encrypted in your local workstation memory vault for seamless multi-account broadcasting without browser confirmation popups.
