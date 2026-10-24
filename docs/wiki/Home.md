# Pennant Hoist // Operations Deck Documentation

Welcome to the official technical manual and operations guide for **Pennant Hoist**, the sovereign, local-first multi-protocol broadcasting command deck engineered by **Layline Digital**.

┌────────────────────────────────────────────────────────────────────────┐
│                      PENNANT PROTOCOL REACH MAP                        │
├─────────────────┬──────────────────────────────────────────────────────┤
│ AT Protocol     │ • Bluesky                                            │
│                 │ • Custom Personal Data Servers (PDS)                 │
├─────────────────┼──────────────────────────────────────────────────────┤
│ ActivityPub     │ • Mastodon instances                                 │
│ ("Fediverse")   │ • Threads (Meta), Pixelfed, Lemmy                    │
├─────────────────┼──────────────────────────────────────────────────────┤
│ Nostr           │ • Primal, Damus, Amethyst, Snort                     │
│                 │ • Any decentralized relay pool                       │
└─────────────────┴──────────────────────────────────────────────────────┘


## Why Pennant Hoist?

Traditional social management suites operate as centralized cloud aggregators: they charge monthly SaaS fees to store your private credentials, app passwords, and cryptographic keys on their servers.

Pennant operates on a **sovereign, local-first model**:
- **Loopback Isolation:** The background dispatch daemon binds strictly to `127.0.0.1:7420`.
- **Cryptographic Memory Enclave:** Nostr private keys (`nsec`) and Mastodon tokens are handled in a memory-scrubbed vault and are never transmitted to external telemetry servers.
- **SQLite WAL Durability:** Queued posts and scheduled broadcasts persist across machine reboots with zero loss.
- **Zero Cloud Bandwidth Overhead:** Image and video attachments are pre-staged directly to destination protocol storage (Bluesky PDS, Mastodon media endpoints, or Blossom relays).

## Documentation Index

- [Quickstart Guide](Quickstart-Guide) — Download, install, and run in under 2 minutes.
- [Protocol Configuration](Protocol-Configuration) — Step-by-step connection for Bluesky, Mastodon, and Nostr.
- [Media Airlock & Architecture](Media-Airlock-Engine) — Deep dive into client-side SHA-256 staging and WAL queues.
- [FAQ & Troubleshooting](FAQ-and-Troubleshooting) — Common operational questions and solutions.
