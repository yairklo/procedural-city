// Benchmark overlay (top-right): frame rate, frame time, renderer load and what the
// simulation is currently running, plus the controls legend. Updated four times a second so
// the DOM work stays off the frame budget; the frame time shows the average and the worst
// frame of that window, which is what hitches look like.

export class BenchmarkHUD {
  /** @param {HTMLElement} parent */
  constructor(parent = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'bench-hud';
    parent.appendChild(this.el);
    this.visible = true;
    this._frames = 0;
    this._time = 0;
    this._worst = 0;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  /**
   * @param {number} dt  real frame time, seconds (unclamped)
   * @param {() => {calls:number, triangles:number, buildings:number, vehicles:number,
   *   pedestrians:number, trams:number, extra?:string}} read  sampled only when the overlay refreshes
   */
  update(dt, read) {
    this._frames++;
    this._time += dt;
    this._worst = Math.max(this._worst, dt);
    if (this._time < 0.25) return;
    const fps = this._frames / this._time;
    const avg = (this._time / this._frames) * 1000;
    const worst = this._worst * 1000;
    this._frames = 0;
    this._time = 0;
    this._worst = 0;
    if (!this.visible) return;
    const s = read();
    const tone = (v, good, ok) => (v <= good ? 'good' : v <= ok ? 'ok' : 'bad');
    const row = (label, value, cls = '') => `<div class="row"><span>${label}</span><b class="${cls}">${value}</b></div>`;
    this.el.innerHTML =
      row('FPS', fps.toFixed(0), tone(-fps, -55, -30)) +
      row('Frame', `${avg.toFixed(1)} ms <small>max ${worst.toFixed(0)}</small>`, tone(avg, 18, 33)) +
      row('Draw calls', s.calls, tone(s.calls, 350, 500)) +
      row('Triangles', `${(s.triangles / 1e6).toFixed(2)} M`) +
      '<hr>' +
      row('Buildings', s.buildings.toLocaleString()) +
      row('Vehicles', s.vehicles + (s.trams ? ` <small>+ tram</small>` : '')) +
      row('Pedestrians', s.pedestrians) +
      (s.extra ? `<div class="extra">${s.extra}</div>` : '') +
      '<hr><div class="legend">' +
      '<span><kbd>WASD</kbd> Move</span><span><kbd>Space</kbd> Jump / Glide</span>' +
      '<span><kbd>N</kbd> Toggle Night</span><span><kbd>C</kbd> Free Cam</span>' +
      '<span><kbd>M</kbd> Mute</span><span><kbd>B</kbd> Hide</span></div>';
  }

  dispose() {
    this.el.remove();
  }
}
