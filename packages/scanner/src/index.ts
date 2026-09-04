import { decodeSampledSymbol } from "@circlecode/decoder";
import { verifyEnvelopeOffline, type CircleCodeTrustStore, type OfflineVerificationResult } from "@circlecode/security";
import { decodeImageData, type VisionDecodeResult } from "@circlecode/vision";

export type CircleCodeScanResult = {
  visual: VisionDecodeResult;
  decoded: ReturnType<typeof decodeSampledSymbol>;
  security: OfflineVerificationResult;
};

export class CircleCodeScanner {
  #stream: MediaStream | undefined;

  constructor(readonly trustStore: CircleCodeTrustStore) {}

  async scanImageData(image: ImageData): Promise<CircleCodeScanResult> {
    const visual = decodeImageData(image);
    const decoded = decodeSampledSymbol(visual.symbol, visual.unknownPhysicalSlots);
    const security = await verifyEnvelopeOffline(decoded.envelopeBytes, this.trustStore);
    return { visual, decoded, security };
  }

  async scanCanvas(canvas: HTMLCanvasElement): Promise<CircleCodeScanResult> {
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

  async scanVideoFrame(video: HTMLVideoElement, canvas = document.createElement("canvas")): Promise<CircleCodeScanResult> {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D Canvas is unavailable");
    context.drawImage(video, 0, 0);
    return this.scanCanvas(canvas);
  }
}
