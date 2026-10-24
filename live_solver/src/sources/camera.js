// 摄像头封装：设备选择、前后摄、手电筒。

export class CameraSource {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.settings = {};
    this.facingMode = 'environment';
  }

  async start({ deviceId, facingMode } = {}) {
    await this.stop();
    if (facingMode) this.facingMode = facingMode;

    const base = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    };

    const attempts = [];
    if (deviceId) {
      attempts.push({ video: { ...base, deviceId: { exact: deviceId } }, audio: false });
    }
    if (this.facingMode) {
      attempts.push({
        video: { ...base, facingMode: { ideal: this.facingMode } },
        audio: false,
      });
    }
    attempts.push({ video: { ...base }, audio: false });
    attempts.push({ video: true, audio: false });

    let lastError = null;
    for (const constraints of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!this.stream) {
      throw lastError || new Error('无法访问摄像头');
    }

    this.video.srcObject = this.stream;
    this.track = this.stream.getVideoTracks()[0] || null;
    this.settings = this.track?.getSettings?.() || {};
    try {
      await this.video.play();
    } catch {
      // 某些浏览器自动播放被拒，下一次用户手势会继续
    }
    return this.settings;
  }

  async stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.track = null;
    try {
      this.video.srcObject = null;
    } catch {
      // ignore
    }
  }

  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  currentDeviceId() {
    return this.settings?.deviceId || this.track?.getSettings?.().deviceId || '';
  }

  hasTorch() {
    try {
      return !!this.track?.getCapabilities?.().torch;
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    if (!this.track || !this.hasTorch()) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: on }] });
      return true;
    } catch {
      return false;
    }
  }

  get width() {
    return this.video.videoWidth || 0;
  }

  get height() {
    return this.video.videoHeight || 0;
  }
}
