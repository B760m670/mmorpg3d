import { SEA } from '../config.js';

// The bridge VHF with DSC. Channels of the international maritime band,
// dual watch (the selected channel and 16), squelch, 25 W / 1 W. What is on
// the air is generated: the coast radio's sécurité announcements on 16 and
// the weather and navigational warnings read on its working channel,
// fishermen talking on 72 and 77 (in Norwegian), a ferry and a yacht on 16
// and 13 - each heard only if the set is on and on that channel. You can call
// the coast radio for the weather (made from the game's weather), the fish
// quay at Reine, and send a DSC distress alert and cancel it as a false
// alert, as the GMDSS procedure goes.
//
// Voices are the browser's speech synthesis (English; Norwegian if the
// device has a Norwegian voice, otherwise the radio gives the sound of
// speech and the panel the words). The panel shows each transmission with
// a Russian translation.
//
// Fictional on purpose: the vessel names, the ship's MMSI and the coast
// radio's working channel (26 here). The procedure and phrasing follow the
// standard marine communication phrases.

const CH_LIST = [6, 8, 9, 10, 12, 13, 14, 16, 26, 67, 69, 72, 73, 77];
export const CH_NAME = {
  6: 'судно–судно, безопасность и поиск-спасание',
  8: 'судно–судно',
  9: 'судно–судно, портовые операции',
  10: 'судно–судно, портовые операции',
  12: 'портовые операции (рыбоприёмка Рейне — условно)',
  13: 'мостик–мостик, безопасность плавания',
  14: 'портовые операции',
  16: 'бедствие, безопасность и вызов',
  26: 'береговая радиостанция, рабочий (условно)',
  67: 'судно–судно',
  69: 'судно–судно',
  72: 'судно–судно (рыбаки)',
  73: 'судно–судно',
  77: 'судно–судно (рыбаки)',
};
const SHIP = 'Kestrel';
const MMSI = '232004270';               // fictional
const COAST = { id: 'coast', name: 'Norwegian Coast Radio', ru: 'Береговая радиостанция', lang: 'en-GB', pitch: 0.85, rate: 0.95 };
const ME = { id: 'me', name: `${SHIP} (вы)`, ru: 'Вы', lang: 'en-GB', pitch: 1.12, rate: 1.0 };
const QUAY = { id: 'quay', name: 'Reine fiskemottak', ru: 'Рыбоприёмка Рейне', lang: 'en-GB', pitch: 1.0, rate: 0.98 };
const V = (name, pitch, rate) => ({ id: name, name, ru: `«${name}»`, lang: 'nb-NO', pitch, rate });
const HAVBRIS = V('Havbris', 0.8, 1.05), SJO = V('Sjøstjerna', 1.0, 1.0), NORDKYN = V('Nordkyn', 0.9, 1.1), STORVAG = V('Storvåg', 1.1, 0.95);
const FERRY = { id: 'ferry', name: 'ferry Moskenes', ru: 'Паром (Москенес)', lang: 'en-GB', pitch: 0.95, rate: 1.0 };
const YACHT = { id: 'yacht', name: 'sailing yacht Aurora', ru: 'Яхта «Аврора»', lang: 'en-US', pitch: 1.2, rate: 1.0 };

const DIRS_EN = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const DIRS_RU = ['северный', 'северо-восточный', 'восточный', 'юго-восточный', 'южный', 'юго-западный', 'западный', 'северо-западный'];
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const spell = (n) => String(n).split('').map((d) => NUM[+d] || d).join(' ');

export class Radio {
  constructor({ sensors, elec, alarms, sound, weather, trawl }) {
    this.S = sensors; this.E = elec; this.A = alarms; this.sound = sound; this.weather = weather; this.T = trawl;
    this.ch = 16;
    this.dw = true;              // dual watch: 16 and the selected channel
    this.sq = true;              // squelch closed (hiss only when a signal)
    this.vol = 0.8;
    this.hi = true;              // 25 W
    this.queue = [];             // transmissions waiting, in order
    this.cur = null;             // on the air now
    this.log = [];               // what was heard, newest first
    this.t = 0;
    this.next = 40 + Math.random() * 40;       // next piece of background traffic
    this.nextSec = 150 + Math.random() * 120;  // next coast radio sécurité
    this.await = null;           // waiting for us to change channel
    this.dsc = null;             // distress alert state
    this.msg = '';
    this.near = 1;               // how well the loudspeaker is heard where you are
    this.voices = [];
    this._loadVoices();
    if (typeof window !== 'undefined') {
      const unlock = () => {
        try { if (window.speechSynthesis) window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* no speech */ }
        window.removeEventListener('pointerdown', unlock);
      };
      window.addEventListener('pointerdown', unlock);
    }
  }

  _loadVoices() {
    const ss = typeof window !== 'undefined' && window.speechSynthesis;
    if (!ss) return;
    const get = () => { this.voices = ss.getVoices() || []; };
    get();
    ss.onvoiceschanged = get;
  }

  _voice(lang) {
    const v = this.voices;
    return v.find((x) => x.lang === lang) || v.find((x) => x.lang && x.lang.replace('_', '-').startsWith(lang.slice(0, 2)) && (lang !== 'nb-NO' || /^(nb|no|nn)/.test(x.lang))) || (lang.startsWith('en') ? v.find((x) => /^en/.test(x.lang)) : null);
  }

  get on() { return this.S.ready('vhf'); }
  get busy() { return !!this.cur; }
  listening(ch) { return this.on && (this.ch === ch || (this.dw && ch === 16)); }

  // ------------------------------------------------------------ controls
  step(d) {
    const i = CH_LIST.indexOf(this.ch);
    this.ch = CH_LIST[(i + d + CH_LIST.length) % CH_LIST.length];
  }
  setCh(c) { if (CH_LIST.includes(c)) this.ch = c; }

  // ------------------------------------------------------------ the air
  // add a conversation: lines [{ st, en, ru, nb, ch, gap }]
  say(lines, ch) {
    for (const l of lines) this.queue.push({ ch: l.ch || ch, gap: l.gap ?? 1.2 + Math.random() * 1.3, ...l });
  }

  _start(tx) {
    this.cur = tx;
    tx.heard = tx.st.id === 'me' ? this.on : this.listening(tx.ch);
    const text = tx.st.lang === 'nb-NO' ? tx.nb : tx.en;
    const words = text.split(/\s+/).length;
    tx.est = 0.7 + words * 0.36 / (tx.st.rate || 1);
    tx.left = tx.est * 1.8 + 4;            // safety: speech that never ends
    tx.done = false;
    if (!tx.heard) { tx.left = tx.est; return; }
    this.log.unshift({ ch: tx.ch, time: this._clock(), who: tx.st.name, ruWho: tx.st.ru, text, ru: tx.ru, me: tx.st.id === 'me' });
    if (this.log.length > 30) this.log.pop();
    const vol = this.vol * this.near;
    if (tx.st.id !== 'me' && this.sound && this.sound.ctx && vol > 0.02) this.sound.radioOpen(vol * (this.hi || tx.st.id !== 'me' ? 1 : 0.8));
    const ss = typeof window !== 'undefined' && window.speechSynthesis;
    const voice = this._voice(tx.st.lang);
    if (!ss || !voice || vol < 0.02) {
      // no voice for it: the sound of speech, the words on the panel
      if (this.sound && this.sound.ctx && vol > 0.02 && tx.st.id !== 'me') this.sound.radioChatter();
      tx.left = tx.est;
      return;
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.pitch = tx.st.pitch;
      u.rate = tx.st.rate;
      u.volume = Math.min(1, vol * (tx.st.id === 'me' ? 0.6 : 1));
      u.onend = () => { tx.done = true; };
      u.onerror = () => { tx.done = true; };
      ss.speak(u);
    } catch (e) { tx.left = tx.est; }
  }

  _end() {
    const tx = this.cur;
    if (tx.heard && tx.st.id !== 'me' && this.sound && this.sound.ctx) this.sound.radioClose();
    this.cur = null;
    if (tx.then) tx.then();
  }

  _clock() {
    const d = new Date();
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
  }

  update(dt, { near = 1 } = {}) {
    this.t += dt;
    this.near = near;
    // stop talking when the set goes off
    if (this.cur && this.cur.heard && !this.on) {
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* none */ }
      this.cur.done = true;
    }
    if (this.cur) {
      this.cur.left -= dt;
      if (this.cur.done || this.cur.left <= 0) this._end();
    } else if (this.queue.length) {
      const q = this.queue[0];
      q.gap -= dt;
      if (q.gap <= 0) this._start(this.queue.shift());
    }
    // a station waiting for us on another channel
    if (this.await && !this.cur && !this.queue.length) {
      if (this.on && this.ch === this.await.ch) { const f = this.await.go; this.await = null; f(); }
      else if (this.t > this.await.until) { this.msg = this.await.lost || ''; this.await = null; }
    }
    // background traffic
    this.next -= dt;
    if (this.next <= 0 && !this.queue.length && !this.cur) { this.next = 70 + Math.random() * 110; this._chatter(); }
    this.nextSec -= dt;
    if (this.nextSec <= 0 && !this.queue.length && !this.cur) { this.nextSec = 420 + Math.random() * 300; this._securite(); }
    // DSC: the coast station acknowledges a distress alert
    if (this.dsc && this.dsc.state === 'sent' && this.t - this.dsc.t > 14 && !this.cur) {
      this.dsc.state = 'acked';
      this.ch = 16;
      this.A.set('dsc', true, 'ЦИВ: бедствие подтверждено береговой станцией 002570000', 'alarm');
      this.say([{ st: COAST, en: `Mayday ${SHIP}, ${SHIP}, ${SHIP}. This is Norwegian Coast Radio, Norwegian Coast Radio, Norwegian Coast Radio. Received mayday. What is the nature of your distress? Over.`,
        ru: `Мэйдэй «Кестрел» ×3. Говорит береговая радиостанция ×3. Ваш сигнал бедствия принят. Что у вас случилось? Приём.`, gap: 0.5 }], 16);
    }
    if (this.dsc && this.dsc.armed && this.t > this.dsc.armed) { this.dsc = null; this.msg = 'крышка кнопки бедствия закрыта'; }
  }

  // ------------------------------------------------------------ calls
  _pos() {
    const g = this.S.gps;
    const f = (v, pos, neg, w) => {
      const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
      return { en: `${spell(String(d).padStart(w, '0'))} degrees ${spell(m.toFixed(1).replace('.', ''))} minutes ${v >= 0 ? pos : neg}`, txt: `${d}°${m.toFixed(1)}′ ${v >= 0 ? 'N' : 'S'}` };
    };
    const la = f(g.lat, 'north', 'south', 2), lo = f(g.lon, 'east', 'west', 3);
    return { en: `${la.en}, ${lo.en}`, txt: `${la.txt} ${lo.txt.replace('N', 'E').replace('S', 'W')}` };
  }

  callCoast() {
    if (!this.on) { this.msg = 'радиостанция выключена (Приборы → УКВ)'; return; }
    if (this.cur || this.queue.length) { this.msg = 'канал занят — дождитесь конца передачи'; return; }
    if (this.ch !== 16 && this.ch !== 26) { this.msg = 'береговую станцию вызывают на 16-м или на её рабочем 26-м'; return; }
    const request = () => this._weatherExchange();
    if (this.ch === 26) { request(); return; }
    this.say([
      { st: ME, en: `Norwegian Coast Radio, Norwegian Coast Radio, this is ${SHIP}, ${SHIP}. Over.`, ru: 'Береговая радиостанция ×2, я «Кестрел» ×2. Приём.', gap: 0.2 },
      { st: COAST, en: `${SHIP}, Norwegian Coast Radio. Channel two six, please. Over.`, ru: '«Кестрел», береговая. Перейдите на 26-й канал. Приём.', gap: 2.5 },
      { st: ME, en: 'Two six.', ru: 'На 26-й.' },
    ], 16);
    this.await = { ch: 26, until: this.t + 90, go: request, lost: 'береговая станция ждала на 26-м — вызовите снова' };
    this.msg = 'перейдите на 26-й канал';
  }

  _weatherExchange() {
    const w = this.forecast();
    this.say([
      { st: ME, en: `Norwegian Coast Radio, ${SHIP} on channel two six. Requesting the latest weather for Vestfjorden. Over.`, ru: 'Береговая, «Кестрел» на 26-м. Прошу последний прогноз для Вестфьорда. Приём.', gap: 0.5 },
      { st: COAST, en: `${SHIP}, Norwegian Coast Radio. ${w.en} Over.`, ru: `«Кестрел», береговая. ${w.ru} Приём.`, gap: 2.5 },
      { st: ME, en: `Thank you. ${SHIP} out.`, ru: 'Спасибо. «Кестрел», конец связи.' },
      { st: COAST, en: 'Coast radio out.', ru: 'Береговая, конец связи.' },
    ], 26);
    this.msg = '';
  }

  callQuay() {
    if (!this.on) { this.msg = 'радиостанция выключена'; return; }
    if (this.cur || this.queue.length) { this.msg = 'канал занят'; return; }
    if (this.ch !== 12) { this.msg = 'рыбоприёмка слушает 12-й канал (условно)'; return; }
    const kg = Math.round((this.T ? this.T.holdKg : 0) / 100) * 100;
    this.say([
      { st: ME, en: `Reine fish reception, this is ${SHIP}. ${kg > 0 ? `About ${kg} kilos of fish to land.` : 'Requesting a berth.'} Over.`, ru: `Рыбоприёмка Рейне, я «Кестрел». ${kg > 0 ? `Около ${kg} кг рыбы на сдачу.` : 'Прошу причал.'} Приём.`, gap: 0.2 },
      { st: QUAY, en: `${SHIP}, Reine fish reception. The berth on the west side is free, depth six metres.${kg > 0 ? ' We have tubs and ice ready.' : ''} Shore power on the pillar, one two five amps. Over.`,
        ru: `«Кестрел», рыбоприёмка. Причал с западной стороны свободен, глубина 6 м.${kg > 0 ? ' Чаны и лёд готовы.' : ''} Береговое питание на колонке, 125 ампер. Приём.`, gap: 3 },
      { st: ME, en: `Thank you, coming alongside in a few minutes. ${SHIP} out.`, ru: 'Спасибо, подойдём через несколько минут. Конец связи.' },
    ], 12);
    this.msg = '';
  }

  // DSC distress: lift the cover, press again within 5 s
  distress() {
    if (!this.on) { this.msg = 'радиостанция выключена'; return; }
    if (this.dsc && (this.dsc.state === 'sent' || this.dsc.state === 'acked')) return;
    if (!this.dsc || !this.dsc.armed) { this.dsc = { armed: this.t + 5 }; this.msg = 'КРЫШКА ОТКРЫТА: нажмите «БЕДСТВИЕ» ещё раз в течение 5 с'; return; }
    const p = this._pos();
    this.dsc = { state: 'sent', t: this.t, utc: new Date().toISOString().slice(11, 16), pos: p };
    this.ch = 16;
    this.A.set('dsc', true, `ЦИВ: отправлен сигнал бедствия, ${p.txt}`, 'alarm');
    this.msg = `ЦИВ-бедствие отправлено на 70-м канале: MMSI ${MMSI}, ${p.txt}, ${this.dsc.utc} UTC. Слушайте 16-й.`;
  }

  // cancel a false distress alert: the voice message on 16
  cancelDistress() {
    if (!this.dsc || !this.dsc.state) return;
    const d = this.dsc;
    this.ch = 16;
    this.say([
      { st: ME, en: `All stations, all stations, all stations. This is ${SHIP}, ${SHIP}, ${SHIP}, MMSI ${spell(MMSI)}, position ${d.pos.en}. Cancel my distress alert of ${spell(d.utc.replace(':', ''))} UTC. ${SHIP} out.`,
        ru: `Всем, всем, всем. Я «Кестрел» ×3, MMSI ${MMSI}, место ${d.pos.txt}. Отменяю свой сигнал бедствия, переданный в ${d.utc} UTC. Конец связи.`, gap: 0.3 },
      { st: COAST, en: `${SHIP}, Norwegian Coast Radio. Your false distress alert is cancelled. Coast radio out.`, ru: '«Кестрел», береговая. Ваш ложный сигнал бедствия отменён. Конец связи.', gap: 2.5,
        then: () => { this.A.set('dsc', false); } },
    ], 16);
    this.dsc = null;
    this.msg = 'отмена ложной тревоги передана на 16-м';
  }

  // ------------------------------------------------------------ content
  forecast() {
    const w = this.weather.v, to = this.weather.to || w;
    const wd = SEA.windDir;
    const from = ((Math.atan2(-wd[0], wd[1]) * 180) / Math.PI + 360) % 360;   // the wind blows from opposite to where the sea runs
    const k = Math.round(from / 45) % 8;
    const ws = Math.round(w.wind), wt = Math.round(to.wind);
    const trend = this.weather.auto ? (wt > ws + 2 ? { en: `, increasing to ${wt} later`, ru: `, позже усиление до ${wt}` } : wt < ws - 2 ? { en: `, decreasing to ${wt} later`, ru: `, позже ослабление до ${wt}` } : { en: '', ru: '' }) : { en: ', little change', ru: ', без существенных изменений' };
    const rain = w.rain > 0.6 ? { en: 'Rain, heavy at times.', ru: 'Дождь, временами сильный.' } : w.rain > 0.15 ? { en: 'Showers.', ru: 'Ливни.' } : { en: 'Mainly dry.', ru: 'В основном без осадков.' };
    const vis = w.fog < 1.2 || (w.fog < 2.6 && w.rain <= 0.15) ? { en: 'Visibility good.', ru: 'Видимость хорошая.' } : w.fog < 2.6 ? { en: 'Visibility good, moderate in showers.', ru: 'Видимость хорошая, в осадках умеренная.' } : w.fog < 5 ? { en: 'Visibility moderate, poor in rain.', ru: 'Видимость умеренная, в дожде плохая.' } : { en: 'Visibility poor.', ru: 'Видимость плохая.' };
    const hs = [0.5, 1.2, 2.5, 4.5][this.weather.state.sea ?? 1];
    const gale = ws >= 14 ? { en: 'Gale warning. ', ru: 'Штормовое предупреждение. ' } : '';
    return {
      en: `${gale.en || ''}Coastal forecast for Vestfjorden: wind ${DIRS_EN[k]}, ${ws} metres per second${trend.en}. ${rain.en} ${vis.en} Significant wave height ${hs.toFixed(1)} metres.`,
      ru: `${gale.ru || ''}Прогноз для Вестфьорда: ветер ${DIRS_RU[k]} ${ws} м/с${trend.ru}. ${rain.ru} ${vis.ru} Высота волн ${hs.toFixed(1).replace('.', ',')} м.`,
    };
  }

  _securite() {
    const nav = Math.random() < 0.5;
    this.say([
      { st: COAST, en: `Sécurité, sécurité, sécurité. All stations, all stations, all stations. This is Norwegian Coast Radio. ${nav ? 'Navigational warning' : 'Weather bulletin'} on channel two six. Out.`,
        ru: `Секьюрите ×3. Всем ×3. Говорит береговая радиостанция. ${nav ? 'Навигационное предупреждение' : 'Сводка погоды'} — на 26-м канале. Конец.`, gap: 0.5 },
    ], 16);
    const w = this.forecast();
    const body = nav
      ? { en: 'Navigational warning. Vestfjorden, west of Reine: a drifting fishing net with floats reported. Ships are requested to keep a sharp lookout. Out.', ru: 'Навигационное предупреждение. Вестфьорд, к западу от Рейне: сообщается о дрейфующей сети с поплавками. Судам нести усиленное наблюдение. Конец.' }
      : { en: `${w.en} Out.`, ru: `${w.ru} Конец.` };
    this.say([{ st: COAST, en: `This is Norwegian Coast Radio. ${body.en}`, ru: `Говорит береговая радиостанция. ${body.ru}`, gap: 6 }], 26);
  }

  _chatter() {
    const blowing = this.weather.v.wind > 10;
    const pick = Math.floor(Math.random() * 4);
    if (pick === 0) {
      this.say([
        { st: HAVBRIS, nb: 'Sjøstjerna, Sjøstjerna, Havbris på syttito.', en: 'Sjostjerna, Sjostjerna, Havbris on seven two.', ru: '«Шёстьерна», «Шёстьерна», «Хавбрис» на 72-м.' },
        { st: SJO, nb: 'Ja, Havbris, Sjøstjerna her.', en: 'Yes Havbris, Sjostjerna here.', ru: 'Да, «Хавбрис», «Шёстьерна» слушает.' },
        { st: HAVBRIS, nb: 'Hvordan går fisket hos dere?', en: 'How is the fishing with you?', ru: 'Как у вас ловится?' },
        { st: SJO, nb: 'Litt torsk på sytti favner, ikke mye. Vi hiver snart.', en: 'A little cod at seventy fathoms, not much. We haul soon.', ru: 'Немного трески на семидесяти саженях, негусто. Скоро выбираем.' },
        { st: HAVBRIS, nb: 'Greit, vi høres. Havbris.', en: 'Fine, talk later. Havbris.', ru: 'Ладно, на связи. «Хавбрис».' },
      ], 72);
    } else if (pick === 1) {
      this.say([
        { st: NORDKYN, nb: 'Storvåg, Nordkyn. Har du hørt værmeldinga?', en: 'Storvag, Nordkyn. Have you heard the forecast?', ru: '«Стурвог», это «Нордкюн». Слышал прогноз?' },
        blowing
          ? { st: STORVAG, nb: 'Ja, det blåser godt nå. Vi ligger inne i Reine til det løyer.', en: 'Yes, it is blowing hard now. We stay in Reine until it eases.', ru: 'Да, сейчас крепко дует. Стоим в Рейне, пока не стихнет.' }
          : { st: STORVAG, nb: 'Ja, det skal friske på fra sørvest i kveld. Vi tar en sjø til og går inn.', en: 'Yes, it will freshen from the southwest tonight. One more haul and we go in.', ru: 'Да, к вечеру с юго-запада засвежеет. Ещё один подъём — и домой.' },
        { st: NORDKYN, nb: 'Skjønner. Nordkyn ut.', en: 'Understood. Nordkyn out.', ru: 'Понял. «Нордкюн», конец связи.' },
      ], 77);
    } else if (pick === 2) {
      this.say([
        { st: YACHT, en: 'Moskenes ferry, Moskenes ferry, this is sailing yacht Aurora, Aurora. Over.', ru: 'Паром на Москенес ×2, я яхта «Аврора» ×2. Приём.', ch: 16 },
        { st: FERRY, en: 'Aurora, Moskenes ferry. Go to channel one three. Over.', ru: '«Аврора», паром. Перейдите на 13-й канал. Приём.', ch: 16 },
        { st: YACHT, en: 'One three.', ru: 'На 13-й.', ch: 16 },
        { st: FERRY, en: 'Aurora, ferry on one three. I am leaving Moskenes in five minutes for Bodo. I will pass you on my port side, please keep your course. Over.', ru: '«Аврора», паром на 13-м. Через пять минут отхожу из Москенеса на Будё. Пройду вас левым бортом, держите курс. Приём.', ch: 13, gap: 3 },
        { st: YACHT, en: 'Understood, I keep my course. Aurora out.', ru: 'Понял, курс держу. «Аврора», конец связи.', ch: 13 },
      ]);
    } else {
      this.say([
        { st: SJO, nb: 'Kestrel, Kestrel, Sjøstjerna på seksten.', en: 'Kestrel, Kestrel, Sjostjerna on one six.', ru: '«Кестрел», «Кестрел», «Шёстьерна» на 16-м.', ch: 16 },
        { st: SJO, nb: 'Kestrel, Sjøstjerna. Vi setter garn nordøst for deg. Hold god avstand, en halv nautisk mil. Over.', en: 'Kestrel, Sjostjerna. We are setting nets northeast of you. Keep clear by half a mile. Over.', ru: '«Кестрел», это «Шёстьерна». Ставим сети к северо-востоку от вас. Держитесь в полумиле. Приём.', ch: 16, gap: 4 },
      ]);
    }
  }
}

export { CH_LIST, MMSI };
