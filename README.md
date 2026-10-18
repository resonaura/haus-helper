# Haus

Local companion services for [Haus](https://github.com/resonaura/haus). This repository is `haus-helper`; the Home Assistant app is named **Haus**.

Haus discovers cameras and their motion, person, pet, vehicle and doorbell detectors. A short local ring buffer preserves the beginning of an event; relevant video is finalized into a seekable MP4, indexed in SQLite, and shown in a timeline in Haus or the app's Home Assistant interface. Recordings remain on your home server. There is no cloud video service.

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
