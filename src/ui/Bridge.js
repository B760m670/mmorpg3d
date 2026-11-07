import { BOAT, TELEGRAPH } from '../config.js';

// Bridge instruments as an overlay: speed log, gyro heading, engine-order
// telegraph with rpm, rudder angle indicator and wheel order — what a
// skipper actually watches — plus a one-line hint for the current mode.
const CSS = `
#bridge {
  position: fixed; top: calc(10px + env(safe-area-inset-top, 0px));
  left: calc(10px + env(safe-area-inset-left, 0px));
  display: grid; grid-template-columns: repeat(2, auto); gap: 6px 14px;
  padding: 10px 12px; border-radius: 10px;
  background: rgba(8, 12, 16, 0.62); border: 1px solid rgba(255, 255, 255, 0.12);
  font: 12px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #dfe8ec; pointer-events: none; z-index: 7;
  -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
  font-variant-numeric: tabular-nums;
}
#bridge .lbl { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #8fa3ad; }
#bridge .val { font-size: 18px; color: #f2f7f9; }
#bridge .wide { grid-column: 1 / span 2; }
#bridge .eng { font-size: 13px; color: #ffcf7a; }
#bridge .sea { font-size: 12px; color: #bfe3f2; }
#bridge .rud { position: relative; height: 10px; width: 180px; border-radius: 5px;
  background: linear-gradient(90deg, rgba(255,80,60,.25), rgba(255,255,255,.08) 50%, rgba(60,220,110,.25)); }
#bridge .rud i { position: absolute; top: -2px; width: 4px; height: 14px; border-radius: 2px; background: #f2f7f9; }
#bridge .rud b { position: absolute; top: 1px; width: 2px; height: 8px; background: #ffcf7a; }
#bridge .rud::after { content: ""; position: absolute; left: 50%; top: -3px; width: 1px; height: 16px; background: rgba(255,255,255,.4); }
@media (max-width: 520px) {
  #bridge { gap: 4px 10px; padding: 8px 10px; }
  #bridge .val { font-size: 15px; }
  #bridge .rud { width: 130px; }
}
`;

export class Bridge {
  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = 'bridge';
    el.innerHTML = `
      <div><div class="lbl">Speed log</div><div class="val" data-k="sog">0.0 kn</div></div>
      <div><div class="lbl">Heading</div><div class="val" data-k="hdg">000°</div></div>
      <div class="wide"><div class="lbl">Engine order</div><div class="eng" data-k="eng">STOP</div></div>
      <div class="wide"><div class="lbl">Rudder <span data-k="rudtxt">0° MID</span></div>
        <div class="rud"><b data-k="wheel"></b><i data-k="rud"></i></div></div>
      <div class="wide"><div class="lbl">Weather</div><div class="sea" data-k="sea">—</div></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.f = {};
    el.querySelectorAll('[data-k]').forEach((n) => { this.f[n.dataset.k] = n; });
  }

  // ocean: { info: {bft}, hs }, weather: { label }
  setSea(ocean, weather) {
    const text = `${weather.label} · Bft ${ocean.info.bft} · Hs ${ocean.hs.toFixed(1)} m`;
    if (text !== this.seaText) {
      this.seaText = text;
      this.f.sea.textContent = text;
    }
  }

  update(boat) {
    const f = this.f;
    f.sog.textContent = `${boat.knots.toFixed(1)} kn`;
    f.hdg.textContent = `${String(Math.round(boat.headingDeg) % 360).padStart(3, '0')}°`;
    const rpm = Math.round(Math.abs(boat.rpm) * BOAT.rpmMax);
    f.eng.textContent = `${TELEGRAPH[boat.telegraph].name} · ${rpm} rpm${boat.rpm < -0.02 ? ' astern' : ''}`;
    const r = boat.rudder;
    const side = Math.abs(r) < 0.5 ? 'MID' : r > 0 ? 'PORT' : 'STBD';
    f.rudtxt.textContent = `${Math.abs(r).toFixed(0)}° ${side}`;
    // + rudder (port) drawn to the left
    const pos = (v) => `${50 - (v / BOAT.rudderMax) * 50}%`;
    f.rud.style.left = `calc(${pos(r)} - 2px)`;
    f.wheel.style.left = `calc(${pos(boat.wheel)} - 1px)`;
  }
}
