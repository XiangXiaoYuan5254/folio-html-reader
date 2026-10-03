// The microphone as 16-bit samples, 64 ms at a time, at the audio context's rate (16 kHz),
// for page-hearing.ts.
class Mic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(1024);
    this.at = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const v = Math.max(-1, Math.min(1, channel[i]));
      this.samples[this.at++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.at === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(1024);
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor('folio-mic', Mic);
