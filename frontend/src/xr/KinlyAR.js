// Kinly AR mode for HoloLens 2 (Edge, WebXR): tags hang in the room next to people and objects instead of on the
// 2D page. The headset browser gives WebXR no camera image, so the page keeps its ordinary camera stream
// (react-webcam's <video>), sends frames itself with a counter `seq`, remembers the head pose of every frame, and
// places a tag on the ray through the face or object: direction from its place in the frame, distance from its width.
// The backend echoes `seq` in FACES and OBJECTS, so the pose of the right frame is used although recognition lags.
// Session set-up is the one that starts on this headset (checked with /probe/ on 30.10.2026): WebGL 1, immersive-vr
// (the display is additive, so it is AR), 'local' space, no hand tracking; hands still arrive as tracked-pointer
// rays and air taps (pinches) as 'select' events.
//
// Screens follow the owner's design v4 "Care AR" (RemindMe — glasses interface): face tag beside the head, edge arrow
// to a person out of view, idle HUD, walking mode, menu summoned by a pinch, object highlight with a card at the
// object, two-step confirm, "Saved" that waits for a pause in talk, the memory board. Owner's own changes kept over
// the design: an unknown person's tag appears after a 3 s gaze (the design says "no dwell").

const Q = new URLSearchParams(window.location.search);
const HFOV_DEG = parseFloat(Q.get('hfov') || '64.7'); // horizontal field of view of the headset's photo camera
const FACE_W = parseFloat(Q.get('facew') || '0.15'); // real face width in metres: the distance comes from it
const OBJECT_W = parseFloat(Q.get('objw') || '0.12'); // assumed width of a held object, metres
const FRAME_MS = 300; // same pace as the 2D app
const KNOWN_TTL_MS = 2500;
const UNKNOWN_TTL_MS = 3000;
// Owner, 30.10.2026: an unknown person's tag appears only after the camera has held one face for 3 s
// (several "Unknown person" tags at once were noise). Known people are tagged at once.
const DWELL_MS = 3000;
const DWELL_GAP_MS = 1000; // a frame where recognition missed the face does not restart the count
const DWELL_ZONE = { x1: 0.3, x2: 0.7, y1: 0.15, y2: 0.85 }; // "looking at" = face centre in this part of the frame
const SAME_PERSON_M = 0.5; // unknown faces get a new track id often; nearby positions are the same person
const RECORD_MAX_MS = 6000;
const UNKNOWN = 'Unknown Person';
// Owner, 30.10.2026: tags hung too high above the head; they sit next to the face instead — at face height, to the
// right of the face as the wearer sees it. A white line with a mint dot joins the tag to the face (design v4).
const FACE_EDGE = 0.075; // half a face: where the dot sits, metres right of the face centre
const CONNECT = 0.04; // length of the line from the dot to the tag
// Owner, 31.10.2026: the date and time stick to the top edge of the view and the menu, always on, to the bottom edge;
// both follow the head. HoloLens 2 shows about 29° vertically: tune with ?hudup=…&menudown=… (degrees from the middle).
const HUD_DIST = 1.8, HUD_UP_DEG = parseFloat(Q.get('hudup') || '10'), HUD_SCALE = 1.3;
const MENU_DIST = 1.5, MENU_DOWN_DEG = parseFloat(Q.get('menudown') || '10'), MENU_SCALE = 0.75;
const FOLLOW_S = 0.12; // smoothing of the follow: takes out head tremor, still feels attached
// Places in front of the wearer, metres
const BOARD_DIST = 1.9, FRONT_DIST = 1.3;
// Owner, 31.10.2026: people are recognised up to 2 m (the distance comes from the face width); the tag shows the name
// only, a pinch on it adds the relation, the last topic and Forget
const PERSON_MAX_M = parseFloat(Q.get('maxdist') || '2');
const FORGET_MUTE_MS = 5000; // after Forget, the backend's vote still names the person for a few frames
// Walking (design: everything hides except the time): head speed over the floor
const WALK_START_MS = 1500, WALK_START_SPEED = 0.5, WALK_STOP_MS = 2000, WALK_STOP_SPEED = 0.25;
// "What's here?": wait for an object in the middle, then take three photos while it is turned
const TARGET_WAIT_MS = 7000, SHOTS = 3, SHOT_GAP_MS = 1300;
// Updates wait for a pause in conversation (design v4): microphone level and how long it must stay quiet
const SPEECH_RMS = 0.035, QUIET_MS = 1500, TOAST_MS = 4500;

// Look: dark-green glass, solid white text, mint accents, Atkinson Hyperlegible. On HoloLens dark is see-through,
// so the glass all but vanishes and the text stays.
const V4 = {
  glass: 'rgba(16,34,26,0.76)', glassStrong: 'rgba(16,34,26,0.86)', edge: 'rgba(255,255,255,0.18)',
  text: '#F4FFF6', mint: '#B8F2A0', ink: '#0E2216', ghost: 'rgba(255,255,255,0.14)', sand: '#F2D9A6',
};
const FONT = '"Atkinson Hyperlegible", system-ui, "Segoe UI", sans-serif';
const DPX = 0.0008; // metres per design pixel: the 130 px face tag is 10 cm tall
const ICON = { // 24-unit paths, drawn as strokes
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18 M6 6l12 12',
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3',
  plus: 'M12 5v14 M5 12h14',
  exit: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  topic: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  scan: 'M3 7V5a2 2 0 0 1 2-2h2 M17 3h2a2 2 0 0 1 2 2v2 M21 17v2a2 2 0 0 1-2 2h-2 M7 21H5a2 2 0 0 1-2-2v-2 M6.5 12s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4z',
  memory: 'M4 5a8 3 0 1 0 16 0a8 3 0 1 0-16 0 M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5 M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 4l13 8-13 8z',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8 M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  walk: 'M13 2a2 2 0 1 0 0 4a2 2 0 1 0 0-4 M7 21l3-6 3 2v4 M10 15l1-6 4 3 3 1 M11 9l-3 2-1 3',
  trash: 'M3 6h18 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6',
  camera: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z M12 10a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  person: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8',
  pill: 'M10.5 20.5 3.5 13.5a4.95 4.95 0 1 1 7-7l7 7a4.95 4.95 0 1 1-7 7z M8.5 8.5l7 7',
  box: 'M21 8 12 3 3 8v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  pin: 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
  speaker: 'M11 5 6 9H2v6h4l5 4V5z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14',
};
const measure = document.createElement('canvas').getContext('2d');
function textWidth(s, weight, size) {
  measure.font = `${weight} ${size}px ${FONT}`;
  return Math.ceil(measure.measureText(s).width);
}
function text(x, s, X, Y, weight, size, color, align = 'left') { // Y is the middle of the line
  x.font = `${weight} ${size}px ${FONT}`;
  x.fillStyle = color;
  x.textAlign = align;
  x.textBaseline = 'middle';
  x.fillText(s, X, Y);
}
function rr(x, X, Y, W, H, R) {
  x.beginPath();
  if (x.roundRect) x.roundRect(X, Y, W, H, R); else x.rect(X, Y, W, H);
}
function glass(x, X, Y, W, H, R, fill, edge, edgeWidth = 1.5) {
  rr(x, X, Y, W, H, R);
  x.fillStyle = fill; x.fill();
  x.lineWidth = edgeWidth; x.strokeStyle = edge; x.stroke();
}
function icon(x, d, X, Y, size, color, width) {
  x.save();
  x.translate(X, Y);
  x.scale(size / 24, size / 24);
  x.strokeStyle = color; x.lineWidth = (width * 24) / size; x.lineCap = 'round'; x.lineJoin = 'round';
  x.stroke(new Path2D(d));
  x.restore();
}
function wrap(s, weight, size, maxW) {
  const lines = [];
  let line = '';
  for (const word of String(s).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, weight, size) > maxW) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Load the design's font early: canvas text uses only fonts that are already loaded
if (document.fonts) document.fonts.load(`700 40px ${FONT}`).catch(() => {});

export function arSupported() {
  if (!navigator.xr) return Promise.resolve(false);
  return navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
}

// ---------- small vector and matrix helpers (column-major, as WebXR gives them) ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const apply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
function model(pos, yaw, w, h) { // translate * rotateY(yaw) * scale(w, h): a quad facing +Z after rotation
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([c * w, 0, -s * w, 0, 0, h, 0, 0, s, 0, c, 0, pos[0], pos[1], pos[2], 1]);
}
const yawTo = (from, eye) => Math.atan2(eye[0] - from[0], eye[2] - from[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function beam(a, b, eye, width) { // a thin quad from a to b, turned around its axis to face the eye
  const axis = sub(b, a), len = Math.hypot(axis[0], axis[1], axis[2]) || 1e-6;
  const u = axis.map((v) => v / len), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const s = unit(cross(u, sub(eye, c))), n = cross(s, u);
  return new Float32Array([s[0] * width, s[1] * width, s[2] * width, 0, u[0] * len, u[1] * len, u[2] * len, 0,
    n[0], n[1], n[2], 0, c[0], c[1], c[2], 1]);
}
const rayOf = (m) => ({ o: [m[12], m[13], m[14]], d: [-m[8], -m[9], -m[10]] });
// A point straight ahead of the gaze (level), `d` metres away and `up` metres above the eye
function ahead(head, eye, d, up) {
  const g = unit([-head[8], 0, -head[10]]);
  return [eye[0] + g[0] * d, eye[1] + up, eye[2] + g[2] * d];
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class KinlyAR {
  constructor({ video, send, apiBase, onEnd }) {
    this.video = video; // the <video> the 2D app already shows (react-webcam)
    this.send = send; // sends a message over the app's WebSocket
    this.apiBase = apiBase;
    this.onEnd = onEnd;
    this.session = null;
    this.textures = new Map();
    // Textures painted before the design font arrived used a fallback: repaint them once it is loaded
    if (document.fonts) {
      document.fonts.addEventListener('loadingdone', () => {
        if (!this.gl) return;
        for (const t of this.textures.values()) this.gl.deleteTexture(t);
        this.textures.clear();
      });
    }
    this.grab = document.createElement('canvas');
    this.grab.width = 960;
    this.grab.height = 540;
    this.grabCtx = this.grab.getContext('2d');
  }

  get active() {
    return !!this.session;
  }

  async start() {
    if (this.session) return;
    if (!this.gl) this._initGL();
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local'] });
    this.session = session;
    this._reset();
    // State goes to the backend log every 3 s as a [Probe] line (app "kinly-ar"): what the headset did, without asking
    this.reportTimer = setInterval(() => this._report(), 3000);
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, this.gl) });
    try {
      this.space = await session.requestReferenceSpace('local');
    } catch {
      this.space = await session.requestReferenceSpace('viewer');
    }
    session.addEventListener('select', (e) => this._onSelect(e));
    session.addEventListener('end', () => this._onEnded());
    session.requestAnimationFrame((t, f) => this._onFrame(t, f));
    // The page asked for the microphone at start, so no prompt is needed inside the headset
    this.micError = '';
    if (!this.mic) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((s) => { this.mic = s; this._listenLevel(); })
        .catch((e) => { this.micError = e.name; });
    } else {
      this._listenLevel();
    }
  }

  _reset() {
    this.seq = 0;
    this.lastCapture = 0;
    this.poses = new Map(); // seq -> head matrix when that frame was taken
    this.frames = new Map(); // seq -> JPEG (base64) of that frame, for saving a face or an object
    this.known = new Map(); // name -> tag of a known person in view
    this.expanded = null; // name of the person whose tag was pinched open
    this.forgotten = new Map(); // name -> until when to ignore them after Forget
    this.unknown = null; // the one unknown person shown after a dwell
    this.dwell = null;
    this.objects = []; // saved objects recognised in view: [{pos, size, ...}]
    this.target = null; // the object in the middle during "What's here?"
    this.flow = null; // the open card: adding a person, an object, Speak, a notice
    this.board = null;
    this.hud = null; // {pos, yaw} at the top edge of the view
    this.menuAt = null; // {pos, yaw} at the bottom edge
    this.lastFollow = 0;
    this.toast = null;
    this.toasts = []; // updates waiting for a pause in talk
    this.walking = false;
    this.walkSince = 0;
    this.track = []; // recent head positions for walking: [t, x, z]
    this.paused = false;
    this.lastSpeech = 0;
    this.buttons = [];
    this.hovered = new Set();
    this.stats = { inputs: '', selects: 0, hits: 0, lastAction: '', error: '' };
  }

  end() {
    if (this.session) this.session.end().catch(() => {});
  }

  _report() {
    const f = this.flow, s = this.stats;
    this.send({
      type: 'PROBE',
      data: {
        app: 'kinly-ar', mic: this.mic ? 'ok' : this.micError || 'pending', inputs: s.inputs, selects: s.selects,
        hits: s.hits, lastAction: s.lastAction,
        flow: f ? `${f.kind}:${f.state}` : '',
        card: f && f.view ? [f.view.kicker, f.view.big, f.view.name, f.view.title, f.view.status, f.view.body, f.view.hint].filter(Boolean).join(' / ').slice(0, 160) : '',
        expanded: this.expanded || '', board: !!this.board, walking: this.walking, paused: this.paused,
        toastsWaiting: this.toasts.length, talking: this._talking(),
        known: [...this.known.keys()], objects: this.objects.map((o) => o.name), target: this.target ? this.target.name : '',
        unknownTag: !!this.unknown, dwellMs: this.dwell ? Math.round(this.dwell.lastSeen - this.dwell.since) : 0,
        frames: this.seq, error: s.error,
      },
    });
  }

  // ---------- messages from the backend ----------
  onFaces(msg) {
    if (!this.session || this.paused) return;
    const head = this.poses.get(msg.seq);
    if (!head) return; // a frame sent by the 2D page, or from before the session
    const now = performance.now();
    let candidate = null;
    let best = Infinity;
    for (const f of msg.faces || []) {
      const p = this._project(f, head, FACE_W);
      if (p.dist > PERSON_MAX_M) continue; // someone far off, caught by chance: no tag
      const box = { x: f.x, y: f.y, w: f.w, h: f.h };
      if (f.name !== UNKNOWN) {
        if (now < (this.forgotten.get(f.name) || 0)) continue;
        const old = this.known.get(f.name);
        const topic = (f.topics && f.topics.length ? f.topics[f.topics.length - 1] : '') || '';
        const tag = {
          pos: old ? lerp3(old.pos, p.pos, 0.5) : p.pos, dist: p.dist, seen: now,
          name: f.name, relation: f.relation || '', topic,
        };
        this.known.set(f.name, tag);
        continue;
      }
      // The unknown person already shown: follow them and keep the newest frame of them for saving
      const u = this.unknown;
      if (u && ((f.track_id != null && f.track_id === u.track) || dist(p.pos, u.pos) < SAME_PERSON_M)) {
        Object.assign(u, { pos: lerp3(u.pos, p.pos, 0.5), dist: p.dist, box, seq: msg.seq, track: f.track_id, seen: now });
      }
      const cx = (f.x + f.w / 2) / 100, cy = (f.y + f.h / 2) / 100;
      if (cx >= DWELL_ZONE.x1 && cx <= DWELL_ZONE.x2 && cy >= DWELL_ZONE.y1 && cy <= DWELL_ZONE.y2) {
        const d = Math.hypot(cx - 0.5, cy - 0.5);
        if (d < best) { best = d; candidate = { f, p, box }; }
      }
    }
    if (!candidate) return;
    const { f, p, box } = candidate;
    const dw = this.dwell;
    const same = dw && now - dw.lastSeen < DWELL_GAP_MS &&
      ((f.track_id != null && f.track_id === dw.track) || dist(p.pos, dw.pos) < SAME_PERSON_M);
    this.dwell = same ? { ...dw, lastSeen: now, pos: p.pos, track: f.track_id }
      : { since: now, lastSeen: now, pos: p.pos, track: f.track_id };
    const shownAlready = this.unknown && dist(p.pos, this.unknown.pos) < SAME_PERSON_M;
    if (now - this.dwell.since >= DWELL_MS && !shownAlready && !this.flow) {
      this.unknown = { pos: p.pos, dist: p.dist, box, seq: msg.seq, track: f.track_id, seen: now };
    }
  }

  // Everything else the backend says over the socket (App forwards it while AR runs)
  onMessage(msg) {
    if (!this.session) return;
    if (msg.type === 'OBJECTS') this._onObjects(msg);
    else if (msg.type === 'CHAT') this._onChat(msg);
    else if (msg.type === 'OBJECT_CONFIRM') this._onObjectConfirm(msg);
  }

  _onObjects(msg) {
    const head = this.poses.get(msg.seq);
    const list = msg.objects || [];
    const targeted = list.find((o) => o.targeted);
    const now = performance.now();
    if (targeted) { // "What's here?" asked the backend for the object in the middle
      if (!head || !this.flow || this.flow.kind !== 'object') return;
      const p = this._project(targeted, head, OBJECT_W);
      this.target = { ...p, name: targeted.name, box: { x: targeted.x, y: targeted.y, w: targeted.w, h: targeted.h }, seq: msg.seq, seen: now };
      if (this.flow.state === 'searching') this._objectFound();
      else if (this.flow.state === 'found') this.flow.anchor = this._objectAnchor(this.target);
      return;
    }
    if (this.flow && this.flow.kind === 'object') return; // the backend is busy with the object in the middle
    if (!head) { if (!list.length) this.objects = []; return; }
    // Saved objects in view (design: auto-highlight, card at the object)
    this.objects = list.map((o) => {
      const p = this._project(o, head, OBJECT_W);
      const sub = o.dosage || o.notes || o.label || '';
      return { ...p, name: o.name, sub, medicine: o.category === 'medicine' || !!o.dosage, box: { x: o.x, y: o.y, w: o.w, h: o.h } };
    });
  }

  _onChat(msg) {
    const f = this.flow;
    if (f && f.kind === 'speak' && f.state === 'thinking') {
      if (msg.role === 'user') f.heard = msg.content;
      else if (msg.role === 'assistant') {
        f.state = 'answer';
        f.view = {
          kicker: f.heard ? `You said: “${f.heard}”` : '', body: msg.content, hint: 'Said aloud', actions: ['ok'],
        };
        f.closeAt = performance.now() + 15000;
        this.send({ type: 'COMMAND', command: 'END_COMMAND' });
      }
      return;
    }
    // A topic saved after a conversation is an update: shown when the talk pauses
    const m = /^Topic saved for (.+?): (.+)$/.exec(msg.content || '');
    if (msg.role === 'system' && m) this._queueToast(`Topic saved — ${m[1]}`, m[2]);
  }

  // Speak with "remember this object": the backend found it and waits for confirmation — continue as "What's here?"
  _onObjectConfirm(msg) {
    if (!this.flow || this.flow.kind !== 'speak') return;
    const box = msg.object_box || null;
    this.flow = { kind: 'object', state: 'found', token: 0, anchor: this._frontAnchor(), name: msg.detector_class || 'object', notes: msg.note_text || '', suggested: msg.suggested_name || '' };
    this.target = box ? { name: msg.detector_class || 'object', box, seq: null, seen: performance.now() } : null;
    this._viewFound();
  }

  _project(o, head, realWidth) { // o: box in % of the frame -> world centre, distance and world size
    const tanH = Math.tan((HFOV_DEG * Math.PI) / 360), tanV = (tanH * 9) / 16;
    const cx = (o.x + o.w / 2) / 100, cy = (o.y + o.h / 2) / 100, wf = Math.max(o.w / 100, 0.01);
    const d = Math.min(6, Math.max(0.3, realWidth / (wf * 2 * tanH)));
    let dx = (cx * 2 - 1) * tanH, dy = -(cy * 2 - 1) * tanV, dz = -1;
    const n = Math.hypot(dx, dy, dz);
    dx *= d / n; dy *= d / n; dz *= d / n;
    return { pos: apply(head, dx, dy, dz), dist: d, size: [wf * 2 * tanH * d, (o.h / 100) * 2 * tanV * d] };
  }

  // ---------- frames ----------
  _capture(head) {
    const v = this.video;
    if (!v || !v.videoWidth) return;
    this.grabCtx.drawImage(v, 0, 0, this.grab.width, this.grab.height);
    const data = this.grab.toDataURL('image/jpeg', 0.8).split(',')[1];
    this.seq += 1;
    this.poses.set(this.seq, Float32Array.from(head));
    this.frames.set(this.seq, data);
    while (this.poses.size > 40) this.poses.delete(this.poses.keys().next().value);
    while (this.frames.size > 40) this.frames.delete(this.frames.keys().next().value);
    this.send({ type: 'FRAME', data, seq: this.seq });
  }

  // ---------- microphone: recording and the level for "is the wearer talking" ----------
  _listenLevel() {
    if (this.levelReady || !this.mic) return;
    try {
      this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaStreamSource(this.mic);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.levelBuf = new Float32Array(this.analyser.fftSize);
      this.levelReady = true;
    } catch (e) {
      this.stats.error = `level: ${e.name}`;
    }
  }

  _talking() {
    return performance.now() - this.lastSpeech < QUIET_MS;
  }

  _record(onDone) {
    if (!this.mic) return { error: this.micError || 'The microphone is not allowed' };
    const chunks = [];
    let rec;
    try {
      rec = new MediaRecorder(this.mic, { mimeType: 'audio/webm' });
    } catch (e) {
      this.stats.error = `recorder: ${e.name} ${e.message}`.slice(0, 200);
      return { error: `Recording did not start (${e.name})` };
    }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      clearTimeout(this.recTimer);
      onDone(await blobToBase64(new Blob(chunks, { type: 'audio/webm' })));
    };
    this.recorder = rec;
    rec.start();
    this.recTimer = setTimeout(() => this._stopRecording(), RECORD_MAX_MS);
    return {};
  }

  _stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  // ---------- toasts: "Saved" waits for a pause in talk, then a soft chime ----------
  _queueToast(title, detail) {
    this.toasts.push({ title, detail });
  }

  _chime() {
    try {
      const ctx = this.audioCtx || (this.audioCtx = new (window.AudioContext || window.webkitAudioContext)());
      const t = ctx.currentTime;
      [880, 1318.5].forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.5);
        o.connect(g).connect(ctx.destination);
        o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.55);
      });
    } catch { /* no sound is fine */ }
  }

  // ---------- flows: each opens one card ----------
  _frontAnchor(d = FRONT_DIST, up = 0.02) { // a little high: the menu holds the bottom of the view
    const head = this.head, eye = this.eye || [0, 1.6, 0];
    const pos = head ? ahead(head, eye, d, up) : [eye[0], eye[1] + up, eye[2] - d];
    return { kind: 'front', pos, yaw: yawTo(pos, eye), scale: 1 };
  }

  _faceAnchor(u) {
    const eye = this.eye || [0, 1.6, 0];
    return { kind: 'face', pos: u.pos.slice(), yaw: yawTo(u.pos, eye), scale: Math.max(1, u.dist / 1.5) };
  }

  _objectAnchor(t) { // held objects are close: their cards shrink with distance (faces only grow when far)
    const eye = this.eye || [0, 1.6, 0];
    return { kind: 'object', pos: t.pos.slice(), yaw: yawTo(t.pos, eye), scale: Math.min(3, Math.max(0.5, t.dist / 1.5)), size: t.size };
  }

  _close(endCommand) {
    const f = this.flow;
    if (f) f.token += 1;
    this._stopRecording();
    if (endCommand || (f && f.kind === 'object')) this.send({ type: 'COMMAND', command: 'END_COMMAND' });
    this.flow = null;
    this.target = null;
  }

  // Adding a person by voice (the AR mode has no keyboard)
  _addPerson() {
    const u = this.unknown;
    if (!u) return;
    this.flow = { kind: 'person', state: 'listening', token: 0, anchor: this._faceAnchor(u), box: { ...u.box }, frame: this.frames.get(u.seq) };
    if (!this.flow.frame) return this._view({ title: 'The picture of this person is gone', hint: 'Look at them again', actions: ['close'] }, 'error');
    this._personListen();
  }

  _personListen() {
    const f = this.flow;
    const token = ++f.token;
    const r = this._record(async (audio) => {
      if (this.flow !== f || f.token !== token) return;
      this._view({ step: 1, title: 'One moment…', actions: ['cancel'] }, 'thinking');
      const data = await this._post('/api/faces/introduce', { audio_b64: audio, mime: 'audio/webm' });
      if (this.flow !== f || f.token !== token) return;
      if (!data.success) return this._view({ title: 'Could not understand', hint: String(data.error || '').slice(0, 80), actions: ['retry', 'cancel'] }, 'error');
      if (!data.name) return this._view({ title: 'I did not catch a name', hint: data.transcript ? `Heard: “${data.transcript}”` : 'Nothing was heard', actions: ['retry', 'cancel'] }, 'error');
      f.name = data.name;
      f.relation = data.relation || '';
      this._view({ step: 2, name: f.name, sub: f.relation || 'Relation not said', title: 'Is that right?', hint: 'To change it, tap Change it and say it again', actions: ['save', 'retry', 'cancel'] }, 'confirm');
    });
    if (r.error) return this._view({ title: r.error, hint: 'Exit AR and turn the mic on', actions: ['close'] }, 'error');
    this._view({ step: 1, title: 'Say the name and who this is', status: 'Listening…', hint: 'For example: “Niaz, developer”', actions: ['done', 'cancel'] }, 'listening');
  }

  async _personSave() {
    const f = this.flow;
    const token = ++f.token;
    this._view({ step: 2, title: `Saving ${f.name}…`, actions: [] }, 'saving');
    const data = await this._post('/api/faces', { name: f.name, relation: f.relation, frame_b64: f.frame, face_box: f.box });
    if (this.flow !== f || f.token !== token) return;
    if (!data.success) return this._view({ title: 'Could not save', hint: String(data.error || '').slice(0, 80), actions: ['save', 'cancel'] }, 'error');
    this.unknown = null;
    this.dwell = null;
    this._close();
    this._queueToast('Saved', f.relation ? `${f.name} — ${f.relation}` : f.name);
  }

  // "What's here?": the backend looks for the object in the middle of the view (its command mode)
  _whatsHere() {
    this.flow = { kind: 'object', state: 'searching', token: 0, anchor: this._frontAnchor(), since: performance.now() };
    this.target = null;
    this.send({ type: 'COMMAND', command: 'ACTIVATE_COMMAND' });
    this._view({ title: 'Looking…', hint: 'Hold the object in the middle of your view', actions: ['close'] }, 'searching');
  }

  _objectFound() {
    const f = this.flow;
    f.state = 'found';
    f.name = this.target.name;
    f.anchor = this._objectAnchor(this.target);
    this._viewFound();
  }

  _viewFound() {
    this._view({ kicker: 'This looks like a', big: cap(this.flow.suggested || this.flow.name), actions: ['obj-save', 'obj-later'] }, 'found');
  }

  async _objectCapture() {
    const f = this.flow;
    const token = ++f.token;
    const frames = [], boxes = [];
    for (let i = 0; i < SHOTS; i++) {
      if (this.flow !== f || f.token !== token) return;
      f.photo = i === 0 ? 'Photo taken' : `Photo ${i + 1} of ${SHOTS}`;
      this._view({ kicker: 'Taking photos', big: cap(f.suggested || f.name), hint: i < SHOTS - 1 ? 'Turn it a little between photos' : 'Hold still', actions: ['cancel'] }, 'capturing');
      const seq = this.target && this.target.seq && this.frames.has(this.target.seq) ? this.target.seq : this.seq;
      frames.push(this.frames.get(seq) || this.frames.get(this.seq));
      boxes.push(this.target ? { ...this.target.box } : null);
      if (i < SHOTS - 1) await wait(SHOT_GAP_MS);
    }
    f.photo = '';
    this._view({ title: 'Reading the label…', actions: ['cancel'] }, 'preparing');
    const data = await this._post('/api/objects/prepare', { frames: frames.filter(Boolean), hint_box: boxes[0], hint_boxes: boxes });
    if (this.flow !== f || f.token !== token) return;
    if (!data.success) return this._view({ title: 'Could not see the object', hint: String(data.error || 'Hold it closer and try again').slice(0, 80), actions: ['close'] }, 'error');
    const label = data.label || {};
    f.shots = data.shots;
    f.label = label;
    f.medicine = !!label.dosage;
    f.objName = f.suggested || label.product_name || cap(f.name);
    f.dosage = label.dosage || '';
    f.notes = f.notes || '';
    this._view({ step: 1, title: f.medicine ? 'Is this your medicine?' : `Is this your ${f.name}?`, hint: 'Tap No to stop', actions: ['yes', 'no'] }, 'step1');
  }

  _objectStep2() {
    const f = this.flow;
    const sub = [f.dosage, f.notes].filter(Boolean).join(' · ') || (f.medicine ? 'No dosage read' : '');
    this._view({ step: 2, name: f.objName, sub, title: 'Is that right?', hint: 'To change it, tap Change it and say it', actions: ['save', 'retry', 'cancel'] }, 'step2');
  }

  _objectListen() {
    const f = this.flow;
    const token = ++f.token;
    const r = this._record(async (audio) => {
      if (this.flow !== f || f.token !== token) return;
      this._view({ step: 2, title: 'One moment…', actions: ['cancel'] }, 'thinking');
      const data = await this._post('/api/objects/introduce', { audio_b64: audio, mime: 'audio/webm' });
      if (this.flow !== f || f.token !== token) return;
      if (!data.success || !data.name) {
        return this._view({ title: 'I did not catch the name', hint: data.transcript ? `Heard: “${data.transcript}”` : 'Nothing was heard', actions: ['retry', 'cancel'] }, 'error');
      }
      f.objName = data.name;
      f.dosage = data.dosage || f.dosage;
      f.notes = data.notes || '';
      this._objectStep2();
    });
    if (r.error) return this._view({ title: r.error, hint: 'Exit AR and turn the mic on', actions: ['close'] }, 'error');
    this._view({ step: 2, title: 'Say its name and how to use it', status: 'Listening…', hint: 'For example: “Amoxiclav, 3 times a day”', actions: ['done', 'cancel'] }, 'listening');
  }

  async _objectSave() {
    const f = this.flow;
    const token = ++f.token;
    this._view({ step: 2, title: `Saving ${f.objName}…`, actions: [] }, 'saving');
    const label = f.label || {};
    const data = await this._post('/api/objects', {
      name: f.objName, notes: f.notes, dosage: f.dosage, schedule: '', category: f.medicine ? 'medicine' : '',
      detector_class: f.name || '', crops: (f.shots || []).map((s) => s.crop_b64),
      label_text: label.text || '', label_name: label.product_name || '', label_dosage: label.dosage || '',
    });
    if (this.flow !== f || f.token !== token) return;
    if (!data.success) return this._view({ title: 'Could not save', hint: String(data.error || '').slice(0, 80), actions: ['save', 'cancel'] }, 'error');
    this._close(true);
    this._queueToast('Saved', [f.objName, f.notes || f.dosage].filter(Boolean).join(' — '));
  }

  // Speak: a spoken request goes to the assistant as in the 2D app ("Hey Kinly"); the answer is shown and said aloud
  _speak() {
    this.flow = { kind: 'speak', state: 'listening', token: 0, anchor: this._frontAnchor() };
    const f = this.flow;
    const token = ++f.token;
    const r = this._record((audio) => {
      if (this.flow !== f || f.token !== token) return;
      this._view({ title: 'One moment…', actions: ['cancel'] }, 'thinking');
      f.until = performance.now() + 25000;
      this.send({ type: 'COMMAND_AUDIO_FULL', data: audio });
    });
    if (r.error) return this._view({ title: r.error, hint: 'Exit AR and turn the mic on', actions: ['close'] }, 'error');
    this._view({ title: 'Say what you need', status: 'Listening…', hint: 'For example: “Remind me to take my pills at 8”', actions: ['done', 'cancel'] }, 'listening');
  }

  async _openBoard() {
    const anchor = this._frontAnchor(BOARD_DIST, 0.03); // between the HUD and the menu, inside the narrow view
    this.board = { anchor, rows: [{ title: 'Loading…', sub: '', icon: 'memory' }] };
    const [faces, objects] = await Promise.all([this._get('/api/faces'), this._get('/api/objects')]);
    if (!this.board || this.board.anchor !== anchor) return;
    const rows = [
      ...(faces.faces || []).map((p) => ({ title: p.name, sub: p.relation || '', icon: 'person' })),
      ...(objects.objects || []).map((o) => ({ title: o.name, sub: o.dosage || o.notes || 'Saved', icon: o.category === 'medicine' || o.dosage ? 'pill' : 'box' })),
    ];
    this.board.total = rows.length;
    this.board.rows = rows.length ? rows.slice(0, 4) : [{ title: 'Nothing saved yet', sub: 'People and objects you add show here', icon: 'memory' }];
  }

  _view(view, state) {
    if (!this.flow) return;
    this.flow.view = view;
    if (state) this.flow.state = state;
  }

  // Forgetting a person (owner, 31.10.2026: from the HUD, not only from the database panel)
  _forgetAsk(name) {
    const tag = this.known.get(name);
    if (!tag) return;
    this._close();
    this.expanded = null;
    this.flow = { kind: 'forget', state: 'confirm', token: 0, name, anchor: this._faceAnchor(tag) };
    this._view({ title: `Forget ${name}?`, hint: 'Their face is deleted from memory', actions: ['forget-yes', 'cancel'] }, 'confirm');
  }

  async _forget() {
    const f = this.flow;
    if (!f || f.kind !== 'forget') return;
    const token = ++f.token;
    this._view({ title: `Forgetting ${f.name}…`, actions: [] }, 'saving');
    const data = await this._post(`/api/faces/${encodeURIComponent(f.name)}`, undefined, 'DELETE');
    if (this.flow !== f || f.token !== token) return;
    if (!data.success) return this._view({ title: 'Could not forget', hint: String(data.error || '').slice(0, 80), actions: ['forget-yes', 'cancel'] }, 'error');
    this.forgotten.set(f.name, performance.now() + FORGET_MUTE_MS);
    this.known.delete(f.name);
    this._close();
    this._queueToast('Forgotten', `${f.name} is no longer recognised`);
  }

  async _post(path, body, method = 'POST') {
    try {
      const init = body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
      const r = await fetch(`${this.apiBase}${path}`, init);
      return await r.json();
    } catch (e) {
      this.stats.error = `${path}: ${e}`.slice(0, 200);
      return { success: false, error: 'The backend did not answer' };
    }
  }

  async _get(path) {
    try {
      return await (await fetch(`${this.apiBase}${path}`, { cache: 'no-store' })).json();
    } catch {
      return {};
    }
  }

  _action(id) {
    this.stats.lastAction = id;
    const f = this.flow;
    if (id.startsWith('p:')) { const name = id.slice(2); this.expanded = this.expanded === name ? null : name; }
    else if (id === 'forget') this._forgetAsk(this.expanded);
    else if (id === 'forget-yes') this._forget();
    else if (id === 'add') this._addPerson();
    else if (id === 'm-here') this._whatsHere();
    else if (id === 'm-memory') this._openBoard();
    else if (id === 'm-speak') this._speak();
    else if (id === 'm-pause') this._setPaused(!this.paused);
    else if (id === 'm-exit') this.end();
    else if (id === 'board-close') this.board = null;
    else if (id === 'obj-save') this._objectCapture();
    else if (id === 'obj-later' || id === 'no' || id === 'close' || id === 'ok') this._close(f && f.kind === 'speak');
    else if (id === 'cancel') this._close(f && (f.kind === 'speak' || f.kind === 'object'));
    else if (id === 'yes') this._objectStep2();
    else if (id === 'done') this._stopRecording();
    else if (id === 'retry') { if (f && f.kind === 'object') this._objectListen(); else if (f && f.kind === 'person') this._personListen(); }
    else if (id === 'save') { if (f && f.kind === 'object') this._objectSave(); else if (f && f.kind === 'person') this._personSave(); }
  }

  _setPaused(on) {
    this.paused = on;
    if (on) {
      this._close();
      this.known.clear(); this.objects = []; this.unknown = null; this.dwell = null; this.expanded = null;
    }
  }

  // ---------- input ----------
  _hit(o, d) {
    let best = null, bt = Infinity;
    for (const b of this.buttons) {
      const n = [Math.sin(b.yaw), 0, Math.cos(b.yaw)];
      const denom = dot(d, n);
      if (denom > -1e-4) continue;
      const t = dot(sub(b.pos, o), n) / denom;
      if (t <= 0 || t >= bt) continue;
      const P = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const x = dot(sub(P, b.pos), [Math.cos(b.yaw), 0, -Math.sin(b.yaw)]);
      const y = P[1] - b.pos[1];
      if (Math.abs(x) <= b.w / 2 && Math.abs(y) <= b.h / 2) { best = b; bt = t; }
    }
    return best ? { b: best, t: bt } : null;
  }

  // A pinch on a button (or a person's tag) presses it; a pinch at nothing closes an open tag
  _onSelect(e) {
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    const pose = e.frame.getPose(e.inputSource.targetRaySpace, this.space);
    if (!pose) return;
    const { o, d } = rayOf(pose.transform.matrix);
    const h = this._hit(o, d);
    this.stats.selects += 1;
    if (h) {
      this.stats.hits += 1;
      this._action(h.b.id);
    } else {
      this.expanded = null;
    }
  }

  _onEnded() {
    this._report();
    clearInterval(this.reportTimer);
    this._close(true);
    this.session = null;
    for (const t of this.textures.values()) this.gl.deleteTexture(t);
    this.textures.clear();
    if (this.onEnd) this.onEnd();
  }

  // ---------- drawing ----------
  _initGL() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false });
    this.gl = gl;
    const vs = 'attribute vec2 p; uniform mat4 mvp; varying vec2 uv; void main(){ uv = vec2(p.x + 0.5, 0.5 - p.y); gl_Position = mvp * vec4(p, 0.0, 1.0); }';
    const fs = 'precision mediump float; varying vec2 uv; uniform sampler2D tex; void main(){ gl_FragColor = texture2D(tex, uv); }';
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    this.prog = prog;
    this.uMvp = gl.getUniformLocation(prog, 'mvp');
    this.uTex = gl.getUniformLocation(prog, 'tex');
    this.aPos = gl.getAttribLocation(prog, 'p');
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  }

  // A texture painted at twice the design size for sharp text; t.size is its size in metres, t.px in design px.
  _paint(key, W, H, paint) {
    let t = this.textures.get(key);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = Math.ceil(W * 2);
    c.height = Math.ceil(H * 2);
    const x = c.getContext('2d');
    x.scale(2, 2);
    const extra = paint(x) || {};
    const gl = this.gl;
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    Object.assign(t, extra, { size: [W * DPX, H * DPX], px: [W, H] });
    if (this.textures.size > 220) { // drop the oldest looks (texts change over a session)
      const [oldKey, oldTex] = this.textures.entries().next().value;
      gl.deleteTexture(oldTex);
      this.textures.delete(oldKey);
    }
    this.textures.set(key, t);
    return t;
  }

  // FaceTag (design: 130 px pill): avatar circle, name in white, a second line in mint. Also used for saved
  // objects (an icon in the circle instead of the initial). A person's tag is pressable: under a hand ray it gets a
  // thick white border like a button.
  _tagTex(name, second, initial, iconName, focus = false) {
    const W = 22 + 84 + 18 + Math.max(textWidth(name, 700, 40), second ? textWidth(second, 700, 28) : 0) + 34;
    return this._paint(`tag|${name}|${second}|${initial}|${iconName}|${focus}`, W + 4, 134, (x) => {
      glass(x, 2, 2, W, 130, 30, V4.glass, focus ? '#FFFFFF' : V4.edge, focus ? 4 : 1.5);
      x.fillStyle = V4.mint; x.beginPath(); x.arc(2 + 22 + 42, 67, 42, 0, Math.PI * 2); x.fill();
      if (iconName) icon(x, ICON[iconName], 2 + 22 + 42 - 21, 67 - 21, 42, V4.ink, 2.6);
      else text(x, initial, 2 + 22 + 42, 67, 700, 42, V4.ink, 'center');
      const tx = 2 + 22 + 84 + 18;
      if (second) {
        text(x, name, tx, 48, 700, 40, V4.text);
        text(x, second, tx, 90, 700, 28, V4.mint);
      } else {
        text(x, name, tx, 67, 700, 40, V4.text);
      }
    });
  }

  // A small chip (design: 52 px): the last topic under a tag, the idle hint, "Photo taken", "Said aloud"
  _chipTex(label, iconName, color = V4.mint) {
    const iw = iconName ? 26 + 10 : 0;
    const W = 16 + iw + textWidth(label, 700, 22) + 20;
    return this._paint(`chip|${label}|${iconName}|${color}`, W + 4, 56, (x) => {
      glass(x, 2, 2, W, 52, 26, 'rgba(16,34,26,0.82)', 'rgba(255,255,255,0.2)');
      if (iconName) icon(x, ICON[iconName], 2 + 16, 2 + 13, 26, color, 2.4);
      text(x, label, 2 + 16 + iw, 28, 700, 22, V4.text);
    });
  }

  // Buttons: pills, primary in mint, secondary see-through with a white outline; the focused one (under a hand ray)
  // gets a thick white border and a ring. The texture has an 8 px margin for the ring.
  _buttonTex(id, focus, width, height = 84) {
    const def = this._buttonDef(id);
    const menu = height === 92; // menu items (design MenuBar): 27 px text, 32 px icon
    const fs = menu ? 27 : 30, is = menu ? 32 : 30;
    const W = width || 32 + is + 12 + textWidth(def.label, 700, fs) + 36;
    return this._paint(`btn|${id}|${def.label}|${focus}|${W}|${height}`, W + 16, height + 16, (x) => {
      if (focus) { rr(x, 2, 2, W + 12, height + 12, (height + 12) / 2); x.fillStyle = 'rgba(255,255,255,0.28)'; x.fill(); }
      rr(x, 8, 8, W, height, height / 2);
      x.fillStyle = def.primary ? V4.mint : V4.ghost; x.fill();
      x.lineWidth = focus ? 4 : 2; x.strokeStyle = focus ? '#FFFFFF' : 'rgba(255,255,255,0.5)'; x.stroke();
      const color = def.primary ? V4.ink : V4.text;
      const tw = is + 12 + textWidth(def.label, 700, fs), left = 8 + (W - tw) / 2;
      icon(x, ICON[def.icon], left, 8 + (height - is) / 2, is, color, menu ? 2.4 : 3);
      text(x, def.label, left + is + 12, 8 + height / 2, 700, fs, color);
    });
  }

  _buttonDef(id) {
    const f = this.flow;
    const confirm = f && f.view && f.view.step === 2;
    return {
      add: { label: 'Add person', icon: 'plus', primary: true },
      done: { label: 'Done', icon: 'check', primary: true },
      save: { label: 'Yes, save', icon: 'check', primary: true },
      yes: { label: 'Yes', icon: 'check', primary: true },
      no: { label: 'No', icon: 'x' },
      ok: { label: 'OK', icon: 'check', primary: true },
      retry: { label: confirm ? 'Change it' : 'Try again', icon: 'mic' },
      cancel: { label: 'Cancel', icon: 'x' },
      forget: { label: 'Forget', icon: 'trash' },
      'forget-yes': { label: 'Yes, forget', icon: 'trash', primary: true },
      close: { label: 'Close', icon: 'x' },
      'obj-save': { label: 'Save', icon: 'check', primary: true },
      'obj-later': { label: 'Not now', icon: 'x' },
      'board-close': { label: 'Close', icon: 'x' },
      'm-here': { label: 'What’s here?', icon: 'scan' },
      'm-memory': { label: 'My memory', icon: 'memory' },
      'm-speak': { label: 'Speak', icon: 'mic', primary: true },
      'm-pause': this.paused ? { label: 'Resume help', icon: 'play' } : { label: 'Pause help', icon: 'pause' },
      'm-exit': { label: 'Exit AR', icon: 'exit' },
    }[id];
  }

  // The card of a flow (design: Confirm / Object found): steps, a kicker and a big name, the name and its second
  // line, a question, a status, a body text, buttons, a hint. Returns the texture with `slots` for the buttons.
  _cardTex(v) {
    const W = v.big ? 300 : 340, pad = v.big ? 24 : 26, inner = W - 2 * pad;
    const key = `card|${JSON.stringify(v)}`;
    const cached = this.textures.get(key);
    if (cached) return cached;
    const titleSize = v.step === 2 ? 30 : 36;
    const title = v.title ? wrap(v.title, 700, titleSize, inner) : [];
    const kicker = v.kicker ? wrap(v.kicker, 700, v.big ? 24 : 22, inner) : [];
    const body = v.body ? wrap(v.body, 700, 28, inner) : [];
    const sub = v.sub ? wrap(v.sub, 700, 26, inner) : [];
    const hint = v.hint ? wrap(v.hint, 700, 22, inner) : [];
    let y = pad;
    const plan = [];
    if (v.step) { plan.push(['steps', y]); y += 20 + 14; }
    if (kicker.length) { plan.push(['kicker', y]); y += kicker.length * (v.big ? 30 : 28) + 4; }
    if (v.big) { plan.push(['big', y]); y += 53 + 14; }
    if (v.name) { plan.push(['name', y]); y += 42 + 2 + sub.length * 31 + 14; }
    if (title.length) { plan.push(['title', y]); y += title.length * titleSize * 1.15 + 14; }
    if (v.status) { plan.push(['status', y]); y += 31 + 14; }
    if (body.length) { plan.push(['body', y]); y += body.length * 28 * 1.3 + 14; }
    const slots = (v.actions || []).map((id) => { const s = { id, x: pad, y, w: inner, h: 84 }; y += 84 + 14; return s; });
    if (hint.length) { plan.push(['hint', y]); y += hint.length * 22 * 1.3 + 14; }
    const H = y - 14 + pad;
    return this._paint(key, W + 4, H + 4, (x) => {
      glass(x, 2, 2, W, H, v.big ? 30 : 32, V4.glassStrong, 'rgba(255,255,255,0.22)');
      const L = 2 + pad;
      for (const [part, py] of plan) {
        const top = py + 2;
        if (part === 'steps') {
          for (let i = 0; i < 2; i++) { rr(x, L, top + 6, 34, 8, 4); x.fillStyle = i < v.step ? V4.mint : 'rgba(255,255,255,0.35)'; x.fill(); x.translate(44, 0); }
          x.setTransform(2, 0, 0, 2, 0, 0);
          text(x, `Step ${v.step} of 2`, L + 92, top + 10, 700, 20, V4.text);
        } else if (part === 'kicker') {
          kicker.forEach((line, i) => text(x, line, L, top + 13 + i * (v.big ? 30 : 28), 700, v.big ? 24 : 22, v.big ? V4.text : V4.mint));
        } else if (part === 'big') {
          text(x, v.big, L, top + 27, 700, 48, V4.text);
        } else if (part === 'name') {
          text(x, v.name, L, top + 21, 700, 38, V4.text);
          sub.forEach((line, i) => text(x, line, L, top + 44 + 15 + i * 31, 700, 26, V4.mint));
        } else if (part === 'title') {
          title.forEach((line, i) => text(x, line, L, top + titleSize * 0.58 + i * titleSize * 1.15, 700, titleSize, V4.text));
        } else if (part === 'status') {
          text(x, v.status, L, top + 15, 700, 26, V4.mint);
        } else if (part === 'body') {
          body.forEach((line, i) => text(x, line, L, top + 16 + i * 28 * 1.3, 700, 28, V4.text));
        } else if (part === 'hint') {
          hint.forEach((line, i) => text(x, line, L, top + 13 + i * 22 * 1.3, 700, 22, V4.text));
        }
      }
      return { slots };
    });
  }

  // Saved (design): a mint check, the title and a detail line
  _toastTex(title, detail) {
    const W = 20 + 68 + 18 + Math.max(textWidth(title, 700, 30), textWidth(detail || '', 700, 26)) + 32;
    return this._paint(`toast|${title}|${detail}`, W + 4, 112, (x) => {
      glass(x, 2, 2, W, 108, 36, V4.glassStrong, 'rgba(255,255,255,0.22)');
      x.fillStyle = V4.mint; x.beginPath(); x.arc(2 + 20 + 34, 56, 34, 0, Math.PI * 2); x.fill();
      icon(x, ICON.check, 2 + 20 + 16, 56 - 18, 36, V4.ink, 3);
      text(x, title, 2 + 20 + 68 + 18, detail ? 38 : 56, 700, 30, V4.text);
      if (detail) text(x, detail, 2 + 20 + 68 + 18, 74, 700, 26, V4.text);
    });
  }

  // HUD (design): the date and time with a sun, plus a chip for walking, waiting updates or paused help
  _hudTex(clock, chip) {
    const w1 = 18 + 26 + 12 + textWidth(clock, 700, 24) + 22;
    const w2 = chip ? 16 + 26 + 10 + textWidth(chip.label, 700, 22) + 22 : 0;
    const W = w1 + (chip ? 10 + w2 : 0);
    return this._paint(`hud|${clock}|${chip ? chip.label : ''}`, W + 4, 64, (x) => {
      glass(x, 2, 2, w1, 60, 30, 'rgba(16,34,26,0.82)', 'rgba(255,255,255,0.2)');
      icon(x, ICON.sun, 2 + 18, 2 + 17, 26, V4.sand, 2.2);
      text(x, clock, 2 + 18 + 26 + 12, 32, 700, 24, V4.text);
      if (chip) {
        const L = 2 + w1 + 10;
        glass(x, L, 2, w2, 60, 30, 'rgba(16,34,26,0.82)', chip.border || 'rgba(255,255,255,0.2)', chip.border ? 2 : 1.5);
        if (chip.dot) { x.fillStyle = V4.mint; x.beginPath(); x.arc(L + 16 + 7 + 6, 32, 7, 0, Math.PI * 2); x.fill(); }
        else icon(x, ICON[chip.icon], L + 16, 2 + 17, 26, V4.sand, 2.2);
        text(x, chip.label, L + 16 + 26 + 10, 32, 700, 22, V4.text);
      }
    });
  }

  // Menu bar (design): a row of pills, always on at the bottom of the view; returns the bar with item slots
  _menuTex() {
    const items = ['m-here', 'm-memory', 'm-speak', 'm-pause', 'm-exit'];
    const widths = items.map((id) => 20 + 32 + 12 + textWidth(this._buttonDef(id).label, 700, 27) + 26);
    const W = 18 * 2 + widths.reduce((a, b) => a + b, 0) + 14 * (items.length - 1);
    const key = `menu|${this.paused}`;
    return this._paint(key, W + 4, 132, (x) => {
      glass(x, 2, 2, W, 128, 64, 'rgba(16,34,26,0.84)', 'rgba(255,255,255,0.22)');
      let X = 2 + 18;
      const slots = items.map((id, i) => { const s = { id, x: X, w: widths[i] }; X += widths[i] + 14; return s; });
      return { slots };
    });
  }

  // My memory (design: board pinned to a wall): title, "Pinned here", rows with a mint icon, a name and a line
  _boardTex(board) {
    const W = 600, rows = board.rows;
    const H = 28 + 46 + 14 + rows.length * (104 + 14) - 14 + 28 + (board.total > rows.length ? 34 : 0);
    const key = `board|${JSON.stringify(rows)}|${board.total}`;
    return this._paint(key, W + 4, H + 4, (x) => {
      glass(x, 2, 2, W, H, 34, V4.glassStrong, 'rgba(255,255,255,0.3)', 2);
      text(x, 'My memory', 30, 2 + 28 + 23, 700, 38, V4.text);
      const pin = 'Pinned here';
      const pw = textWidth(pin, 700, 20);
      icon(x, ICON.pin, 2 + W - 28 - pw - 30, 2 + 28 + 12, 22, V4.sand, 2.4);
      text(x, pin, 2 + W - 28 - pw, 2 + 28 + 23, 700, 20, V4.sand);
      let y = 2 + 28 + 46 + 14;
      for (const r of rows) {
        glass(x, 30, y, W - 56, 104, 26, 'rgba(255,255,255,0.1)', 'rgba(255,255,255,0.28)', 2);
        x.fillStyle = V4.mint; x.beginPath(); x.arc(30 + 16 + 34, y + 52, 34, 0, Math.PI * 2); x.fill();
        icon(x, ICON[r.icon], 30 + 16 + 34 - 17, y + 52 - 17, 34, V4.ink, 2.4);
        const tx = 30 + 16 + 68 + 18;
        if (r.sub) {
          text(x, r.title, tx, y + 36, 700, 32, V4.text);
          text(x, r.sub, tx, y + 72, 700, 24, V4.mint);
        } else {
          text(x, r.title, tx, y + 52, 700, 32, V4.text);
        }
        y += 104 + 14;
      }
      if (board.total > rows.length) text(x, `+ ${board.total - rows.length} more in the Memory Database`, 30, y + 6, 700, 20, V4.text);
    });
  }

  // Object highlight (design): a mint frame with a white edge and a soft glow, painted at the box's size
  _frameTex(wPx, hPx) {
    const W = Math.max(40, Math.round(wPx / 10) * 10), H = Math.max(40, Math.round(hPx / 10) * 10);
    return this._paint(`frame|${W}|${H}`, W + 24, H + 24, (x) => {
      x.shadowColor = 'rgba(184,242,160,0.55)'; x.shadowBlur = 14;
      rr(x, 12, 12, W, H, 18); x.lineWidth = 5; x.strokeStyle = V4.mint; x.stroke();
      x.shadowBlur = 0;
      rr(x, 9, 9, W + 6, H + 6, 21); x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,0.7)'; x.stroke();
    });
  }

  _smallTex(kind) {
    if (kind === 'dot') { // where the line meets the face: mint with a white edge
      return this._paint('dot', 20, 20, (x) => {
        x.fillStyle = V4.mint; x.strokeStyle = '#FFFFFF'; x.lineWidth = 2;
        x.beginPath(); x.arc(10, 10, 7, 0, Math.PI * 2); x.fill(); x.stroke();
      });
    }
    if (kind === 'line') return this._paint('line', 8, 8, (x) => { x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, 8, 8); });
    if (kind === 'ray') { // bright in the middle, fading to the sides
      return this._paint('ray', 32, 32, (x) => {
        const g = x.createLinearGradient(0, 0, 32, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.fillRect(0, 0, 32, 32);
      });
    }
    return this._paint('cursor', 40, 40, (x) => { // a white ring = where the hand points
      x.strokeStyle = '#FFFFFF'; x.lineWidth = 4; x.beginPath(); x.arc(20, 20, 14, 0, Math.PI * 2); x.stroke();
      x.fillStyle = V4.mint; x.beginPath(); x.arc(20, 20, 5, 0, Math.PI * 2); x.fill();
    });
  }

  // Everything to draw this frame as [{tex, m}]; buttons are also registered for the hand rays.
  _layout(eye, head, now) {
    const items = [];
    this.buttons = [];
    const quad = (tex, pos, yaw, s = 1) => items.push({ tex, m: model(pos, yaw, tex.size[0] * s, tex.size[1] * s) });
    const button = (id, pos, yaw, s = 1, width, height = 84) => {
      const tex = this._buttonTex(id, this.hovered.has(id), width, height);
      quad(tex, pos, yaw, s);
      this.buttons.push({ id, pos, yaw, w: (tex.px[0] - 16) * DPX * s, h: height * DPX * s });
    };
    const gap = 10 * DPX;
    // A dock: things left-aligned on a line right of an anchor, at its height, turned to the wearer.
    // Faces get a white line with a mint dot (design FaceTag), objects a short line from the frame (design Object).
    const dock = (anchor) => {
      const { pos: c, yaw, scale: s } = anchor;
      const r = [Math.cos(yaw), 0, -Math.sin(yaw)];
      const at = (dx, dy) => [c[0] + r[0] * dx, c[1] + dy, c[2] + r[2] * dx];
      let left;
      if (anchor.kind === 'face') {
        left = FACE_EDGE + CONNECT * s;
        const dotPos = at(FACE_EDGE, 0);
        items.push({ tex: this._smallTex('line'), m: beam(dotPos, at(left, 0), eye, 0.0032 * s) });
        quad(this._smallTex('dot'), dotPos, yaw, s);
      } else if (anchor.kind === 'object') {
        const edge = anchor.size[0] / 2 + 12 * DPX;
        left = edge + 26 * DPX * s;
        items.push({ tex: this._smallTex('line'), m: beam(at(edge, 0), at(left, 0), eye, 0.0032 * s) });
      }
      return {
        place: (tex, dy) => {
          const dx = anchor.kind === 'front' ? 0 : left + (tex.size[0] * s) / 2;
          const pos = at(dx, dy);
          quad(tex, pos, yaw, s);
          return pos;
        },
        // a button whose pill starts dxPx design px right of the dock line (front: of the card's left edge)
        button: (id, dy, width, dxPx, cardW) => {
          const tex = this._buttonTex(id, this.hovered.has(id), width);
          const base = anchor.kind === 'front' ? -(cardW * DPX * s) / 2 : left; // cardW is in design px
          const pos = at(base + (dxPx - 8) * DPX * s + (tex.size[0] * s) / 2, dy);
          quad(tex, pos, yaw, s);
          this.buttons.push({ id, pos, yaw, w: (tex.px[0] - 16) * DPX * s, h: 84 * DPX * s });
        },
        s,
      };
    };

    // HUD at the top edge of the view: the date and time, plus a chip for walking, paused help or waiting updates
    const clock = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, '')
      + ' · ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    let chip = null;
    if (this.walking) chip = { label: 'Walking — screen kept clear', icon: 'walk', border: V4.sand };
    else if (this.paused) chip = { label: 'Help paused', icon: 'pause' };
    else if (this.toasts.length && this._talking()) chip = { label: `${this.toasts.length} update${this.toasts.length > 1 ? 's' : ''} — after your talk`, dot: true };
    const hudTex = this._hudTex(clock, chip);
    quad(hudTex, this.hud.pos, this.hud.yaw, HUD_SCALE);
    const underHud = (tex, k = 1) => [this.hud.pos[0], this.hud.pos[1] - (hudTex.size[1] / 2 + gap * k + tex.size[1] / 2) * HUD_SCALE, this.hud.pos[2]];

    // Menu at the bottom edge of the view, always on (also while walking)
    const m = this.menuAt, bar = this._menuTex(), [barW] = bar.px;
    quad(bar, m.pos, m.yaw, MENU_SCALE);
    const mr = [Math.cos(m.yaw), 0, -Math.sin(m.yaw)];
    for (const slot of bar.slots) {
      const dx = (slot.x + slot.w / 2 - barW / 2) * DPX * MENU_SCALE;
      button(slot.id, [m.pos[0] + mr[0] * dx, m.pos[1], m.pos[2] + mr[2] * dx], m.yaw, MENU_SCALE, slot.w, 92);
    }
    if (this.walking) return items;

    if (!this.paused) {
      // Known people: the name only; a pinch on the tag adds the relation, the last topic and Forget
      for (const [name, tag] of this.known) {
        if (now - tag.seen > KNOWN_TTL_MS) { this.known.delete(name); if (this.expanded === name) this.expanded = null; continue; }
        if (this.flow && this.flow.kind === 'forget' && this.flow.name === name) continue; // the Forget card is in its place
        const yaw = yawTo(tag.pos, eye), open = this.expanded === name, id = `p:${name}`;
        const d = dock({ kind: 'face', pos: tag.pos, yaw, scale: Math.max(1, tag.dist / 1.5) });
        const tex = this._tagTex(tag.name, open ? tag.relation : '', tag.name.charAt(0).toUpperCase(), undefined, this.hovered.has(id));
        const pos = d.place(tex, 0);
        this.buttons.push({ id, pos, yaw, w: (tex.px[0] - 4) * DPX * d.s, h: (tex.px[1] - 4) * DPX * d.s });
        if (open) {
          let y = -(tex.size[1] / 2 + gap) * d.s;
          if (tag.topic) {
            const chipTex = this._chipTex(tag.topic, 'topic');
            d.place(chipTex, y - (chipTex.size[1] / 2) * d.s);
            y -= (chipTex.size[1] + gap) * d.s;
          }
          d.button('forget', y - ((100 * DPX) / 2) * d.s, undefined, 2);
        }
      }
      if (this.unknown && !this.flow && now - this.unknown.seen > UNKNOWN_TTL_MS) this.unknown = null;
      if (this.unknown && !this.flow) {
        const u = this.unknown, a = this._faceAnchor(u), d = dock(a);
        const tex = this._tagTex('Unknown person', '', '?');
        d.place(tex, 0);
        d.button('add', -(tex.size[1] / 2 + gap + (100 * DPX) / 2) * d.s, undefined, 2);
      }
      if (!(this.flow && this.flow.kind === 'object')) {
        for (const o of this.objects) {
          const a = this._objectAnchor(o);
          quad(this._frameTex(o.size[0] / DPX, o.size[1] / DPX), o.pos, a.yaw);
          dock(a).place(this._tagTex(o.name, o.sub, '', o.medicine ? 'pill' : 'box'), 0);
        }
      }
    }

    // The open card of a flow
    if (this.flow && this.flow.view) {
      const f = this.flow, v = f.view;
      if (f.kind === 'object' && f.anchor.kind === 'object' && this.target) {
        const a = f.anchor;
        quad(this._frameTex(a.size[0] / DPX, a.size[1] / DPX), a.pos, a.yaw);
        if (f.photo) { // "Photo taken" above the frame, left-aligned with it
          const chipTex = this._chipTex(f.photo, 'camera');
          const r = [Math.cos(a.yaw), 0, -Math.sin(a.yaw)], dx = -a.size[0] / 2 + chipTex.size[0] / 2;
          quad(chipTex, [a.pos[0] + r[0] * dx, a.pos[1] + a.size[1] / 2 + gap + chipTex.size[1] / 2, a.pos[2] + r[2] * dx], a.yaw);
        }
      }
      const d = dock(f.anchor);
      const tex = this._cardTex(v), [W, H] = tex.px;
      d.place(tex, 0);
      for (const slot of tex.slots) {
        const dy = (H / 2 - (slot.y + 2 + slot.h / 2)) * DPX * d.s;
        d.button(slot.id, dy, slot.w, 2 + slot.x, W);
      }
      if (f.kind === 'speak' && f.state === 'answer' && now > f.closeAt) this._close();
      if (f.kind === 'speak' && f.state === 'thinking' && now > f.until) this._view({ title: 'No answer came', hint: 'Try again in a moment', actions: ['close'] }, 'error');
      if (f.kind === 'object' && f.state === 'searching' && now - f.since > TARGET_WAIT_MS) {
        this._view({ title: 'Nothing found in the middle', hint: 'Hold the object in front of you, closer', actions: ['close'] }, 'nothing');
      }
    }

    // My memory board (stays where it opened)
    if (this.board) {
      const b = this.board.anchor, tex = this._boardTex(this.board);
      quad(tex, b.pos, b.yaw);
      button('board-close', [b.pos[0], b.pos[1] - tex.size[1] / 2 - gap - (100 * DPX) / 2, b.pos[2]], b.yaw);
    }

    // Updates: one at a time under the HUD, only while the wearer is not talking (design: waits for a pause)
    if (!this.toast && this.toasts.length && !this._talking()) {
      this.toast = { ...this.toasts.shift(), until: now + TOAST_MS };
      this._chime();
    }
    if (this.toast) {
      if (now > this.toast.until) this.toast = null;
      else { const t = this._toastTex(this.toast.title, this.toast.detail); quad(t, underHud(t, 1.5), this.hud.yaw, HUD_SCALE); }
    }
    return items;
  }

  // The HUD and the menu follow the head, a little smoothed: the HUD at the top edge of the view, the menu at the bottom
  _follow(head, eye, now) {
    const k = this.lastFollow ? 1 - Math.exp(-(now - this.lastFollow) / 1000 / FOLLOW_S) : 1;
    this.lastFollow = now;
    const at = (d, deg) => { const a = (deg * Math.PI) / 180; return apply(head, 0, d * Math.sin(a), -d * Math.cos(a)); };
    const step = (cur, target) => { const pos = cur ? lerp3(cur.pos, target, k) : target; return { pos, yaw: yawTo(pos, eye) }; };
    this.hud = step(this.hud, at(HUD_DIST, HUD_UP_DEG));
    this.menuAt = step(this.menuAt, at(MENU_DIST, -MENU_DOWN_DEG));
  }

  _updateWalking(eye, now) {
    this.track.push([now, eye[0], eye[2]]);
    while (this.track.length && now - this.track[0][0] > 1200) this.track.shift();
    const first = this.track[0];
    const span = (now - first[0]) / 1000;
    const speed = span > 0.5 ? Math.hypot(eye[0] - first[1], eye[2] - first[2]) / span : 0;
    const fast = this.walking ? speed > WALK_STOP_SPEED : speed > WALK_START_SPEED;
    if (fast !== this.walking) {
      if (!this.walkSince) this.walkSince = now;
      if (now - this.walkSince > (this.walking ? WALK_STOP_MS : WALK_START_MS)) {
        this.walking = fast;
        this.walkSince = 0;
      }
    } else {
      this.walkSince = 0;
    }
  }

  _updateLevel(now) {
    if (!this.levelReady) return;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    if (Math.sqrt(sum / this.levelBuf.length) > SPEECH_RMS) this.lastSpeech = now;
  }

  _onFrame(t, frame) {
    const session = frame.session;
    session.requestAnimationFrame((tt, ff) => this._onFrame(tt, ff));
    const pose = frame.getViewerPose(this.space);
    if (!pose) return;
    const head = pose.transform.matrix;
    const now = performance.now();
    const eye = [pose.transform.position.x, pose.transform.position.y, pose.transform.position.z];
    this.eye = eye;
    this.head = head;
    if (!this.paused && now - this.lastCapture >= FRAME_MS) { this.lastCapture = now; this._capture(head); }
    this._follow(head, eye, now);
    this._updateWalking(eye, now);
    this._updateLevel(now);

    // Hand rays: a visible beam from the hand, hover state and a cursor where each ray points
    const items = this._layout(eye, head, now);
    const cursors = [];
    const rays = [];
    const hovered = new Set();
    const inputs = [];
    for (const src of session.inputSources) {
      inputs.push(src.targetRayMode + (src.handedness !== 'none' ? '/' + src.handedness : ''));
      const rp = frame.getPose(src.targetRaySpace, this.space);
      if (!rp) continue;
      const { o, d } = rayOf(rp.transform.matrix);
      const h = this._hit(o, d);
      if (h) hovered.add(h.b.id);
      const tt = h ? h.t - 0.005 : 2.5;
      const end = [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt];
      cursors.push(end);
      if (src.targetRayMode !== 'gaze' && tt > 0.1) rays.push([[o[0] + d[0] * 0.05, o[1] + d[1] * 0.05, o[2] + d[2] * 0.05], end]);
    }
    this.hovered = hovered;
    this.stats.inputs = inputs.join(', ');

    const gl = this.gl;
    const layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0); // transparent: the room shows through
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uTex, 0);
    const cursorTex = this._smallTex('cursor');
    const rayTex = this._smallTex('ray');
    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const viewProj = mul(view.projectionMatrix, view.transform.inverse.matrix);
      const drawM = (tex, m) => {
        gl.uniformMatrix4fv(this.uMvp, false, mul(viewProj, m));
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      for (const it of items) drawM(it.tex, it.m);
      if (!this.walking) {
        for (const [a, b] of rays) drawM(rayTex, beam(a, b, eye, 0.006));
        for (const c of cursors) drawM(cursorTex, model(c, yawTo(c, eye), 0.032, 0.032));
      }
    }
  }
}
