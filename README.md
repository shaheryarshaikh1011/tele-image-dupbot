# tele-image-dupbot: Telegram Anti-Duplicate Bot

A public Telegram moderation bot that anyone can add to a group. It spots **re-posted videos**, whether they are the identical Telegram file or a re-encoded, resized or recompressed copy. It then asks the group's admins whether to delete the copy. **Nothing is ever deleted automatically.**

- **Video-only MVP.** Other media types come later.
- **Admin approval before deletion.** The first admin to decide wins. If nobody decides within 5 hours, the video is kept.
- **Groups are isolated.** Each group has its own toggle, settings, fingerprints, approvals and audit trail.
- **Uses few resources.** It checks for an exact match first. It downloads and analyses a video only when an earlier video in the same group could plausibly match it.
- **Stack:** Node.js 20, Telegraf (long polling), MongoDB Atlas and FFmpeg, deployed as one Railway service.

---

## How it works

```
New video in group ──► group enabled? ──no──► ignored (not queued for later)
                          │yes
                          ▼
         Stage 1: same file_unique_id earlier in this group? ──yes──► approval request
                          │no
                          ▼
         Any earlier video with a compatible duration? ──no──► just remember it (no download)
                          │yes
                          ▼
         Queue job (MongoDB) ─► worker downloads to a temp file ─► FFmpeg samples N frames
                          ─► 64-bit DCT perceptual hash per frame ─► ordered comparison
                          ─► score ≥ group threshold? ──yes──► approval request
                                                         
Approval request ─► notice in group (reply to the copy) + DM to each admin who started the bot
                 ─► first valid admin click: 🗑 Delete copy / ✅ Keep
                 ─► all buttons removed, audit record written
                 ─► 5 h with no decision ─► expired, video kept
```

### Detection details

| Step | What happens |
|---|---|
| Exact match | Telegram's `file_unique_id` is compared with earlier videos in the same group. There is no download. |
| Lazy fingerprinting | A video is downloaded only when a duration-compatible candidate exists (±max(2 s, 5 %)). Fingerprints are cached, so each video is downloaded at most once. |
| Frame sampling | FFmpeg seeks to N evenly spaced points (default 12) and decodes one frame at each, scaled to 32×32 greyscale. The whole video is never decoded or loaded into memory. |
| Hash | A DCT pHash (64 bits) per frame. Flat frames (black screens, fades) are marked as uninformative and skipped. |
| Comparison | Frame *i* is compared only with frame *i* (±1 shift) of the other video, so unrelated videos that share a few similar scenes don't match. Score = matching frames ÷ comparable frames. At least half the frames must be comparable for a result to count. |
| Threshold | Per group: **strict** ≥ 90 %, **balanced** ≥ 75 % (default), **lenient** ≥ 60 %. The score is only an indicator: an admin always decides. |

Results on the synthetic benchmark set (`npm run benchmark -- --synthetic`):

```
DUP   score=1.00  meanDist=2.0   original vs resized+recompressed
DUP   score=1.00  meanDist=0.5   original vs brightness/contrast change
DUP   score=0.83  meanDist=4.2   original vs lossy MPEG-4 transcode
DIFF  score=0.00  meanDist=29.2  original vs unrelated video
DIFF  score=0.00  meanDist=31.6  original vs similar-looking test pattern
balanced (≥0.75): precision 100%  recall 100%  false positives 0
Fingerprint time: ~0.7 s per 6 s video on the dev container
```

These numbers come from synthetic clips. **Calibrate on real videos from your groups before you rely on a preset** (see [Calibration](#calibrating-thresholds)).

---

## Setting up the bot (for group owners)

1. Add the bot to your group.
2. Promote it to **admin** with the **Delete messages** permission.
3. Tap **Finish setup privately** in the welcome message, or open the bot and press **Start**. Every admin who wants private review requests must press Start once, because Telegram doesn't let bots message users first.
4. Send `/enable` in the group.

### Commands

| Command | Purpose | Who |
|---|---|---|
| `/start` | Open the private chat and turn on private notifications | anyone |
| `/help` | Setup instructions and commands | anyone |
| `/enable` | Start checking newly posted videos | group admin/owner |
| `/disable` | Pause checking. Commands and pending reviews keep working. | group admin/owner |
| `/status` | Processing state, permissions, settings, pending reviews | group admin/owner |
| `/settings` | Sensitivity preset, group notices on/off, private requests on/off | group admin/owner |
| `/stats` | Detection and moderation statistics | group admin/owner |
| `/audit` | Recent moderation events | group admin/owner |

Admin rights are checked live with Telegram on **every** privileged command and **every** button click. Anonymous admins (posting as the group) are supported for commands.

---

## Deploying

### 1. Create the bot
In [@BotFather](https://t.me/BotFather), run `/newbot` and copy the token. Privacy mode doesn't need to be changed, because bots that are group admins receive all messages.

### 2. Create the database
Create a free **MongoDB Atlas** cluster and a database user, and allow access from Railway. Atlas → Network Access → `0.0.0.0/0` is the simplest option, because Railway egress IPs aren't static. Copy the `mongodb+srv://…` connection string. The bot creates its indexes on startup.

### 3. Deploy on Railway
1. In Railway, create **New Project → Deploy from GitHub repo** and pick this repository. Railway detects `railway.json` and builds the `Dockerfile`, which installs FFmpeg.
2. Under **Variables**, set `BOT_TOKEN` and `MONGODB_URI`. Keep secrets in Railway variables and never commit them.
3. Deploy. The logs should show `mongo connected` and then `bot started`.

Keep **one replica**: Telegram long polling allows only one consumer per bot token. Restarts are safe because job state lives in MongoDB, and jobs a previous instance left half-done are queued again on startup. If you set `PORT`, the bot also serves `GET /healthz`.

### Running locally
```bash
cp .env.example .env          # fill in BOT_TOKEN and MONGODB_URI
npm install
node --env-file=.env src/index.js
```
FFmpeg and ffprobe must be on your `PATH`, or you can set `FFMPEG_PATH` and `FFPROBE_PATH`.

### Configuration

All variables are optional except `BOT_TOKEN` and `MONGODB_URI`. See [`.env.example`](.env.example) for the full list. The most important ones:

| Variable | Default | Notes |
|---|---|---|
| `MAX_VIDEO_SIZE_MB` | 20 | Telegram's Bot API download limit is 20 MB. Larger videos get exact matching only. |
| `MAX_VIDEO_DURATION_SEC` | 600 | Longer videos are not fingerprinted. |
| `FRAME_SAMPLES` | 12 | Frames per video. More frames mean more accuracy and more CPU. |
| `WORKER_CONCURRENCY` | 1 | Number of parallel analysis jobs. Raise it after measuring CPU and memory on Railway. |
| `MAX_QUEUE_SIZE` | 200 | Outstanding jobs allowed before new smart comparisons are skipped. |
| `APPROVAL_TTL_HOURS` | 5 | Hours before an unanswered request expires. The video is kept. |
| `RECORD_RETENTION_DAYS` | 30 | Days that finished approval requests and jobs are kept before the MongoDB TTL removes them. |

---

## Data model (MongoDB)

| Collection | Contents | Retention |
|---|---|---|
| `groups` | Chat id, title, enabled flag, setup status, bot permissions, settings | permanent |
| `users` | Users who pressed Start (who can receive private requests) | permanent |
| `media_fingerprints` | Group-scoped `file_id`/`file_unique_id`, metadata, frame hashes, deleted flag | **no TTL** (policy still open) |
| `approval_requests` | Original and copy message ids, score, method, recipients, status, decision, deletion result, expiry | TTL via `purgeAt` after resolution |
| `processing_jobs` | Queue state: pending/processing/completed/failed/skipped, attempts, errors | TTL via `purgeAt` after completion |
| `audit_logs` | Append-only events: detection, decisions, deletion results, expiry, enable/disable, settings | **no TTL** (policy still open) |

Only metadata and fingerprints are stored. Copies of users' videos are never kept. Downloaded media is written to a temp directory and removed in a `finally` block after each job, and on startup.

Each audit record has: group id, original message id, suspected-copy message id, uploader id, deciding admin id, detection method, similarity score, action, timestamp and Telegram's deletion result.

---

## Reliability and safety

- **Atomic state transitions.** Jobs are claimed and approvals are resolved with `findOneAndUpdate` conditioned on the current state, so concurrent clicks can't both act. Unique indexes stop a redelivered Telegram update from creating a second job or request.
- **Only the copy is ever targeted.** The delete action references only the suspected duplicate's message id.
- **Retries and backoff.** A failed analysis is retried with exponential backoff, up to 3 attempts by default, and then recorded in the audit log. Media that can't be decoded or downloaded is marked unavailable instead of being retried forever.
- **Telegram limits.** API calls retry on `429 retry_after` and on transient network or 5xx errors, and notification sends are throttled. Users who block the bot are marked unreachable.
- **Restart recovery.** On startup, jobs left in `processing` are queued again, or failed if they are out of attempts. A periodic sweep catches stuck jobs, and another sweep expires overdue approvals.
- **Group upgrades.** When a basic group becomes a supergroup, its settings and history move to the new chat id.

---

## Development

```bash
npm test                          # 77 tests: unit + end-to-end (needs ffmpeg for the video tests)
npm run benchmark -- --synthetic  # detection quality + timing on generated videos
```

The end-to-end tests run the real Telegraf client against a **fake Bot API HTTP server** (`test/helpers/fakeTelegram.js`) and an **in-memory MongoDB stand-in** (`test/helpers/fakeMongo.js`). They cover:

- onboarding
- every command
- first-decision-wins, including concurrent clicks
- admin re-checks
- expiry
- deletion failures
- group isolation
- disabled groups
- the full FFmpeg pipeline with real generated videos
- queue retries and restart recovery

### Calibrating thresholds
Make a `pairs.json` of real labelled pairs and run it on Railway hardware, for example with `railway run`:
```json
[{ "a": "clips/a.mp4", "b": "clips/a-reupload.mp4", "duplicate": true },
 { "a": "clips/a.mp4", "b": "clips/b.mp4", "duplicate": false }]
```
```bash
npm run benchmark -- pairs.json
```
The output shows per-pair scores, fingerprint timings and precision/recall for each preset.

### Project layout
```
src/
  index.js              process entrypoint: config, Mongo, polling, health, graceful shutdown
  app.js                composes services + bot (no process concerns; used by tests)
  config.js             env parsing/validation
  db.js                 collections + indexes
  bot/                  Telegraf handlers (onboarding, commands, callbacks) and message texts
  detection/            ffmpeg sampling, pHash, ordered comparison, download, detector pipeline
  services/             groups, users, fingerprints, approvals, jobs (queue), audit, stats, admins
  telegram/             retry/throttle helpers, HTML formatting, message links
test/                   node:test suites + fakes
scripts/benchmark.js    threshold calibration / timing
```

---

## Plan status

Implemented from the project plan:

- [x] **Phase 1 Foundation:** Node project, config validation, Telegraf, MongoDB, Railway (Dockerfile + `railway.json`)
- [x] **Phase 2 Onboarding:** join and promotion handling, welcome with a deep link, private `/start` setup, admin verification, per-group settings
- [x] **Phase 3 Detection:** exact `file_unique_id` check, FFmpeg frame extraction, perceptual fingerprints, candidate filtering, benchmark script
- [x] **Phase 4 Approval:** group and private notices, Delete/Keep buttons, 5-hour expiry, first decision wins, strict admin checks
- [x] **Phase 5 Audit and stats:** audit events, `/audit`, `/stats`, deletion-result tracking, metadata-only records
- [x] **Phase 6 Reliability:** bounded persistent queue, retries, restart recovery, concurrency limit, rate limiting, temp cleanup
- [ ] **Phase 7 Production testing:** needs a live bot, real groups and real videos (false-positive measurement, Railway restarts, load)
- [ ] **Phase 8 Expansion:** photos, GIFs and other media, after the video MVP is measured

Decisions the plan leaves open have conservative, configurable defaults:

| Decision | Current default |
|---|---|
| Similarity threshold | `balanced` = 75 % of frames; per-group presets |
| Max size/duration | 20 MB (Telegram limit) / 600 s |
| Frame sampling | 12 evenly spaced frames, ±1 frame shift |
| Concurrency | 1 worker |
| Fingerprint and audit retention | kept indefinitely (no TTL) until a policy is chosen |
| Approval reminders | none |
