import { afterEach, describe, expect, it, vi } from "vitest";
import { QCCodeScanner } from "../packages/scanner/src/index.js";
import { MemoryTrustStore } from "../packages/security/src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mediaStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function videoElement(play = vi.fn(async () => {})) {
  return { srcObject: null, play } as unknown as HTMLVideoElement;
}

function setup() {
  const getUserMedia = vi.fn<() => Promise<MediaStream>>();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { scanner: new QCCodeScanner(new MemoryTrustStore()), getUserMedia };
}

afterEach(() => vi.unstubAllGlobals());

describe("camera lifecycle", () => {
  it("stops a stream obtained after stopCamera without attaching or playing it", async () => {
    const { scanner, getUserMedia } = setup();
    const pending = deferred<MediaStream>();
    const { stream, tracks } = mediaStream();
    const video = videoElement();
    getUserMedia.mockReturnValueOnce(pending.promise);
    const start = scanner.startCamera(video);
    scanner.stopCamera();
    pending.resolve(stream);
    await start;
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(video.play).not.toHaveBeenCalled();
  });

  it.each([true, false])("only attaches the latest overlapping start (older resolves first: %s)", async (olderFirst) => {
    const { scanner, getUserMedia } = setup();
    const older = deferred<MediaStream>(), newer = deferred<MediaStream>();
    const oldMedia = mediaStream(), newMedia = mediaStream();
    const video = videoElement();
    getUserMedia.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const oldStart = scanner.startCamera(video), newStart = scanner.startCamera(video);
    if (olderFirst) {
      older.resolve(oldMedia.stream);
      await oldStart;
      expect(video.srcObject).toBeNull();
    }
    newer.resolve(newMedia.stream);
    await newStart;
    if (!olderFirst) {
      older.resolve(oldMedia.stream);
      await oldStart;
    }
    expect(video.srcObject).toBe(newMedia.stream);
    expect(video.play).toHaveBeenCalledOnce();
    for (const track of oldMedia.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of newMedia.tracks) expect(track.stop).not.toHaveBeenCalled();
    scanner.stopCamera();
    expect(video.srcObject).toBeNull();
    for (const track of newMedia.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stops and detaches the stream when playback rejects", async () => {
    const { scanner, getUserMedia } = setup();
    const { stream, tracks } = mediaStream();
    const error = new Error("playback failed");
    const video = videoElement(vi.fn().mockRejectedValue(error));
    getUserMedia.mockResolvedValueOnce(stream);
    await expect(scanner.startCamera(video)).rejects.toBe(error);
    expect(video.srcObject).toBeNull();
    scanner.stopCamera();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each([true, false])("keeps the camera stopped when pending playback completes (rejects: %s)", async (rejects) => {
    const { scanner, getUserMedia } = setup();
    const playback = deferred<void>();
    const { stream, tracks } = mediaStream();
    const video = videoElement(vi.fn().mockReturnValue(playback.promise));
    getUserMedia.mockResolvedValueOnce(stream);
    const start = scanner.startCamera(video);
    await Promise.resolve();
    expect(video.srcObject).toBe(stream);
    scanner.stopCamera();
    expect(video.srcObject).toBeNull();
    if (rejects) {
      const error = new Error("stopped playback");
      playback.reject(error);
      await expect(start).rejects.toBe(error);
    } else {
      playback.resolve();
      await start;
    }
    expect(video.srcObject).toBeNull();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("propagates a late acquisition failure without disturbing the newer camera", async () => {
    const { scanner, getUserMedia } = setup();
    const older = deferred<MediaStream>();
    const { stream, tracks } = mediaStream();
    const video = videoElement();
    getUserMedia.mockReturnValueOnce(older.promise).mockResolvedValueOnce(stream);
    const oldStart = scanner.startCamera(video);
    await scanner.startCamera(video);
    const error = new Error("permission denied");
    older.reject(error);
    await expect(oldStart).rejects.toBe(error);
    expect(video.srcObject).toBe(stream);
    for (const track of tracks) expect(track.stop).not.toHaveBeenCalled();
    scanner.stopCamera();
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each([true, false])("does not clear a newer stream when old playback completes (rejects: %s)", async (rejects) => {
    const { scanner, getUserMedia } = setup();
    const playback = deferred<void>();
    const oldMedia = mediaStream(), newMedia = mediaStream();
    const video = videoElement(vi.fn().mockReturnValueOnce(playback.promise).mockResolvedValue(undefined));
    getUserMedia.mockResolvedValueOnce(oldMedia.stream).mockResolvedValueOnce(newMedia.stream);
    const oldStart = scanner.startCamera(video);
    await Promise.resolve();
    expect(video.srcObject).toBe(oldMedia.stream);
    await scanner.startCamera(video);
    if (rejects) {
      const error = new Error("old playback failed");
      playback.reject(error);
      await expect(oldStart).rejects.toBe(error);
    } else {
      playback.resolve();
      await oldStart;
    }
    expect(video.srcObject).toBe(newMedia.stream);
    for (const track of oldMedia.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of newMedia.tracks) expect(track.stop).not.toHaveBeenCalled();
    scanner.stopCamera();
    expect(video.srcObject).toBeNull();
    for (const track of newMedia.tracks) expect(track.stop).toHaveBeenCalledOnce();
  });

  it("detaches the previous video when switching elements but preserves externally replaced srcObject", async () => {
    const { scanner, getUserMedia } = setup();
    const oldMedia = mediaStream(), newMedia = mediaStream(), external = mediaStream();
    const oldVideo = videoElement(), newVideo = videoElement();
    getUserMedia.mockResolvedValueOnce(oldMedia.stream).mockResolvedValueOnce(newMedia.stream);
    await scanner.startCamera(oldVideo);
    await scanner.startCamera(newVideo);
    expect(oldVideo.srcObject).toBeNull();
    for (const track of oldMedia.tracks) expect(track.stop).toHaveBeenCalledOnce();
    newVideo.srcObject = external.stream;
    scanner.stopCamera();
    expect(newVideo.srcObject).toBe(external.stream);
    for (const track of newMedia.tracks) expect(track.stop).toHaveBeenCalledOnce();
    for (const track of external.tracks) expect(track.stop).not.toHaveBeenCalled();
  });
});
