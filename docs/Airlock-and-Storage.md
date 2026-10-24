# Media Airlock & Storage

## 1. Media Airlock
- Dropping media onto the composer immediately computes SHA-256 and BlurHash.
- Media pre-uploads directly to native hosts (Bluesky PDS, Mastodon, Blossom) while you type.
- Zero cloud middleman servers or third-party storage costs.

## 2. SQLite WAL Queue
- Posts and scheduled broadcasts commit to an embedded SQLite database in WAL mode.
- Survives machine reboots and retries failed requests with exponential backoff.