import { WATER } from '../world/WaterOptics.js';

// The dive computer on the wrist, as a panel while diving: depth, maximum,
// dive time, cylinder pressure, water temperature, ascent rate; warnings as a
// real one gives them.
const CSS = `
#dive { position: fixed; top: calc(10px + env(safe-area-inset-top, 0px)); left: calc(10px + env(safe-area-inset-left, 0px));
  display: none; grid-template-columns: repeat(3, auto); gap: 4px 16px; padding: 9px 12px; border-radius: 10px; z-index: 7;
  background: rgba(4, 10, 12, 0.7); border: 1px solid rgba(120, 220, 210, 0.22); color: #d8f3ee;
  font: 12px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; pointer-events: none; }
#dive .l { font-size: 9px; letter-spacing: .12em; color: #7fb0a8; text-transform: uppercase; }
#dive .v { font-size: 18px; color: #f2fffc; }
#dive .s { font-size: 11px; color: #a9d6cf; }
#dive .w { grid-column: 1 / span 3; font-size: 12px; color: #ffcf7a; min-height: 1em; }
#dive .w.bad { color: #ff7a6a; }
#dive .bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,.12); margin-top: 3px; overflow: hidden; }
#dive .bar i { display: block; height: 100%; background: #6fe0c8; }
body.diving #dive { display: grid; }
body.diving #bridge { display: none !important; }
body.touch #dive { gap: 2px 10px; padding: 6px 9px; }
body.touch #dive .v { font-size: 14px; }
`;

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class DiveComputer {
  constructor() {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    const el = document.createElement('div');
    el.id = 'dive';
    el.innerHTML = `
      <div><div class="l">Глубина</div><div class="v" data-k="d">0.0 м</div><div class="s" data-k="max">макс 0.0</div></div>
      <div><div class="l">Время</div><div class="v" data-k="t">0:00</div><div class="s" data-k="rate">—</div></div>
      <div><div class="l">Воздух</div><div class="v" data-k="air">200 бар</div><div class="bar"><i data-k="airbar"></i></div></div>
      <div class="w" data-k="warn"></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.k = {};
    el.querySelectorAll('[data-k]').forEach((n) => { this.k[n.dataset.k] = n; });
    this.last = {};
  }

  set(k, v) {
    if (this.last[k] !== v) { this.last[k] = v; this.k[k].textContent = v; }
  }

  update(diver, { torch, nearShip, touch }) {
    const d = diver.depth;
    this.set('d', `${d.toFixed(1)} м`);
    this.set('max', `макс ${diver.maxDepth.toFixed(1)} · ${WATER.temp} °C`);
    this.set('t', mmss(diver.diveTime));
    const r = diver.rate;
    this.set('rate', Math.abs(r) < 1.5 ? 'на месте' : `${r > 0 ? '↑' : '↓'} ${Math.abs(r).toFixed(0)} м/мин`);
    this.set('air', `${Math.ceil(diver.air)} бар`);
    const pct = Math.max(0, diver.air / 200 * 100);
    if (this.last.pct !== Math.round(pct)) {
      this.last.pct = Math.round(pct);
      this.k.airbar.style.width = `${pct}%`;
      this.k.airbar.style.background = diver.air < 50 ? '#ff7a6a' : diver.air < 100 ? '#ffcf7a' : '#6fe0c8';
    }
    // warnings, most urgent first
    let w = '', bad = false;
    if (diver.air <= 0) { w = 'ВОЗДУХ КОНЧИЛСЯ — аварийный подъём'; bad = true; }
    else if (diver.air < 50) { w = 'мало воздуха — пора наверх'; bad = true; }
    else if (r > 10.5 && d > 1) { w = 'медленнее! подъём не быстрее 10 м/мин'; bad = true; }
    else if (diver.ppO2 > 1.4) { w = `pO₂ ${diver.ppO2.toFixed(2)} бар — опасно для воздуха`; bad = true; }
    else if (d > 40) w = 'глубже 40 м — предел любительского дайвинга';
    else if (diver.maxDepth > 10 && d > 3 && d < 6.5 && diver.stop < 180) w = `остановка безопасности ${mmss(180 - diver.stop)}`;
    else if (diver.atSurface && nearShip) w = touch ? 'у борта: «на борт» — подняться по трапу' : 'у борта: E — подняться по трапу';
    else if (diver.atSurface) w = touch ? 'на поверхности · джойстик вниз-взгляд — нырнуть, ▼ — вниз' : 'на поверхности · посмотрите вниз и W — нырнуть, C — вниз';
    else if (torch) w = 'фонарь включён';
    this.set('warn', w);
    this.k.warn.classList.toggle('bad', bad);
  }
}
