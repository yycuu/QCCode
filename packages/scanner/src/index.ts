import { decodeSampledSymbol } from "@qccode/decoder";
import { verifyBearerEnvelope, verifyEnvelopeOffline, type BearerVerificationResult, type QCCodeTrustStore, type OfflineVerificationResult } from "@qccode/security";
import { isBearerEnvelope } from "@qccode/protocol";
import { decodeImageData, type Correction, type VisionDecodeResult } from "@qccode/vision";

export { VisionDecodeError } from "@qccode/vision";

export type QCCodeScanResult = {
  visual: VisionDecodeResult;
  decoded: ReturnType<typeof decodeSampledSymbol>;
  security: OfflineVerificationResult | BearerVerificationResult;
};

export class QCCodeScanner {
  #stream: MediaStream | undefined;
  #video: HTMLVideoElement | undefined;
  #cameraRequest = 0;
  #correction: Correction | undefined;
  #correctionOffset = 0;

  constructor(readonly trustStore: QCCodeTrustStore) {}

  async scanImageData(image: ImageData): Promise<QCCodeScanResult> {
    const offset = this.#correctionOffset;
    this.#correctionOffset = (offset + 12) % 81;
    const visual = decodeImageData(image, { correctionOffset: offset, ...(this.#correction ? { previousCorrection: this.#correction } : {}) });
    this.#correction = visual.correction;
    const decoded = decodeSampledSymbol(visual.symbol, visual.unknownPhysicalSlots);
    const security = isBearerEnvelope(decoded.envelopeBytes)
      ? verifyBearerEnvelope(decoded.envelopeBytes)
      : await verifyEnvelopeOffline(decoded.envelopeBytes, this.trustStore);
    return { visual, decoded, security };
  }

  async scanCanvas(canvas: HTMLCanvasElement): Promise<QCCodeScanResult> {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D Canvas is unavailable");
    return this.scanImageData(context.getImageData(0, 0, canvas.width, canvas.height));
  }

  async startCamera(video: HTMLVideoElement): Promise<void> {
    this.stopCamera();
    const request = this.#cameraRequest;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    if (request !== this.#cameraRequest) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.#stream = stream;
    this.#video = video;
    try {
      video.srcObject = stream;
      await video.play();
    } catch (error) {
      // A newer start or stop already cleaned up a superseded stream.
      if (request === this.#cameraRequest) this.stopCamera();
      throw error;
    }
  }

  stopCamera(): void {
    this.#cameraRequest++;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    if (this.#video && this.#video.srcObject === this.#stream) this.#video.srcObject = null;
    this.#stream = undefined;
    this.#video = undefined;
  }

  async scanVideoFrame(video: HTMLVideoElement, canvas = document.createElement("canvas")): Promise<QCCodeScanResult> {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error("VIDEO_FRAME_UNAVAILABLE");
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return this.scanCanvas(canvas);
  }
}
