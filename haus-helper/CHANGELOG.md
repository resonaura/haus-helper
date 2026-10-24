# 0.3.33

- Build the Home Assistant disk hierarchy from Supervisor's actual hardware/udev inventory when the simpler host disk list is empty. Preserve physical-device parents, all reported partitions (including boot state), filesystem types, mount aliases and partition purpose without exposing serial numbers or guessing a fixed HA OS layout.
- Attach exact data-filesystem usage only after matching the media mount's kernel device number to its actual partition. Keep unrelated/unmounted usage unknown, avoid duplicate rounded host totals, and retain the older capability fallback. Collection remains read-only and uses the existing bounded telemetry refresh.

# 0.3.32

- Let old local recordings reach background preparation even when the 64 newest pending clips fail repeatedly, belong to disabled cameras or are not yet admitted on a worker.
- Persist bounded retry deadlines in the catalog, prefer unattempted recent footage, and remove bookkeeping for prepared/archived/expired clips. Restarting the controller no longer immediately retries the same failed clip. Keep foreground priority, one remote task, weak-node admission and original media intact.

# 0.3.31

- Let the small encrypted recovery catalog complete while a full Home Assistant archive is pending. Verified cache rotation no longer waits for a long Supervisor backup and fills the recent-video budget in the meantime.
- Keep one bounded task and independent retention/error state for each backup kind, preserve same-kind exclusion, cooldowns and shutdown cleanup, and never treat a configuration success as recovery from an HA backup failure.
- Explain a rejected NVR storage reservation as a space problem instead of suggesting that the video failed integrity verification.

# 0.3.30

- Diagnose rejected NVR recording submissions separately from finalization/import failures, with event and camera correlation and bounded retry logging.
- Preserve only allowlisted node error codes and HTTP status. Limit diagnostic response bodies to 4 KiB, never retain remote messages/source URLs, and keep capture errors and cleanup authoritative when logging fails.

# 0.3.29

- Rotate verified old HA cache copies slightly before the hard storage limit and leave bounded capture headroom (up to 512 MiB, or 10% of a smaller budget). New clips no longer repeatedly fill the last few megabytes and pause event admission until the next trim tick.
- Preserve the exact user limit, explicit unlimited policies, originals on NVR, recovery metadata, active-reader leases and all archive verification requirements. An unavailable or unverified archive still cannot authorize local removal.
- Reproduce the admission-boundary regression below the hard cap and verify that the next capture fits after rotation; retain the complete archive safety/restoration test suite.

# 0.3.28

- Reuse an already warm camera producer for preview, live viewers and recording even when a different node appears less loaded; fall back when the existing node is unavailable.
- Serialize simultaneous camera acquisitions across owners to prevent preview, recording and viewer requests from racing onto different nodes.
- Revalidate a viewer owner's cached producer lease before negotiation so a restarted NVR is reopened or replaced instead of failing the first camera open.

# 0.3.27

- Preserve the consistent SQLite catalog snapshot in Supervisor hot backups using a filename outside the live-database exclusion pattern. Restore that snapshot only when no live catalog exists, keep legacy snapshot compatibility, and clean temporary snapshots after a backup.
- Include the Eufy configured-RTSP correction from 0.3.26 without changing camera transport settings or Aqara protected P2P sources.

# 0.3.26

- Restore NVR viewing, recording and pre-roll for Eufy cameras whose integration explicitly selects RTSP. Keep Aqara on its protected P2P restream, honor registered P2P sources for every vendor, and refuse stale RTSP endpoints when Eufy reports P2P or an unavailable provider. Camera transport settings remain unchanged.

# 0.3.25

- Keep enabled camera RTSP sessions warm on capable NVR nodes for recording and pre-roll. Reuse the same NVR-owned producer for WebRTC viewing, honor camera preview leases, distribute session starts by node capacity, and preserve Aqara/Eufy P2P restream sources without routing media through Home Assistant.

# 0.3.24

- Synchronize home-server names and room assignments with the rest of the home's preferences. Preserve them in encrypted configuration snapshots and through revision conflicts without replacing unrelated settings.

# 0.3.23

- Check every two seconds whether an idle, capable NVR can safely prepare the next retained legacy recording. Keep replica discovery, archive verification and cache rotation on their existing ten-second cadence, while preserving the one-worker limit and refusing pressured or undersized nodes. This reduces avoidable gaps between old-clip preparations without moving processing onto Home Assistant.

# 0.3.22

- Defer archive verification and remote playback reads on storage nodes that report resource pressure. Continue through another healthy, verified replica when available; keep local media untouched when every node is busy.

# 0.3.21

- Keep recent video in a configurable 10 GiB Home Assistant cache by default on new installations. Preserve existing saved budgets and explicit unlimited policies; NVR storage remains unlimited by default.
- Archive original footage and the current playable compatibility copy independently. Require actual SHA-256 verification by a healthy storage node before removing either local copy. Keep the catalog, thumbnails, backups and motion pre-roll; pause capture safely if no verified archive has capacity.
- Read historical original and playback byte ranges from authenticated storage-only or streaming NVR nodes after local rotation. Report local, archived and missing media separately, and recover local-presence flags after an interrupted rotation or catalog restoration.
- Protect playback, finalization, compatibility preparation and retention with leases. Revoke pending rotation when its policy changes, invalidate stale direct grants after repair, release reads on disconnect/shutdown, and advance bounded archive/cache scans past blocked old work.
- Prepare retained historical footage even when its physical camera is temporarily offline, while respecting disabled cameras and avoiding work on evicted originals.
- Derive Home Assistant Core/app CPU usage from cumulative counter deltas when Supervisor's one-shot CPU percentage is unavailable. Reset replaced or expired samples without presenting missing data as zero.

# 0.3.20

- Require validated capture provenance as well as indexed packet timing before opening a camera original directly. Preserve fast opens for the proven Eufy T8410C stream and trusted Haus encodes; Aqara and unknown bitstreams retain normalized playback. Revalidate the overly broad 0.3.19 original markers without discarding existing compatibility copies.
- Begin compatibility preparation after capture and drain older pending work on idle capable NVRs. A bounded pending page no longer stalls forever behind two already-prepared clips per camera.
- Track and pin just-in-time originals uploaded to stream-only workers. Reclaim temporary copies after use, let regular replication adopt them safely, and preserve source recordings and recovery copies.
- Use the supplied macOS artwork in the helper interface.

# 0.3.19

- Default new installations to unlimited saved-video storage while retaining the physical free-space reserve. Persist administrator-selected per-node budgets without pruning existing recordings.
- Add a five-second, bounded Home Assistant server dashboard sample for host CPU, RAM, swap, disks and managed-container usage, plus optional host Docker/PM2 metrics on NVR nodes. The helper only exposes fixed read-only telemetry fields.
- Open verified, fast-indexed H264/AAC recordings directly. Offer a separate compatibility repair for legacy recordings that fail browser decoding; keep source videos unchanged.
- Keep motion event startup resilient when storage admission is paused, without hiding the camera discovery state.

# 0.3.18

- Use the supplied Haus macOS artwork for the add-on icon, preserving its padding and shadow. Camera, recording, cluster and backup behavior is unchanged.

# 0.3.17

- Preserve eight-second pre-event footage for Activity Assist even when inference/cluster delivery is delayed. Retain a bounded delay allowance in the ring, merge earlier assisted detections with hardware activity, and preserve the original event duration limit. Audio and originals remain intact.
- Prepare a small recent recording working set on idle, capable NVR workers after replication, so first opens can reuse native-compatible video. Background work never starts a local HA encoder, respects worker pressure/quotas and yields admission to foreground playback/finalization.

# 0.3.16

- Honor physical-source availability throughout periodic heartbeats and state updates. An idle camera wrapper no longer overwrites its offline source or repeatedly restarts its recovery grace.
- Keep the existing 30-second grace only for previously flowing recordings, stop explicit off immediately, and retain recording preferences for automatic recovery. Verify the complete discovery-to-heartbeat path, not discovery alone.

# 0.3.15

- Inherit availability from an explicitly paired physical camera source. A Generic wrapper serving an offline image cannot keep recording/preheating that placeholder; retain its saved recording policy so it resumes when the source returns. Standalone cameras and unrelated devices keep their own availability.
- Cover unavailable, unknown, off and recovered source states, plus an unavailable wrapper with an online source.

# 0.3.14

- Preserve an explicitly registered P2P camera source during unavailable or disabled telemetry. Do not silently substitute native/legacy RTSP telemetry from the same camera; retain the configured HA fallback until the P2P restream returns.
- Cover unavailable, disabled, restored and unrelated P2P sources without changing camera settings or exposing stream URLs.

# 0.3.13

- Recognize advancing output timestamps when stream-copy FFmpeg omits its frame counter; repeated or invalid progress cannot hide a stall.
- Recover a direct camera recording source after an add-on restart instead of staying indefinitely on HA fallback. Keep the fallback running while one bounded background probe verifies a decoded picture, with a five-minute retry cooldown.
- Defer the handoff during active events, preserve pre-event ring files, cancel probes when a camera is disabled or the helper stops, and resume a verified primary without failure backoff. Never open a microphone or log source URLs.
- Cover actual decoded media, stalled RTSP cancellation, concurrency/cooldown/privacy checks and a real recorder fallback-to-primary transition.

# 0.3.12

- Finish bounded NVR job registration before handling cancellation, so an accepted encoder is deleted even if its response arrives after playback is cancelled.
- Match actual replicated media catalog rows when selecting an existing NVR original.
- Bound local fallback playback to the actual video duration too; validate long-audio-tail conversion with the FFmpeg packaged in each container image.
- Prepare native playback on a capable, lightly loaded optional NVR worker when that node already has the original recording. Retain originals and the authoritative playback copy on Home Assistant.
- Respect worker CPU/memory admission, reserve one in-flight task per node, verify returned size/SHA-256/MP4/audio, release remote work and preserve bounded local fallback for old, weak, unsynced, failed or disconnected workers. Never send camera URLs or Home Assistant credentials to an encoder job.
- Expose remote processing in authenticated diagnostics. Validate source preservation, concurrency, cancellation, checksums, container failures and fallback; exercise the coupled real HTTP/FFmpeg path and native decoding before deployment.

# 0.3.11

- Negotiate short preparation-status polls with updated desktop clients. Long high-resolution conversions on weak Home Assistant hardware no longer depend on one ingress request staying open. Preserve synchronous preparation for older clients.
- Coalesce processing, promote an actively selected clip, bound tracked work and briefly retain failures instead of restarting a failing encoder on every poll. Keep cached playback immediate and report preparation failures without media credentials.
- Expose bounded queue counts, active work type and elapsed processing time in authenticated diagnostics to distinguish encoding from stalled or queued work.
- Verify authenticated HTTP pending/completion behavior, backward compatibility, queue pressure, promotion and redacted retry failures.

# 0.3.10

- Keep packet-copied camera originals separate from normalized native playback. Some camera H264 streams decode in software but are rejected by strict hardware decoders; a successful remux does not prove playback compatibility.
- Normalize raw recordings on demand and cache a separate version-4 playback file. Recheck version-3 recordings, including copies created by 0.3.9, while preserving original media and audio.
- Retain fast capture finalization and verify migration, original-byte preservation and full native playback of actual camera footage.

# 0.3.9

- Remux H264 recordings without re-encoding their pictures or forcing a different frame cadence. Keep audio normalization and seekable MP4 output while reducing finalization work on Home Assistant.
- Check each pre-event ring generation, including reconnects, and retain compatible H264/AAC conversion for other video codecs. Original recordings and existing playback copies remain unchanged.
- Verify real decoded frame checksums/cadence, non-H264 conversion, audio and restart recovery.

# 0.3.8

- Refresh recording metadata on NVR nodes after catalog-field upgrades, even when media bytes were already replicated. Preserve blob copies and avoid re-uploading them.
- Fingerprint authoritative event metadata so changed repair information is republished independently of identical media hashes. Migrate old location records lazily in bounded batches; failed node updates remain retryable.
- Add real SQLite/HTTP regressions for old catalogs, identical-byte playback updates, bounded migration and failure recovery.

# 0.3.7

- Keep a flowing recording/prebuffer alive through up to 30 seconds of transient HA camera snapshot/proxy unavailability. Repeated state updates and registry refreshes cannot extend that deadline.
- Respect explicit camera off immediately; stale/stopped buffers and disabled recording receive no grace. New unavailable cameras are never invented online.
- Keep availability history, recorder, warming and optional analysis consistent; verify expiry, registry replacement, recovery and privacy regressions.

# 0.3.6

- End camera playback at the actual video boundary instead of a long audio-only tail. Preserve originals and create versioned playback copies.
- Realign a legacy silent audio lead only when event boundaries and measured near-silence agree; retain ambiguous audio timing. Copy already normalized video instead of needlessly encoding it again.
- Report prepared duration to the timeline while retaining original duration for audits and cluster metadata. Add real audio/container and metadata regressions.

# 0.3.5

- Activity assist chooses the least-loaded eligible NVR node using CPU, working memory, stream load and reserved analysis capacity. Keep healthy assignments stable and pause or move overloaded workers.
- Report the current or prospective processor even while Activity assist is off, including explicit Home Assistant fallback and capacity/compatibility reasons.
- Detect disabled or disconnected processing nodes promptly and move bounded local work back to an available NVR node. Analysis remains opt-in.
- Add placement, resource-pressure and fallback regressions.

# 0.3.4

- Custom cameras can attach a microphone output using an explicit local RTMP address or a selected source entity. Recording remains opt-in.
- Validate targets at configuration and use, pin DNS to a verified local address, and never return microphone credentials in camera API responses.
- Add source validation and credential-redaction regressions.

# 0.3.3

- New cameras start in Stream only. Preserve explicit settings and migrate previously observed cameras without losing existing recording choices.
- Warm HA viewer manifests separately from direct RTSP recording under bounded, privacy-aware preview leases; avoid duplicate NVR relay workers.
- Add migration/preheat regressions and give the slow-body deadline fixture realistic local scheduling tolerance.

# 0.3.2

- Preserve media extensions on scoped HLS resources so current Linux FFmpeg can decode camera streams on NVR workers without disabling segment validation.
- Use memory working set for worker scheduling; inactive recording file cache no longer prevents useful analysis on small nodes.

# 0.3.1

- Recover in-progress events from persisted pre-event ring segments after a restart or upgrade. Finalize recovery in the background while fresh capture and the API start normally.

# 0.3.0

- Add per-camera software motion recording, disabled by default. Smart mode uses local NanoDet object recognition; sustained-motion mode handles small animals and other movement with temporal/noise/exposure filtering.
- Prefer compatible NVR workers, distribute by quota, expire lost capabilities and reassign failed or persistently overloaded jobs. Keep at most one resource-aware local fallback and never accumulate an inference backlog.
- Preserve the existing continuous pre-event ring and post-activity tail independently of analysis. Normalize first-frame timestamps and bound replicated metadata even for long detection bursts.

# 0.2.10

- Keep motion pre-roll aligned to local receipt times even when a camera's RTP timestamps drift. Preserve the first frame's actual time, including eight seconds of pre-event footage by default.
- Watch completed segments as well as frame counters, restarting an ingest that is alive but no longer produces footage.
- Query playable moments separately from failed capture attempts so failures cannot bury older recordings in the viewer.
- Balance optional relays by each node's available capacity and avoid overloaded workers.

# 0.2.9

- Use RTSP's protocol-specific TCP I/O timeout for direct capture and discovery. Real Debian FFmpeg rejected the HTTP timeout option even though the macOS fixture accepted it; HA fallback preserved video during the check.

# 0.2.8

- Prefer explicitly associated local RTSP telemetry for recording. This bypasses an observed HA HLS session that advertised AAC but delivered no audio packets, while the same camera's direct stream contained sound.
- Use TCP for direct capture, keep HA credentials out of camera requests and public camera metadata, and fall back to authenticated HA HLS after repeated source failures. Source selection is exact/device-based and rejects ambiguous or non-local telemetry.

# 0.2.7

- Probe authenticated HLS audio before selecting recording tracks, allow longer audio discovery, and require the advertised track so an audio-capable source cannot silently start a video-only buffer. Probes cancel when recording stops; sources without audio still retain their video.

# 0.2.6

- Allow authenticated, seekable reads of original recordings for integrity and source timing/audio audits without compatibility encoding or changing the source files. Normal app playback still uses prepared compatible media.

# 0.2.5

- Reconnect when recorder frame progress stalls and forcibly reap encoders that ignore shutdown.
- Reuse healthy recording buffers for preview preheat; never wake battery cameras for dashboard previews.
- Reacquire failed HLS sources and restart lost NVR relays while keeping leases and work bounded.
- Preserve and report actual recorded audio through finalization; validate real H264/AAC output.

# 0.2.4

- Page camera recordings in both directions across days without repeating clips, including equal timestamps.
- Provide indexed calendar-day markers using device-local date boundaries, including daylight-saving transitions.

# 0.2.3

- Create full HA archives as background jobs and wait for the exact named backup through read-only status queries. Accept asynchronous and empty accepted responses without starting duplicate archives.

# 0.2.2

- Back off failed automatic backups for 5–60 minutes and retain that cooldown across restarts. Explicit retries remain available; successful backups clear the failure state.

# 0.2.1

- Discover Eufy using read-only info endpoints permitted to the existing backup role; avoid requiring manager access.

# 0.2.0

- Bounded camera-stream warming and optional NVR live relays with opaque, expiring camera capabilities.
- Optional NVR storage/media workers, verified replication, direct seekable playback grants and recovery catalogs.
- Helper-backed shared layout with revision checks, home-scoped offline caches, and private native recovery-kit export.
- Encrypted configuration/HA backup rings and consistent SQLite hot-backup hooks; exclude recursive archives and media buffers.
- Eufy Security WebSocket talkback with confirmed startup and owned-session cleanup; streaming ingress for microphone POST bodies.
- Fixed-cadence versioned playback copies, explicit concat durations, source-gap diagnostics and a bounded priority encoder queue.

## 0.1.9

- Validate numeric private addresses before accepting a Talkback RTMP target, rejecting external DNS names that resemble private IPv4 prefixes.

## 0.1.8

- Add authenticated microphone streaming for cameras with a dedicated local Talkback RTMP sensor.
- Transcode browser Opus to mono AAC using the existing FFmpeg runtime; stop on disconnect, timeout or client cancellation.
- Keep camera addresses inside the add-on; the client receives only talkback availability.
- Update the Haus icon with platform spacing and a neutral glass treatment.

## 0.1.7

- Normalize saved video for reliable hardware decoding in macOS and desktop players.
- Prepare compatible copies of older recordings on first use while preserving originals; include copies in retention and disk limits.

## 0.1.6

- Persist observed camera availability for offline bands in the Haus video timeline. Gaps while Haus or the server is disconnected remain unknown.

## 0.1.5

- Give every video segment a unique session and sequence identity, use media timestamps for clip selection, and deduplicate manifests to prevent repeated footage.

## 0.1.4

- Pace buffered HLS input in real time and start at the newest segment to preserve pre-roll without filename collisions.

## 0.1.3

- Fix camera buffer process startup and verify authenticated HLS ingestion with real FFmpeg.

# 0.1.2

- Continue long activity across bounded clips without fabricating detection events.
- Respect paused cameras immediately and include all active detectors on reconnect.

# 0.1.1

- Reuse public camera streams while inheriting internal camera detectors.
- Avoid duplicate buffers for Generic camera wrappers.
- Recover ongoing detector activity after reconnection.

# 0.1.0

- Automatic camera and event detector discovery with manual overrides.
- Local pre-roll buffer and event-based MP4 recordings.
- Motion, person, pet, vehicle and doorbell event labels.
- Camera timeline with authenticated seeking and download.
- Local retention and storage limits.
- Home Assistant Ingress and native Haus integration.
