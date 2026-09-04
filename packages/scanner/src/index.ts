import { decodeSampledSymbol } from "@qccode/decoder";
import { verifyEnvelopeOffline, type QCCodeTrustStore, type OfflineVerificationResult } from "@qccode/security";
import { decodeImageData, type VisionDecodeResult } from "@qccode/vision";

export type QCCodeScanResult = {
  visual: VisionDecodeResult;
  decoded: ReturnType<typeof decodeSampledSymbol>;
  security: OfflineVerificationResult;
};

export class QCCodeScanner {
  #stream: MediaStream | undefined;

  constructor(readonly trustStore: QCCodeTrustStore) {}

  async scanImageData(image: ImageData): Promise<QCCodeScanResult> {
    const visual = decodeImageData(image);
    const decoded = decodeSampledSymbol(visual.symbol, visual.unknownPhysicalSlots);
    const security = await verifyEnvelopeOffline(decoded.envelopeBytes, this.trustStore);
    return { visual, decoded, security };
  }

  async scanCanvas(canvas: HTMLCanvasElement): Promise<QCCodeScanResult> {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D Canvas is unavailable");
    return this.scanImageData(context.getImageData(0, 0, canvas.width, canvas.height));
  }

  async startCamera(video: HTMLVideoElement): Promise<void> {
    this.stopCamera();
    this.#stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    video.srcObject = this.#stream;
    await video.play();
  }

  stopCamera(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
  }

  async scanVideoFrame(video: HTMLVideoElement, canvas = document.createElement("canvas")): Promise<QCCodeScanResult> {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable");
    context.drawImage(video, 0, 0);
    return this.scanCanvas(canvas);
  }
}
