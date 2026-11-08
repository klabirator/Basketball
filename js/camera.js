// Работа с камерой: запуск потока, аппаратный зум (если поддерживается), переключение камер.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.hw = 1;
    this.hwCaps = null;
    this.facing = 'environment';
  }

  get active() {
    return !!this.stream;
  }

  async start({ resolution = '1080', facing = this.facing } = {}) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер не даёт доступ к камере. Откройте приложение по HTTPS в Chrome или Safari.');
    }
    const size = resolution === '720' ? { width: 1280, height: 720 } : { width: 1920, height: 1080 };
    const base = { facingMode: { ideal: facing }, frameRate: { ideal: 30, max: 60 } };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, width: { ideal: size.width }, height: { ideal: size.height } },
      });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base });
    }
    this.stream = stream;
    this.facing = facing;
    this.track = stream.getVideoTracks()[0];
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    await this.video.play().catch(() => {});
    await new Promise((res) => {
      if (this.video.videoWidth) return res();
      this.video.addEventListener('loadedmetadata', res, { once: true });
      setTimeout(res, 3000);
    });
    this.hw = 1;
    this.hwCaps = null;
    try {
      const caps = this.track.getCapabilities?.();
      if (caps?.zoom && caps.zoom.max > caps.zoom.min) {
        this.hwCaps = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
        const cur = this.track.getSettings?.().zoom;
        this.hw = cur || caps.zoom.min || 1;
      }
    } catch {
      /* нет поддержки */
    }
    return stream;
  }

  async setHwZoom(z) {
    if (!this.hwCaps || !this.track) return this.hw;
    const v = Math.min(this.hwCaps.max, Math.max(this.hwCaps.min, z));
    if (Math.abs(v - this.hw) < 0.01) return this.hw;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: v }] });
      this.hw = v;
    } catch {
      this.hwCaps = null;
    }
    return this.hw;
  }

  async hasMultipleCameras() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list.filter((d) => d.kind === 'videoinput').length > 1;
    } catch {
      return false;
    }
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.track = null;
    this.hwCaps = null;
    this.hw = 1;
    this.video.srcObject = null;
  }
}
