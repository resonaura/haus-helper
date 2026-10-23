# Haus

Private home server and camera companion services for [Haus](https://github.com/resonaura/haus). This repository is `haus-helper`; the Home Assistant app is named **Haus**.

Haus discovers cameras and their motion, person, pet, vehicle and doorbell detectors. A short local ring buffer preserves the beginning of an event; relevant video is finalized into a seekable MP4, indexed in SQLite, and shown in a timeline in Haus or the app's Home Assistant interface. Recordings remain on your home server. There is no cloud video service.

## Install

Add `https://github.com/resonaura/haus-helper` to **Settings → Apps → App store → Repositories**, install **Haus**, and start it. On earlier Home Assistant versions these pages are named **Add-ons**. Open its web interface, or open a camera in the Haus desktop app.

Container images are built by GitHub Actions for `amd64` and `aarch64`. The app uses Home Assistant's authenticated Ingress; it does not publish a network port, use the host network, or require a new password. `homeassistant_api` lets it discover entities and obtain camera streams with the Supervisor-provided credential. The credential never enters the browser or recordings database.

## Recording

- Related entities on the same registered device are linked automatically. A unique matching camera name can link an external detector. A shared room alone is insufficient; ambiguous matches remain suggestions.
- Choose **Detectors & recording** to disable a camera or explicitly choose its detectors. An empty manual selection disables automatic event capture for that camera; **Record now** remains available.
- Motion and object activity share an event. New detections extend the tail up to the configured event limit. Events show their original detector types and timestamps.
- Defaults: 8 seconds of pre-roll, 20 seconds after activity, 5 minutes maximum per event, 7 days of retention, no saved-video size cap and 1 GB for temporary buffers. These limits are configurable through the Home Assistant app options.
- Buffers use stream copy. Healthy indexed H264/AAC clips with continuous packet timing, bounded keyframes and validated capture provenance play directly without a new encode. The first proven camera profile is Eufy Security T8410C at 1080p High 4.2 with no B-frames; camera/room names never confer trust. Unknown originals and Aqara bitstreams require a compatibility copy, because clean packet timing alone does not establish VideoToolbox compatibility. Unsupported or irregular media keeps a separate compatibility copy; originals remain untouched. New clips request idle NVR preparation immediately, including a just-in-time upload when periodic replication has not happened yet. Temporary uploaded originals are pinned during decoder work, tracked for cleanup and can be adopted as regular recovery replicas. A bounded pending page continues preparation beyond the latest two recordings. Encoders remain bounded and weak or busy workers are excluded. Audio is controlled by the app's `record_audio` option.
- A camera must expose a working HLS stream through Home Assistant. Snapshot-only cameras cannot produce recordings. Actual pre-roll depends on the available buffered stream; camera or server outages can produce partial recordings, which are identified in the event metadata. Timestamps describe ingestion into the local buffer, not a camera's hardware clock.

Completed MP4s and thumbnails live in `/media/haus`. The database and temporary buffers live in the app's `/data`. Retention only cleans Haus-owned files. Existing media outside these directories is untouched. Shutdown or failed finalization leaves an explicit event status rather than an empty playable recording.

## Home servers

Haus has an authenticated `GET /api/servers` inventory for the Home Assistant primary and all registered NVR servers. A server reports its CPU, memory, swap, disk/volume layout and available Docker/PM2 inventory. Missing capabilities remain explicitly unavailable. Linux host CPU/memory use kernel-wide `/proc` counters; Home Assistant OS and physical disks come from Supervisor. Core and app container usage is listed separately and is never presented as host usage. The Supervisor Docker view covers managed Home Assistant containers; it does not pretend to inventory unrelated host containers. PM2 needs a host collector on a remote node.

The app uses the Supervisor `manager` role to read host disks, installed app inventory and per-container statistics. Haus exposes only fixed read endpoints for that telemetry, never a generic Supervisor proxy or Docker socket. Samples are cached for five seconds, coalesced across clients, and have a 2.5-second collection deadline; slow or unsupported sources leave nullable metrics.

Saved-video quotas default to unlimited. `max_storage_gb: 0` means no user size cap; a free-space reserve still protects the disk. Existing finite configuration is preserved. Administrators can set a precise persisted byte budget with `PATCH /api/servers/home-assistant` and `{ "storageLimitBytes": number | null }`. Remote policies use `PATCH /api/cluster/nodes/:id` with the same field; `enabled` is an independent optional field. Remote policy writes are authenticated and acknowledged before helper metadata changes. Configuration, preferences and recovery backups keep their separate policies.

Reducing a budget never deletes existing recordings or backup copies to make them fit. A full primary budget pauses new events while an in-flight recording finishes; raising/removing the cap resumes admission. The separately configured age retention still removes expired Haus recordings. Remote nodes similarly refuse new storage reservations when their policy or safety reserve is reached.

Compatibility preparation supports short async polling (`X-Haus-Async-Prepare: 1`). A decoder retry can request a separate repair copy with authenticated `POST /api/events/:id/repair` and an empty JSON object. Repeat that POST to poll the coalesced job: `202` means preparation is running (`retryAfterMs: 1000`), and `200` returns the updated event. The API advertises `features.recordingRepair` and `features.verifiedOriginalPlayback`. This bypasses the original fast path without overwriting its source. First access to an old incompatible recording may still need processing; this is exposed rather than serving unchecked media as if it were repaired.

## Development

Requires Node 24+ and FFmpeg.

```sh
cd haus-helper
npm ci
npm test
```

Tests include automatic detector association, event merging, storage limits and retention, authenticated media byte-range seeking, and actual FFmpeg finalization of synthetic video.

For standalone API development, set `HAUS_STANDALONE=1`, `HAUS_API_TOKEN`, `HAUS_HA_URL`, `HAUS_HA_TOKEN`, `HAUS_DATA`, and `HAUS_MEDIA`. Standalone API requests require a bearer token; the ordinary web UI is intended for authenticated Home Assistant Ingress. Never commit these environment values.

The API is versioned by the application release and keeps service modules separate from the camera recorder so future local Haus services can be added without changing the recording model.
