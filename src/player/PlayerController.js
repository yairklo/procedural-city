// Third-person character controller: walking on uneven terrain, jumping, mantling onto
// ledges and "tallit gliding".
//
// Pure game logic, no three.js: it only talks to CityCollisionWorld and plain {x, y, z}
// objects, so it runs the same in the browser, in a worker, on a server and in node tests.
// Visuals (the proxy capsule now, a rigged character later) read `snapshot()` and listen
// to events; they never touch the physics.
//
// Conventions: meters, seconds, +Y up. Yaw 0 faces north (-Z); positive yaw turns left
// (counter-clockwise seen from above). forward(yaw) = (-sin yaw, 0, -cos yaw).
//
// States:
//   ground  standing / walking / running on a walkable surface
//   slide   on a surface steeper than maxSlopeDeg: slides downhill, little control
//   air     jumping or falling
//   glide   holding jump while airborne: the tallit catches the air
//   mantle  scripted climb onto a ledge (no physics until it finishes)

export const DEFAULT_PLAYER_OPTIONS = Object.freeze({
  radius: 0.4,
  height: 1.8,
  stepHeight: 0.45, // curbs and low ledges are walked onto without jumping
  snapDistance: 0.4, // stay glued to the ground walking downhill / off small steps
  maxSlopeDeg: 45,

  walkSpeed: 4.5,
  runSpeed: 8,
  groundAccel: 32, // m/s² toward the wanted velocity
  groundDecel: 40,
  airAccel: 7,
  turnRate: 12, // rad/s, facing turns toward the movement direction
  uphillPenalty: 0.35, // speed lost on the steepest walkable uphill

  gravity: 25,
  jumpSpeed: 7.2,
  jumpHoldTime: 0.28, // holding jump this long after take-off gives the full height
  jumpHoldGravity: 0.45, // gravity multiplier while jump is held on the way up
  jumpReleaseGravity: 2.2, // gravity multiplier after an early release (short hop)
  coyoteTime: 0.12, // can still jump this long after walking off an edge
  jumpBuffer: 0.12, // a jump pressed this long before landing still fires
  boostSpeed: 42, // debug super-jump (E) to reach rooftops quickly

  mantleReach: 1.5, // a ledge up to this far above the feet can be climbed onto
  mantleTime: 0.35,

  glideGravity: 0.25, // "reduce downward gravitational pull by 75%"
  glideMinSpeed: 7,
  glideMaxSpeed: 38,
  glideDrag: 0.012, // quadratic: sets top dive speed (~30 m/s in a 30° dive)
  glideDiveGain: 0.9, // share of gravity's along-path component turned into speed
  glideAlign: 3, // how fast the flight path follows the tallit's pitch
  glideMaxDive: (50 * Math.PI) / 180,
  glideMaxClimb: (15 * Math.PI) / 180,
  glideCruisePitch: -0.08, // hands-off pitch: a shallow descent that holds ~12 m/s
  glidePitchRate: 2.5,
  glideSteerRate: 1.8, // rad/s with A/D
  glideCameraFollowRate: 1.4, // rad/s the heading turns toward the camera (mouse steering)
  glideMinAirTime: 0.18,

  fixedStep: 1 / 120,
  maxSubsteps: 10,
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (v, target, maxDelta) => (Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta);

/** Input for one frame. All fields optional. */
export const EMPTY_INPUT = Object.freeze({
  moveX: 0, // -1 left .. 1 right (A/D)
  moveY: 0, // -1 back .. 1 forward (S/W)
  cameraYaw: 0, // movement is relative to the camera's yaw
  cameraSteer: false, // the player is actively turning the camera (mouse): glide heading follows it
  jump: false, // held
  sprint: false,
  boost: false, // debug super-jump (edge-triggered by the controller)
});

export class PlayerController {
  /**
   * @param {import('../city/CityCollision.js').CityCollisionWorld} collision
   * @param {{x:number,y:number,z:number, heading?:number}} spawn
   * @param {Partial<typeof DEFAULT_PLAYER_OPTIONS>} [options]
   */
  constructor(collision, spawn, options = {}) {
    this.o = { ...DEFAULT_PLAYER_OPTIONS, ...options };
    this.collision = collision;
    this.position = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.listeners = new Map();
    this._accumulator = 0;
    this.reset(spawn);
  }

  // ------------------------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------------------------

  reset(spawn) {
    this.position.x = spawn.x;
    this.position.y = spawn.y;
    this.position.z = spawn.z;
    this.velocity.x = this.velocity.y = this.velocity.z = 0;
    this.yaw = spawn.heading != null ? spawn.heading + Math.PI : 0; // spawn heading is a road direction (atan2(dx, dz))
    this.state = 'ground';
    this.groundNormal = { x: 0, y: 1, z: 0 };
    this.slopeDeg = 0;
    this.timeInState = 0;
    this.airTime = 0;
    this.lastGroundedTime = 0;
    this.jumpBufferTime = Infinity;
    this.jumpHeldTime = 0;
    this.jumpCut = false;
    this.glide = { speed: 0, pitch: 0, bank: 0 };
    this.mantle = null;
    this.hits = [];
    this._prevJump = false;
    this._prevBoost = false;
    this._clock = 0;
  }

  /** Subscribe to 'jump' | 'land' | 'glideStart' | 'glideEnd' | 'mantleStart' | 'mantleEnd' | 'state'. */
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  /** Advances the simulation by dt seconds (internally in fixed steps). */
  update(dt, input = EMPTY_INPUT) {
    this._accumulator = Math.min(this._accumulator + dt, this.o.fixedStep * this.o.maxSubsteps);
    const hits = new Set();
    while (this._accumulator >= this.o.fixedStep) {
      this._accumulator -= this.o.fixedStep;
      this._step(this.o.fixedStep, input, hits);
    }
    this.hits = [...hits];
  }

  /** Everything a visual representation needs, as plain values. */
  snapshot() {
    const v = this.velocity;
    return {
      position: { ...this.position },
      velocity: { ...v },
      yaw: this.yaw,
      state: this.state,
      speed: Math.hypot(v.x, v.y, v.z),
      horizontalSpeed: Math.hypot(v.x, v.z),
      grounded: this.state === 'ground' || this.state === 'slide',
      slopeDeg: this.slopeDeg,
      glidePitch: this.glide.pitch,
      glideBank: this.glide.bank,
      mantleProgress: this.mantle ? this.mantle.t / this.mantle.duration : 0,
      timeInState: this.timeInState,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Simulation
  // ------------------------------------------------------------------------------------------

  _emit(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) fn(payload);
  }

  _setState(state) {
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    this.timeInState = 0;
    if (prev === 'glide') this._emit('glideEnd', { speed: this.glide.speed });
    if (state === 'glide') this._emit('glideStart', { speed: this.glide.speed });
    this._emit('state', { from: prev, to: state });
  }

  _step(h, input, hits) {
    const o = this.o, p = this.position, v = this.velocity;
    this._clock += h;
    this.timeInState += h;

    // Edge-triggered buttons.
    const jumpPressed = input.jump && !this._prevJump;
    const boostPressed = input.boost && !this._prevBoost;
    this._prevJump = !!input.jump;
    this._prevBoost = !!input.boost;
    if (jumpPressed) this.jumpBufferTime = 0;
    else this.jumpBufferTime += h;

    // Wanted direction on the XZ plane, relative to the camera.
    const yaw = input.cameraYaw ?? 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // forward
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // right
    let wx = fx * (input.moveY ?? 0) + rx * (input.moveX ?? 0);
    let wz = fz * (input.moveY ?? 0) + rz * (input.moveX ?? 0);
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const wishLen = Math.min(1, wl);

    if (this.state === 'mantle') {
      this._stepMantle(h);
      return;
    }

    if (boostPressed) {
      v.y = o.boostSpeed;
      this._setState('air');
    }

    const grounded = this.state === 'ground' || this.state === 'slide';
    if (grounded) this.lastGroundedTime = this._clock;
    else this.airTime += h;

    // --- Jump (buffered, with coyote time) ---
    const canJump = this.state === 'ground' || (this.state === 'air' && this._clock - this.lastGroundedTime <= o.coyoteTime && v.y <= 0);
    if (canJump && this.jumpBufferTime <= o.jumpBuffer) {
      v.y = o.jumpSpeed;
      this.jumpBufferTime = Infinity;
      this.jumpHeldTime = 0;
      this.jumpCut = false;
      this.lastGroundedTime = -Infinity;
      this.airTime = 0;
      this._setState('air');
      this._emit('jump', { position: { ...p } });
    }

    // --- Per-state velocity ---
    if (this.state === 'ground') {
      const speed = (input.sprint ? o.runSpeed : o.walkSpeed) * wishLen;
      let tx = wishLen > 0 ? (wx / wishLen) * speed : 0, tz = wishLen > 0 ? (wz / wishLen) * speed : 0;
      // Walking uphill is slower; downhill is not faster (keeps control predictable).
      const n = this.groundNormal;
      const uphill = -(tx * n.x + tz * n.z) / Math.max(1e-6, Math.hypot(tx, tz));
      if (uphill > 0) {
        const k = 1 - o.uphillPenalty * uphill * Math.sin((this.slopeDeg * Math.PI) / 180) / Math.sin((o.maxSlopeDeg * Math.PI) / 180);
        tx *= k; tz *= k;
      }
      const accel = speed > 0 ? o.groundAccel : o.groundDecel;
      const dvx = tx - v.x, dvz = tz - v.z, dl = Math.hypot(dvx, dvz), max = accel * h;
      if (dl <= max) { v.x = tx; v.z = tz; } else { v.x += (dvx / dl) * max; v.z += (dvz / dl) * max; }
      v.y = 0;
      this._turnToward(wx, wz, wishLen, o.turnRate * h);
    } else if (this.state === 'slide') {
      // Accelerate down the slope; input steers a little.
      const n = this.groundNormal;
      const dl = Math.hypot(n.x, n.z) || 1;
      const g = o.gravity * Math.sin((this.slopeDeg * Math.PI) / 180);
      v.x += ((n.x / dl) * g + wx * o.airAccel * 0.4) * h;
      v.z += ((n.z / dl) * g + wz * o.airAccel * 0.4) * h;
      v.y = 0;
      this._turnToward(v.x, v.z, 1, o.turnRate * 0.5 * h);
    } else if (this.state === 'air') {
      // Variable jump: holding jump on the way up lowers gravity; releasing early cuts the jump.
      let gMul = 1;
      if (v.y > 0) {
        if (input.jump && !this.jumpCut && this.jumpHeldTime < o.jumpHoldTime) gMul = o.jumpHoldGravity;
        else if (!input.jump) { this.jumpCut = true; gMul = o.jumpReleaseGravity; }
      }
      if (input.jump) this.jumpHeldTime += h;
      v.y -= o.gravity * gMul * h;
      // Air control toward the wanted direction (keeps momentum, can't exceed run speed by input alone).
      const target = o.runSpeed * wishLen;
      const hs = Math.hypot(v.x, v.z);
      if (wishLen > 0) {
        const tx = wx / wishLen * Math.max(target, Math.min(hs, o.runSpeed)), tz = wz / wishLen * Math.max(target, Math.min(hs, o.runSpeed));
        v.x = approach(v.x, tx, o.airAccel * h);
        v.z = approach(v.z, tz, o.airAccel * h);
      }
      this._turnToward(wx, wz, wishLen, o.turnRate * 0.5 * h);

      // Tallit: keep holding jump once falling (or press it in mid-air) to glide.
      if (input.jump && v.y < 0 && this.airTime >= o.glideMinAirTime) this._startGlide();
      else if (wishLen > 0.3 && this._tryMantle(wx / wishLen, wz / wishLen)) return;
    } else if (this.state === 'glide') {
      if (!input.jump) {
        this._setState('air');
      } else {
        this._stepGlide(h, input, yaw);
        if (wishLen > 0.3 && input.moveY > 0.3 && this._tryMantle(-Math.sin(this.yaw), -Math.cos(this.yaw))) return;
      }
    }

    // --- Integrate and collide ---
    const before = { x: p.x, y: p.y, z: p.z };
    p.x += v.x * h;
    p.y += v.y * h;
    p.z += v.z * h;
    const res = this.collision.resolveCapsule(p, o.radius, o.height, o.stepHeight);
    for (const b of res.hits) hits.add(b);
    if (res.ceiling && v.y > 0) v.y = 0;
    if (res.collided) {
      // Lose the velocity that went into the wall (keeps sliding along it).
      const ax = (p.x - before.x) / h, az = (p.z - before.z) / h;
      if (Math.hypot(ax, az) < Math.hypot(v.x, v.z) - 1e-6) {
        v.x = ax;
        v.z = az;
        if (this.state === 'glide') {
          this.glide.speed = Math.min(this.glide.speed, Math.hypot(ax, az) / Math.max(1e-3, Math.cos(this.glide.pitch)));
          if (this.glide.speed < 3) this._setState('air'); // slammed into a wall
        }
      }
    }

    // --- Ground ---
    this._resolveGround(h);
  }

  _turnToward(dx, dz, len, maxStep) {
    if (len < 0.1) return;
    const target = Math.atan2(-dx, -dz);
    this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(target - this.yaw), -maxStep, maxStep));
  }

  /**
   * Highest walkable surface under the capsule, within stepHeight above the feet.
   * The terrain is sampled at the center (so slopes don't lift the feet); box tops are also
   * sampled around a ring (a sphere-cast stand-in: standing on a roof edge still works).
   */
  _probeGround() {
    const o = this.o, p = this.position, c = this.collision;
    const maxY = p.y + o.stepHeight;
    let floor = c.groundHeight(p.x, p.z, maxY);
    const terrain = c.terrainHeight(p.x, p.z);
    const r = o.radius * 0.7;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const hBox = c.groundHeight(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, maxY, -Infinity);
      if (hBox > floor) floor = hBox;
    }
    const onTerrain = floor <= terrain + 1e-4;
    const normal = onTerrain ? c.terrainNormal(p.x, p.z) : { x: 0, y: 1, z: 0 };
    return { floor, normal };
  }

  _resolveGround(h) {
    const o = this.o, p = this.position, v = this.velocity;
    if (v.y > 0 && (this.state === 'air' || this.state === 'glide')) return; // rising: nothing to land on
    const { floor, normal } = this._probeGround();
    const grounded = this.state === 'ground' || this.state === 'slide';

    const setGround = () => {
      this.groundNormal = normal;
      this.slopeDeg = (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI;
      const next = this.slopeDeg > o.maxSlopeDeg ? 'slide' : 'ground';
      if (!grounded) {
        const impact = -v.y;
        const wasGliding = this.state === 'glide';
        this._setState(next);
        this.airTime = 0;
        this._emit('land', { impact, fromGlide: wasGliding });
      } else {
        this._setState(next);
      }
      p.y = floor;
      v.y = 0;
    };

    if (p.y <= floor + 1e-4) {
      setGround();
    } else if (grounded && p.y - floor <= o.snapDistance) {
      setGround(); // walking downhill or off a small step: stay on the ground
    } else if (grounded) {
      this.airTime = 0;
      this._setState('air'); // walked off an edge (coyote time still allows a jump)
    }
  }

  // --- Glide ------------------------------------------------------------------------------

  _startGlide() {
    const v = this.velocity;
    const hs = Math.hypot(v.x, v.z);
    this.glide.speed = clamp(Math.hypot(hs, v.y * 0.5), this.o.glideMinSpeed, this.o.glideMaxSpeed);
    this.glide.pitch = -Math.atan2(Math.max(0, -v.y), Math.max(hs, 1)) * 0.5;
    this.glide.bank = 0;
    if (hs > 0.5) this.yaw = Math.atan2(-v.x, -v.z);
    this._setState('glide');
  }

  _stepGlide(h, input, cameraYaw) {
    const o = this.o, g = this.glide, v = this.velocity;
    // Steering: A/D turn; turning the camera with the mouse pulls the heading along.
    let yawRate = -(input.moveX ?? 0) * o.glideSteerRate;
    if (input.cameraSteer) yawRate += clamp(wrapAngle(cameraYaw - this.yaw) * 3, -o.glideCameraFollowRate, o.glideCameraFollowRate);
    this.yaw = wrapAngle(this.yaw + yawRate * h);
    g.bank = damp(g.bank, clamp(yawRate / o.glideSteerRate, -1, 1) * 0.6, 4, h);

    // Pitch: W dives, S pulls up.
    const my = input.moveY ?? 0;
    const target = my > 0 ? -o.glideMaxDive * my : my < 0 ? o.glideMaxClimb * -my : o.glideCruisePitch;
    g.pitch = approach(g.pitch, target, o.glidePitchRate * h);

    // Speed: diving converts altitude into speed, climbing the reverse; quadratic drag.
    g.speed += (-o.gravity * Math.sin(g.pitch) * o.glideDiveGain - o.glideDrag * g.speed * g.speed) * h;
    g.speed = clamp(g.speed, o.glideMinSpeed, o.glideMaxSpeed);

    // Vertical: the flight path follows the pitch, plus gravity reduced by 75%.
    v.y = damp(v.y, g.speed * Math.sin(g.pitch), o.glideAlign, h) - o.gravity * o.glideGravity * h;
    const hs = g.speed * Math.cos(g.pitch);
    v.x = -Math.sin(this.yaw) * hs;
    v.z = -Math.cos(this.yaw) * hs;
  }

  // --- Mantle -----------------------------------------------------------------------------

  /**
   * Looks for a ledge in direction (dx, dz): a wall at chest height right in front, whose top
   * is within mantleReach above the feet, with room to stand on top. Starts a mantle if found.
   */
  _tryMantle(dx, dz) {
    const o = this.o, p = this.position, c = this.collision;
    const probe = o.radius + 0.25;
    const fx = p.x + dx * probe, fz = p.z + dz * probe;
    const wall = c.queryAABB(fx - 0.1, p.y + 0.5, fz - 0.1, fx + 0.1, p.y + 1.2, fz + 0.1).filter((b) => b.kind !== 'tree');
    if (!wall.length) return false;
    for (const d of [o.radius + 0.4, o.radius + 0.7, o.radius + 1.0]) {
      const lx = p.x + dx * d, lz = p.z + dz * d;
      const top = c.groundHeight(lx, lz, p.y + o.mantleReach, -Infinity);
      const rise = top - p.y;
      if (!(rise >= o.stepHeight && rise <= o.mantleReach)) continue;
      const r = o.radius * 0.9;
      if (c.queryAABB(lx - r, top + 0.05, lz - r, lx + r, top + o.height, lz + r).length) continue; // no room on top
      this.mantle = {
        from: { ...p },
        to: { x: lx, y: top, z: lz },
        t: 0,
        duration: o.mantleTime * (0.7 + 0.3 * (rise / o.mantleReach)),
      };
      this.velocity.x = this.velocity.y = this.velocity.z = 0;
      this.yaw = Math.atan2(-dx, -dz);
      this._setState('mantle');
      this._emit('mantleStart', { top, rise });
      return true;
    }
    return false;
  }

  _stepMantle(h) {
    const m = this.mantle, p = this.position;
    m.t = Math.min(m.duration, m.t + h);
    const u = m.t / m.duration;
    // Up first (ease-out), then over the edge.
    const up = 1 - (1 - Math.min(1, u / 0.6)) ** 2;
    const over = u < 0.35 ? 0 : ((u - 0.35) / 0.65) ** 1.5;
    p.x = m.from.x + (m.to.x - m.from.x) * over;
    p.z = m.from.z + (m.to.z - m.from.z) * over;
    p.y = m.from.y + (m.to.y + 0.02 - m.from.y) * up;
    if (u >= 1) {
      p.x = m.to.x; p.y = m.to.y; p.z = m.to.z;
      this.mantle = null;
      this.groundNormal = { x: 0, y: 1, z: 0 };
      this.slopeDeg = 0;
      this._setState('ground');
      this._emit('mantleEnd', { position: { ...p } });
    }
  }
}
