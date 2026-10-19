# Haus

Local companion services for [Haus](https://github.com/resonaura/haus). This repository is `haus-helper`; the Home Assistant app is named **Haus**.

Haus discovers cameras and their motion, person, pet, vehicle and doorbell detectors. A short local ring buffer preserves the beginning of an event; relevant video is finalized into a seekable MP4, indexed in SQLite, and shown in a timeline in Haus or the app's Home Assistant interface. When a camera explicitly exposes local RTSP stream telemetry, recording uses that source over TCP and falls back to HA HLS after repeated failures. This avoids an additional HLS remux and preserves source audio when an HA HLS session has lost its audio packets. Stream addresses and credentials stay inside the helper. Cameras without unambiguous local telemetry continue through HA. Recordings remain on your home server. There is no cloud video service.

## Install

Add `https://github.com/resonaura/haus-helper` to **Settings → Apps → App store → Repositories**, install **Haus**, and start it. On earlier Home Assistant versions these pages are named **Add-ons**. Open its web interface, or open a camera in the Haus desktop app.

Container images are built by GitHub Actions for `amd64` and `aarch64`. The app uses Home Assistant's authenticated Ingress; it does not publish a network port, use the host network, or require a new password. `homeassistant_api` lets it discover entities and obtain camera streams with the Supervisor-provided credential. The credential never enters the browser or recordings database.

## Recording

- Related entities on the same registered device are linked automatically. A unique matching camera name can link an external detector. A shared room alone is insufficient; ambiguous matches remain suggestions.
- Choose **Detectors & recording** to disable a camera or explicitly choose its detectors. An empty manual selection disables automatic event capture for that camera; **Record now** remains available.
- Motion and object activity share an event. New detections extend the tail up to the configured event limit. Events show their original detector types and timestamps.
- Defaults: 8 seconds of pre-roll, 20 seconds after activity, 5 minutes maximum per event, 7 days of retention, 10 GB of saved video and 1 GB for temporary buffers. These limits are configurable through the Home Assistant app options.
- Buffers use stream copy. Finalization normalizes camera video to H264 for reliable hardware decoding, with at most two encoder threads per clip. This uses CPU when saving events; rolling buffers use stream copy. Older clips get a compatible playback copy on first use; originals are preserved and both copies follow storage retention. Audio is controlled by the app's `record_audio` option.
- A camera must expose a working HLS stream through Home Assistant. Snapshot-only cameras cannot produce recordings. Actual pre-roll depends on the available buffered stream; camera or server outages can produce partial recordings, which are identified in the event metadata. Timestamps describe ingestion into the local buffer, not a camera's hardware clock.

Completed MP4s and thumbnails live in `/media/haus`. The database and temporary buffers live in the app's `/data`. Retention only cleans Haus-owned files. Existing media outside these directories is untouched. Shutdown or failed finalization leaves an explicit event status rather than an empty playable recording.

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

Camera availability is observed from Home Assistant camera entity states and persisted separately from motion events. Offline bands mean the camera reported unavailable/off. Missing events do not mean offline. Server disconnections and periods before availability tracking are unknown; no past uptime is invented. Availability follows recording retention.

## Talkback

Haus discovers an explicitly exposed `sensor.<camera>_talkback_rtmp_stream` with a private RTMP `/talk/` target. It does not infer audio input from RTSP or generic streaming support. The desktop microphone is opened only by the Talk action. Audio goes through authenticated HA ingress to FFmpeg and the camera; it is never written to storage by this endpoint. Leaving the camera, hiding the app, cancellation, disconnect or the one-minute limit stops the session. The API only returns capability availability, never the camera URL.

## Local development preview: NVR, shared layout and recovery

These changes are in the local development branch. The published 0.1.9 image has not been replaced yet.

Haus keeps working with just this helper. Optional `haus-nvr` Docker workers add storage and media delivery. Pair a node from **Haus → Settings → Storage, streaming & backups** using its address and unique key. The helper keeps original recordings, chooses up to two storage-worker copies and gives each connected worker encrypted configuration/HA recovery archives. A worker going offline does not remove originals. Paused nodes stop receiving work; disconnected nodes retain existing copies until their owner removes them.

Shared home layout is stored on the helper with revision checks. Clients keep a home-scoped cache and preserve offline edits. This covers favorites, visibility, grouping, device order and room icons. Appearance and usage counters stay local to each client.

Configuration snapshots run hourly and after settled configuration changes; the ring retains 24 versions. Daily Home Assistant configuration/app backups retain 7 versions. HA archives include Home Assistant, apps, SSL, share and local-app configuration; media is excluded. `ha_backups_enabled` can disable scheduled HA backups. The add-on needs the Supervisor `backup` role for this feature. Its own backup and video-buffer directories are excluded, and hot-backup hooks create a consistent SQLite snapshot while the live WAL stays open. Retention only deletes HA backup slugs created by Haus.

Use **Save recovery kit** in the desktop app. The native file dialog writes a private JSON export; keys are never returned through the renderer's generic service API. Keep that file offline: it contains the archive key and worker access keys. Workers do not receive the archive decryption key. A verified recovery export does not automatically overwrite a running helper, restore HA or change scenes/devices. The separate NVR project includes the recovery CLI and deployment instructions.

For optional worker **live relays**, enable the helper's source port on a trusted private network and set the worker's `HAUS_SOURCE_ORIGIN` to that address. The port is disabled by default. Only expiring, camera-scoped, opaque source capabilities work there; ordinary APIs still require ingress authentication. No HA token is sent to a worker. Recording delivery can go directly from worker to desktop using a short-lived, single-file grant, without opening this helper port.

Live warming is limited to two recent cameras, with a 45-second idle period. Client-loss heartbeats are bounded, battery-associated cameras release their last warm lease immediately, and off/unavailable cameras revoke it. Existing recording buffers do not need an extra background decoder. Warming does not open a computer microphone.

For **Eufy talkback**, Haus automatically discovers one running `eufy-security-ws` app through Supervisor and uses its verified private address and configured port. For an external installation, set `eufy_ws_url` to your private Eufy Security WebSocket server. Haus uses exact device identifiers and asks that server whether talkback is supported. It waits for channel confirmation, sends mono 16 kHz AAC and stops only the sessions it started. An already-running livestream is preserved. RTSP alone does not enable the Talk action. The helper ingress streams POST audio so a microphone request is not buffered in full. Speaker playback still needs a real-device check; development tests use synthetic audio.

Legacy recordings keep their originals. Versioned compatibility copies use fixed cadence and short keyframe intervals. Known missing source frames are reported; normalization does not reconstruct them. Encoder work is bounded and foreground playback is prioritized over next-clip preparation.

Backups use hot mode with a consistent SQLite copy, so a scheduled Home Assistant backup can include Haus without stopping its coordinator. The pre/post hooks tolerate upgrading from an older image that does not contain the hook yet.
