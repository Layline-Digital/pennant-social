<p align="center">
  <a href="https://pennant.laylinedigital.com" target="_blank" rel="noopener noreferrer">
    <img src=".github/assets/pennant-banner.png" alt="Layline Digital / Pennant" width="100%" style="max-width: 800px; border-radius: 6px;" />
  </a>
</p>

<p align="center">
  <strong>Pennant Hoist: Sovereign Local-First Command Deck for ATProto, ActivityPub & Nostr</strong>
</p>

<p align="center">
  <a href="https://github.com/Layline-Digital/pennant-social/releases/tag/v0.2.9"><img src="https://img.shields.io/badge/release-v0.2.9-blue.svg" alt="Release v0.2.9" /></a>
  <a href="https://github.com/Layline-Digital/pennant-social/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT" /></a>
  <a href="https://app.pennant.laylinedigital.com"><img src="https://img.shields.io/badge/web_deck-live-success" alt="Web Deck" /></a>
  <a href="https://bsky.app/profile/laylinedigital.com"><img src="https://img.shields.io/badge/bluesky-@laylinedigital.com-0285FF" alt="Bluesky" /></a>
  <a href="https://social.pennant.laylinedigital.com/@pennant"><img src="https://img.shields.io/badge/fediverse-@pennant-563acc" alt="Mastodon" /></a>
</p>

---

# Pennant Hoist

A local-first desktop command deck for broadcasting across Bluesky, Mastodon, and Nostr simultaneously.

## Features
- Sovereign key storage on local loopback (127.0.0.1:7420)
- Media airlock with background pre-staging and zero cloud hosting costs
- Embedded SQLite WAL outbox queue with automated retry backoff
- 2D virtualized multi-column operations deck

## Documentation
- 🚀 **[Quickstart Guide](docs/Quickstart.md)** — Installation (Windows NSIS/MSI) and source boot in under 2 minutes.
- 🔐 **[Protocol Setup & Key Configuration](docs/Protocols.md)** — Step-by-step credentials for Bluesky, Mastodon, and Nostr (NIP-05/NIP-07).
- 📦 **[Media Airlock & Storage Engine](docs/Airlock-and-Storage.md)** — Client-side SHA-256 pre-staging, direct PDS/Blossom dispatch, and SQLite WAL queues.
- 🛠️ **[Troubleshooting & FAQ](docs/Troubleshooting.md)** — Storage locations, relay retries, WebView2 setup, and zero-telemetry auditing.

## Architecture & Sovereignty
- **Local-First Runtime:** Dispatch daemon runs on 127.0.0.1:7420.
- **Hardware Custody:** Private signing keys (
sec) and app passwords remain in a local, memory-scrubbed vault.
- **SQLite WAL Durability:** Scheduled dispatches survive workstation restarts without remote cloud dependencies.
- **Adaptive Constraints:** Real-time grapheme and label tracking across ATProto (300 graphemes), Mastodon (500 chars), and Nostr.

## License
Open Core licensed under the MIT License.




