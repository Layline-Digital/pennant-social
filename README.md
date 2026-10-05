# Pennant Social Broadcaster

Pennant is a local-first social publishing dashboard and scheduler for ActivityPub/Mastodon, AT Protocol/Bluesky, and Nostr workflows. It combines a small Node.js HTTP service, an SQLite-backed broadcast queue, isolated desktop-browser profiles, and a PowerShell publishing adapter.

## Requirements

- Node.js 20 or later and npm
- PowerShell 7 (`pwsh`) to run the publishing adapter
- Zen Browser or Firefox for launching isolated browser profiles (optional)

## Install and start

```sh
npm install
cp profiles.example.json profiles.json
cp .env.broadcaster.example .env.broadcaster
npm start
```

On Windows PowerShell, copy the example files with:

```powershell
Copy-Item profiles.example.json profiles.json
Copy-Item .env.broadcaster.example .env.broadcaster
npm start
```

Open <http://localhost:7420>. The service binds to loopback by default and stores its SQLite database and browser profiles under `~/.pennant` (or the equivalent home directory on the host). The SQLite database uses write-ahead logging and a 5-second busy timeout.

## Configuration

Set configuration in the untracked `.env.broadcaster` file. For each account, provide a `MASTO_TOKEN_<ACCOUNT>` and, if needed, `MASTO_INSTANCE_<ACCOUNT>`; otherwise `MASTODON_INSTANCE` is used. Bluesky accounts use `BSKY_HANDLE_<ACCOUNT>` and `BSKY_PASS_<ACCOUNT>`. Replace the examples with real values locally; never commit credentials. You can place the file elsewhere and set `BROADCASTER_ENV_FILE` to its path.

The daemon also supports:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `7420`) |
| `HOST` | Bind address (default `localhost`) |
| `DATA_DIR` | Directory for the SQLite database |
| `PROFILE_ROOT` | Directory for isolated browser profiles |
| `PROFILES_FILE` | Path to the local profile configuration |
| `ZEN_PATH`, `FIREFOX_PATH` | Explicit browser executable paths |

`profiles.json` is private local configuration and is excluded from version control. Start from `profiles.example.json`; use profile IDs made only of letters, digits, underscores, and hyphens. The API rejects cross-origin state changes and requires JSON schedule requests. Keep the daemon on loopback unless you have independently configured network access controls: the HTTP API does not provide authentication.

## Architecture

- `pennant-launcher.js` serves the dashboard and JSON API, launches Zen/Firefox with per-profile directories, and dispatches due queue entries.
- `dashboard.html` provides profile selection, broadcast scheduling, queue management, and bulk JSON ingest.
- `Publish-FleetBroadcast.ps1` reads local credentials and handles ActivityPub/Mastodon and Bluesky API publishing; Nostr dispatch integration is a placeholder.
- `workers/nip05-relay` is an optional Cloudflare Worker template. Configure its `NIP05_DIRECTORY` JSON domain/key map and optional `NOSTR_RELAYS` deployment variables before use.
- `platforms.schema.json` describes supported platform categories and verification methods.

## License

MIT. See [LICENSE](LICENSE).


## Author & Maintainer

Created and maintained by **Alan Woodyard** ([@woodyardae](https://github.com/woodyardae)). Developed under the [Layline Digital](https://github.com/Layline-Digital) software umbrella.
