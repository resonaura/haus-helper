/** Replication catalog metadata stays bounded even for a five-minute motion burst. */
export function recordingMetadata(event) {
  event = {
    ...event,
    ...(Number.isFinite(event.mediaStartAt)
      ? { mediaStartAt: Math.round(event.mediaStartAt) }
      : {}),
  };
  return Object.fromEntries(
    [
      "id",
      "cameraId",
      "startAt",
      "endAt",
      "mediaStartAt",
      "duration",
      "originalDuration",
      "kinds",
      "playbackVersion",
    ]
      .filter((key) => event[key] !== undefined)
      .map((key) => [key, event[key]])
      .concat(
        event.playbackInfo
          ? [
              [
                "playbackInfo",
                {
                  audio: event.playbackInfo.audio,
                  sourceAudioMissing: event.playbackInfo.sourceAudioMissing,
                  largestGap: event.playbackInfo.largestGap,
                  duration: event.playbackInfo.duration,
                  audioTailSeconds: event.playbackInfo.audioTailSeconds,
                  audioTrimSeconds: event.playbackInfo.audioTrimSeconds,
                },
              ],
            ]
          : [],
      ),
  );
}
