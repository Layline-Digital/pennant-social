# Quickstart Guide: Pennant Hoist v0.2.8

Pennant Hoist is a local-first, sovereign multi-protocol command deck engineered for ATProto (Bluesky), ActivityPub (Mastodon), and Nostr.

---

## 1. Desktop Installation (Pre-built Binaries)

Official v0.2.8 release binaries are available directly from the [GitHub Releases](https://github.com/Layline-Digital/pennant-social/releases/tag/v0.2.8):

- **Windows (x64)**:
  - `Pennant.Social_0.2.8_x64-setup.exe` (NSIS Installer)
  - `Pennant.Social_0.2.8_x64_en-US.msi` (Enterprise MSI Package)
- **macOS (Apple Silicon & Intel)**:
  - `Pennant.Social_0.2.8_universal.dmg` (Universal Disk Image)
- **Linux (x86_64)**:
  - `Pennant.Social_0.2.8_amd64.AppImage` (Standalone executable)
  - `Pennant.Social_0.2.8_amd64.deb` (Debian / Ubuntu package)
  - `Pennant.Social-0.2.8-1.x86_64.rpm` (Fedora / RHEL package)

---

## 2. Running from Source (Developer Node 20+ / 24+)

```bash
git clone https://github.com/Layline-Digital/pennant-social.git
cd pennant-social
npm ci
npm test
npm run dev
```

The command console will boot and bind loopback to **http://127.0.0.1:7420**.

---

## 3. Operations & First Broadcast

1. **Mount Columns**: Click `+ ADD COLUMN` to mount your feeds (e.g., Bluesky Home, Nostr Firehose, Mentions, or Outbox Delivery Queue).
2. **Reorder Streams**: Use `◀` and `▶` on any column header to rearrange your deck layout.
3. **Open Composer**: Press `N` on your keyboard or click `+ NEW BROADCAST`.
4. **Arm Protocol Switches**: Toggle your egress targets (ATProto, Mastodon, Nostr).
5. **Stage Attachments**: Click `ATTACH MEDIA` or drop an image into the airlock dropzone.
6. **Transmit**: Click `TRANSMIT RECORD` to write to the SQLite WAL queue and fan-out across protocols.
