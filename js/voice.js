// Голосовые подсказки (speechSynthesis) и голосовые команды (SpeechRecognition).

export class Voice {
  constructor() {
    this.enabled = true;
    this.voice = null;
    this.native = window.AndroidApp || null; // Android-приложение: озвучка через системный TextToSpeech
    this.supported = !!this.native || 'speechSynthesis' in window;
    if (!this.native && this.supported) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find((v) => v.lang === 'ru-RU' && v.localService) || vs.find((v) => v.lang?.startsWith('ru')) || null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  say(text, { interrupt = false, delay = 0 } = {}) {
    if (!this.enabled || !this.supported || !text) return;
    const go = () => {
      if (this.native) return this.native.speak(text, !!interrupt);
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      if (this.voice) u.voice = this.voice;
      u.rate = 1.08;
      u.volume = 1;
      speechSynthesis.speak(u);
    };
    if (delay) setTimeout(go, delay);
    else go();
  }

  cancel() {
    if (this.native) this.native.stopSpeaking();
    else if (this.supported) speechSynthesis.cancel();
  }
}

const COMMANDS = [
  { re: /(отмен|убери|назад)/, cmd: 'undo' },
  { re: /(пауз|стоп пауз|подожди)/, cmd: 'pause' },
  { re: /(продолж|поехали|дальше|старт|начать)/, cmd: 'resume' },
  { re: /(законч|заверш|финиш|конец трениров)/, cmd: 'finish' },
  { re: /(счёт|счет|сколько|статист|процент)/, cmd: 'score' },
  { re: /(попал|забил|есть попад|плюс)/, cmd: 'make' },
  { re: /(мимо|промах|минус)/, cmd: 'miss' },
  { re: /(приблиз|зум|увелич)/, cmd: 'zoom-in' },
  { re: /(отдал|уменьш)/, cmd: 'zoom-out' },
];

export class Commands {
  constructor(onCommand) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.SR = SR;
    this.onCommand = onCommand;
    this.active = false;
    this.rec = null;
  }

  start() {
    if (!this.supported || this.active) return;
    this.active = true;
    this._spawn();
  }

  _spawn() {
    if (!this.active) return;
    const rec = new this.SR();
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        for (const alt of e.results[i]) {
          const text = alt.transcript.toLowerCase();
          const hit = COMMANDS.find((c) => c.re.test(text));
          if (hit) {
            this.onCommand(hit.cmd, text);
            return;
          }
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.active = false;
    };
    rec.onend = () => {
      if (this.active) setTimeout(() => this._spawn(), 300);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      /* уже запущено */
    }
  }

  stop() {
    this.active = false;
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }
}
