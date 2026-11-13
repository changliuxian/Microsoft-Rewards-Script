# Microsoft Rewards Script

[![Validate](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/validate.yml/badge.svg?branch=v5)](https://github.com/TheNetsky/Microsoft-Rewards-Script/actions/workflows/validate.yml)
![Version](https://img.shields.io/github/package-json/v/TheNetsky/Microsoft-Rewards-Script/v5)
[![Docker image (GHCR)](https://img.shields.io/badge/Docker-GHCR%20v5-2496ED?logo=docker&logoColor=white)](https://github.com/TheNetsky/Microsoft-Rewards-Script/pkgs/container/microsoft-rewards-script)
![Node.js](https://img.shields.io/badge/node-%3E%3D24-green)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
[![Donate](https://img.shields.io/badge/Donate-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/thenetsky)

Microsoft Rewards automation with API and browser modes, saved sessions,
multiple accounts, localised searches and an optional Control API.

## Features

- Daily Set, promotions, punchcards and bonus-point claims.
- Desktop/mobile searches, Explore on Bing, Daily Check-In and Read to Earn.
- Optional Visual Search and background Edge browsing.
- Streak progress, API-based streak protection and verified point reporting.
- Scheduled runs, account selection, saved sessions and Discord/Telegram/ntfy notifications.
- Control API with live events, persistent history, punchcard progress and activity balance observations.

Activities depend on the account and region. This branch contains v5; earlier
versions remain available on [v3](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v3)
and [v4](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v4).

## Documentation

- [Setup and usage](docs/usage.md) — local, Nix and Docker installation, accounts, settings, commands and troubleshooting.
- [Control API](docs/control-api.md) — authentication, endpoints, run control, scheduling and dashboard data.

## Setup

Requires Node.js 24 or newer.

```sh
npm ci
npm run install:browser
npm run build
cp env.example .env
cp config.example.json config.json
```

On Linux, install Chromium's system libraries with
`npx patchright install --with-deps chromium`.
On Windows, copy the example files with File Explorer or PowerShell's `Copy-Item`.

Set `ACCOUNT_1_EMAIL` and the relevant sign-in settings in `.env`, then run:

```sh
npm start
```

Add another numbered account block for each account. Passwords are optional for
passwordless accounts. See [env.example](env.example) for account variables and
[Setup and usage](docs/usage.md#accounts-and-sessions) for login options.

## Modes and settings

Edit [config.json](config.example.json) before starting a run.

| Setting                            | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `rewardsMode: "browser"`           | Complete web activities through rendered cards and GhostCursor |
| `rewardsMode: "api"`               | Save the sign-in session, close its browser and use HTTP       |
| `searchSettings.parallelSearching` | Overlap desktop and mobile work when enabled                   |
| `workers`                          | Enable or disable individual tasks                             |
| `taskDelay`                        | Delay between activities                                       |
| `searchSettings.searchDelay`       | Delay between searches                                         |
| `searchSettings.useAccountLocale`  | Select queries using the account country                       |
| `ensureStreakProtection`           | Enable and verify protection over HTTP in both modes           |
| `experimental`                     | Optional features; disabled by default                         |

See the full [settings reference](docs/usage.md#settings-reference) for all options.

## CN deployment notes

This fork carries the CN adaptation on top of upstream v5:

- `customCN` query source — a cascade of public CN hot-topic boards (xxapi, gmya,
  baiwumm, cnxiaobai, nntool; see `CN_HOT_APIS` in
  [src/constants/urls.ts](src/constants/urls.ts)). The order is shuffled per run
  and up to six boards are merged so the headlines can take turns as the main
  topic; the self-hosted board (`http://192.168.31.214:6688/douyin`, `CN_TRENDS`)
  is the backup and is only asked when every public board failed. A CN run
  searches those headlines only — no evergreen list, no RSS feeds — and skips Bing
  expansion, because a real headline is a better query than a stitched-together
  suggestion. The source is prepended automatically when the account country
  resolves to `CN`.
- CN-friendly defaults in [config.example.json](config.example.json) and
  [env.example](env.example): `headless: true`, `ACCOUNT_n_GEO_LOCALE=CN`,
  `ACCOUNT_n_LANG_CODE=zh-CN` and `queryEngines` including `customCN`.
- [Dockerfile](Dockerfile) and [compose.yaml](compose.yaml) use daocloud/npmmirror
  and aliyun mirrors, `TZ: Asia/Shanghai` and the headless-shell Chromium only.
- Bing is accepted on every host of the `*.bing.com` family (`isBingHost` in
  [src/constants/urls.ts](src/constants/urls.ts)). Requests from mainland China
  are answered by `cn.bing.com` and everything else by `www.bing.com`, so the
  search submission, the report calls and the flyout are all aimed at the host the
  browser actually landed on instead of asserting `www.bing.com`.

See [CN deployments](docs/usage.md#cn-deployments) for the endpoint contract and
logging tags.

### Tracking upstream

[`.github/workflows/upstream-sync.yml`](.github/workflows/upstream-sync.yml)
merges `TheNetsky/Microsoft-Rewards-Script@v5` into `v5` every day and on each
push to `v5`, so the CN patches ride on top of a current upstream. The merge is
pushed only after the CN markers are still present and the merged tree builds,
lints and formats cleanly. A conflict, a failing check or a rejected push stops
the sync without pushing and opens one `upstream-sync` issue; that issue closes
itself once a later run succeeds. Run it by hand with **Actions → Upstream sync
→ Run workflow**, where `dry_run: true` reports without pushing.

Upstream editing the same lines as the CN adaptation is handled without dropping
either side. Every conflicted path is resolved in three tiers: re-apply the fork's
own delta on the upstream version, then the upstream delta on the fork version,
and only if both fail keep the fork version outright. A hunk that a three-way merge
cannot place is retried without surrounding context, so an insertion survives an
upstream edit right beside it. Only the last tier loses information: the run still
succeeds, and the skipped upstream delta is quoted in a
`Upstream sync skipped upstream changes on v5` issue so it can be ported by hand;
that issue stays open until you close it. A separate guard re-checks the CN markers
in the merged tree, so an adaptation that upstream silently dropped also stops the
sync instead of disappearing.

### Promoting to main

[`.github/workflows/promote-to-main.yml`](.github/workflows/promote-to-main.yml)
runs after every Upstream sync run and on each push to `v5`, then merges `v5`
into `main` and pushes the result, so `main` always mirrors the synced fork. In
the steady state the merge changes nothing and is pushed without a rebuild; when
`main` carries its own commits, the merged tree is built, linted and
format-checked first. A conflict or a failing check keeps `main` untouched and
opens one `main-promotion` issue, which closes itself once a later run succeeds.
`main` is only ever merged into, never used as a source.

### Publishing images

[`.github/workflows/dockerhub-publish.yml`](.github/workflows/dockerhub-publish.yml)
builds the `v5` tree on every push to `v5` and after every successful Upstream
sync, then pushes the same build to two registries, because Docker Hub pulls are
slow from mainland China:

| Registry   | Image                                           |
| ---------- | ----------------------------------------------- |
| GHCR       | `ghcr.io/changliuxian/microsoft-rewards-script` |
| Docker Hub | `changliuxian49/microsoft-rewards-script`       |

GHCR needs nothing beyond the workflow's own `GITHUB_TOKEN`. Docker Hub needs two
repository secrets: `DOCKERHUB_USERNAME` (the account name) and `DOCKERHUB_TOKEN`
(a Docker Hub access token with read and write scope, created under **Account
settings → Security → New access token**). Without them the run publishes to GHCR
only and logs a notice instead of failing.

Tags follow the registries, not `package.json`: the next release is one past the
highest published `v5.0.N` across both of them, so a fresh repository starts at
`v5.0.0`, and `latest` is re-pointed at the newest tag with `docker buildx
imagetools create`. Each commit is also tagged `sha-<7>`, which makes a repeated
run for the same tree a no-op instead of bumping the counter twice; when only one
registry received that commit, the run completes the other one under the same
version instead of consuming a new number. Images are multi-architecture
(`linux/amd64`, `linux/arm64`); pass `dry_run: true` to build without pushing.

```sh
docker pull ghcr.io/changliuxian/microsoft-rewards-script:latest
docker pull changliuxian49/microsoft-rewards-script:latest
```

## Sessions

To sign in manually on a desktop with a visible browser:

```sh
npm run manual-login -- user@example.com --platform both
npm run open-session -- --help
```

Sessions are saved under `sessionPath`. Keep `.env`, local configuration,
session databases and diagnostics private.

## Docker

Create `.env` from `env.example`, then review the timezone and schedule in
[compose.yaml](compose.yaml).

```sh
docker compose up -d --build
docker compose logs -f
```

The published v5 image is `ghcr.io/thenetsky/microsoft-rewards-script:5`.
To use it instead of building locally, follow the [Docker image instructions](docs/usage.md#docker).

Docker persists configuration in `./config`, sessions in `./sessions` and optional
error captures in `./diagnostics`. It creates `config/config.json` from defaults
when needed. `RUN_ON_START` controls the first run; `CRON_SCHEDULE` sets the initial
schedule. Control API schedule changes persist in `config/schedule.json`.
See [Control API Docker setup](docs/control-api.md#docker) to enable the server.

## License

[GPL-3.0-or-later](LICENSE).
