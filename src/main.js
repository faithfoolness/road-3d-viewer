import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { IFCLoader } from 'web-ifc-three';
import * as WebIFC from 'web-ifc';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// IMPORTANT: enable this BEFORE creating any THREE.Color / material / light.
// ColorManagement and renderer.outputEncoding = sRGBEncoding only work as a
// pair: enabling just one of them makes the image dull and "grey".
THREE.ColorManagement.enabled = true;

CameraControls.install({ THREE });

const mount = document.getElementById('viewer-mount');
const statusEl = document.getElementById('status');

// ---------------------------------------------------------------------------
// Scene, camera, renderer
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();

// near/far here are only initial values; updateCameraRange then sets them from
// the model extent. A fixed far clipped everything beyond 20000 units: on a
// model in millimetres or on a long linear asset the far half simply
// vanished, leaving the background gradient in its place.
const camera = new THREE.PerspectiveCamera(50, mount.clientWidth / mount.clientHeight, 0.01, 20000);
camera.position.set(10, 10, 10);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  // Logarithmic depth buffer: precision is almost the same at any distance,
  // so near can stay in centimetres even on a 20 km road
  // without z-fighting in the distance.
  logarithmicDepthBuffer: true,
});
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(mount.clientWidth, mount.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
mount.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(mount.clientWidth, mount.clientHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.left = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
mount.appendChild(labelRenderer.domElement);

let gridHelper = null;
let isLightTheme = false;

// Registry of loaded models: id (from Python) -> { info, object, box }.
// Visibility lives in object.visible; there is no separate flag.
const models = new Map();
const loadingIds = new Set();

// Shared scene origin. Python centres point clouds on their own mean
// (otherwise UTM coordinates lose half a metre in float32) and reports that mean in
// info.origin. The first loaded model sets the origin and the rest are placed
// relative to it, so two clouds of the same site line up instead of
// each drifting to its own centre.
let sceneOrigin = null;

// ---------------------------------------------------------------------------
// Scene scale
//
// Marker sizes, line widths and point sizes used to be hard-coded numbers
// tuned for a model "roughly in metres". On a kilometre-scale site a marker
// became an invisible speck; on a part in millimetres it covered everything.
// Now everything is a fraction of the diagonal of the combined bbox.
// ---------------------------------------------------------------------------

let sceneScale = 30;   // diagonal of the visible models; 30 is the old default

// Material glossiness. 1 is fully matte, 0 is a mirror.
const MATTE_ROUGHNESS = 0.95;   // IFC and models without their own materials
const MIN_ROUGHNESS = 0.6;      // lower bound for materials from .mtl

const SCALE = {
  dot: 0.00085,    // measurement marker radius
  tube: 0.001,     // measurement line radius
  point: 0.001,    // point cloud point size
  pick: 0.0017,    // raycast hit threshold for points
};

const dotRadius = () => sceneScale * SCALE.dot;
const tubeRadius = () => sceneScale * SCALE.tube;

// Shared unit geometries: size is set via mesh.scale, so nothing is rebuilt
// when the scale changes. They must not be dispose()d together with
// a measurement, because they are shared.
const UNIT_SPHERE = new THREE.SphereGeometry(1, 12, 12);
const UNIT_TUBE = new THREE.CylinderGeometry(1, 1, 1, 8);

// ---------------------------------------------------------------------------
// Gradient background (recoloured with the theme)
//
// A BackSide sphere of radius 10000 fills the whole frame, so scene.background
// and setClearColor are never visible behind it. The theme is changed here.
// ---------------------------------------------------------------------------

const BG_STOPS = {
  dark: [
    [0,   '#2a1f14'],
    [0.4, '#1f1811'],
    [0.7, '#140f0a'],
    [1,   '#0a0705'],
  ],
  light: [
    [0,   '#FFFDF8'],   // top: almost white, warm tint
    [0.4, '#FFF3E2'],
    [0.7, '#FFE4C4'],   // matches --scene-bg in CSS
    [1,   '#E5C295'],   // darker bottom so the model reads as a silhouette
  ],
};

const bgCanvas = document.createElement('canvas');
bgCanvas.width = 2;
bgCanvas.height = 512;

function paintBg(stops) {
  const ctx = bgCanvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, bgCanvas.height);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
}

paintBg(BG_STOPS.dark);

const bgTexture = new THREE.CanvasTexture(bgCanvas);
bgTexture.minFilter = THREE.LinearFilter;
bgTexture.magFilter = THREE.LinearFilter;
bgTexture.encoding = THREE.sRGBEncoding;

const background = new THREE.Mesh(
  new THREE.SphereGeometry(10000, 32, 32),
  new THREE.MeshBasicMaterial({
    map: bgTexture,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false,   // without this ACES burns the light gradient into a muddy grey
  })
);
background.userData.isMeasureHelper = true;   // ignored by measuring
background.renderOrder = -1;
scene.add(background);

scene.background = new THREE.Color(0x04050a);
renderer.setClearColor(0x04050a, 1);

// ---------------------------------------------------------------------------
// Global API for Python and index.html
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Overlay: startup screen and file loading indicator
// ---------------------------------------------------------------------------

let bootDone = false;

function overlayEls() {
  return {
    root: document.getElementById('overlay'),
    title: document.getElementById('overlay-title'),
    sub: document.getElementById('overlay-sub'),
    cancel: document.getElementById('overlay-cancel'),
  };
}

function showOverlay(title, subtitle, cancelable) {
  const el = overlayEls();
  if (!el.root) return;
  if (el.title) el.title.textContent = title || '';
  if (el.sub) el.sub.textContent = subtitle || '';
  if (el.cancel) el.cancel.classList.toggle('hidden', !cancelable);
  // busy: translucent mode over an already rendered scene;
  // before the first frame there is nothing to show through the overlay
  el.root.classList.toggle('busy', bootDone);
  el.root.classList.remove('gone');
}

function hideOverlay() {
  const el = overlayEls();
  if (el.root) el.root.classList.add('gone');
}

let errorTimer = null;

function showError(text) {
  const toast = document.getElementById('error-toast');
  if (!toast) { console.error(text); return; }
  toast.textContent = text;
  toast.classList.add('shown');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => toast.classList.remove('shown'), 7000);
}

window.viewerApp = {
  syncModels: () => syncModels(),

  // Python calls this for every file and when loading is finished
  setLoading(active, title, subtitle, cancelable) {
    if (active) showOverlay(title, subtitle, cancelable);
    else hideOverlay();
  },

  showError: (text) => showError(text),

  topView: () => topView(),

  setLowPower: (v) => setLowPower(v),

  // called from Python when the window state changes
  setMaximized(value) {
    const appWindow = document.getElementById('app-window');
    if (appWindow) appWindow.classList.toggle('maximized', !!value);
  },

  setBackground(color, isLight) {
    isLightTheme = !!isLight;
    paintBg(isLight ? BG_STOPS.light : BG_STOPS.dark);
    bgTexture.needsUpdate = true;   // without this line the new colours never reach the GPU

    scene.background = new THREE.Color(color);
    renderer.setClearColor(color, 1);

    // a dark brown grid is barely visible on the light background
    if (gridHelper) gridHelper.material.color.setHex(isLight ? 0x9c7a4e : 0x4a3520);
  },
};

// ---------------------------------------------------------------------------
// Top-bar buttons, window dragging, QWebChannel
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  if (typeof qt !== 'undefined' && typeof QWebChannel !== 'undefined') {
    new QWebChannel(qt.webChannelTransport, function (channel) {
      window.pyBackend = channel.objects.py_backend;
    });
  } else {
    // stub so the page also opens in a regular browser
    window.pyBackend = {
      onOpenFileRequested() { console.log('Open file requested (stub)'); },
      onWindowMinimize() {},
      onWindowMaximize() {},
      onWindowClose() {},
      onWindowMoveStart() {},
      onResizeStart() {},
      onModelRemove() {},
      onThemeChanged() {},
    };
  }

  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  };

  bind('btn-open-file',     () => window.pyBackend && window.pyBackend.onOpenFileRequested());
  bind('btn-win-minimize',  () => window.pyBackend && window.pyBackend.onWindowMinimize());
  bind('btn-win-maximize',  () => window.pyBackend && window.pyBackend.onWindowMaximize());
  bind('btn-win-close',     () => window.pyBackend && window.pyBackend.onWindowClose());

  // Window dragging is handed to the system: startSystemMove in Python starts
  // the native Windows move loop, so edge snapping works, as do
  // maximizing by dragging to the top and half-screen snap to the sides. The window
  // used to be moved by hand through window.move() and could do none of this.
  const topbar = document.getElementById('topbar');

  if (topbar) {
    let lastTitlePress = 0;

    topbar.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, select, a')) return;
      e.preventDefault();
      if (!window.pyBackend) return;

      // The system move loop captures the mouse and swallows mouseup,
      // so the native dblclick never reaches the page; we detect it ourselves.
      const now = performance.now();
      const isDouble = now - lastTitlePress < 400;
      lastTitlePress = now;

      if (isDouble) {
        window.pyBackend.onWindowMaximize();
        return;
      }
      window.pyBackend.onWindowMoveStart();
    });
  }

  // Resize zones along the page edges: 6 px on the sides, 12 px in the corners.
  // Windows performs the resize itself (startSystemResize), so
  // cursors, inertia and limits are exactly the same as for normal windows.
  document.querySelectorAll('.resize-grip').forEach((grip) => {
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (window.pyBackend) window.pyBackend.onResizeStart(grip.dataset.edge);
    });
  });

  const cancelBtn = document.getElementById('overlay-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      cancelBtn.classList.add('hidden');
      const sub = document.getElementById('overlay-sub');
      // this file is skipped; the others load as usual
      if (sub) sub.textContent = 'Skipping file…';
      if (window.pyBackend && window.pyBackend.onCancelLoading) {
        window.pyBackend.onCancelLoading();
      }
    });
  }

  initLightControls();
  initMeasureButtons();

  // in case the page reloads while models are already loaded
  syncModels();
});

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

const lights = { sun: null, fill: null, ambient: null, ground: null, front: null, rim: null };

// Only the direction of a directional light matters, but the sun position sets
// the shadow camera position, so directions are stored separately and the distance
// comes from the model extent (see updateSunShadow).
const SUN_DIR = {
  day: new THREE.Vector3(15, 20, 10).normalize(),
  studio: new THREE.Vector3(5, 10, 5).normalize(),
};
const FRONT_DIR = {
  day: new THREE.Vector3(0, 5, 15).normalize(),
  studio: new THREE.Vector3(0, 2, 10).normalize(),
};

let sunDirection = SUN_DIR.day.clone();
let frontDirection = FRONT_DIR.day.clone();
let currentBrightness = 0.5;   // initial value, matches the slider in index.html
let currentMode = 'day';

function setupLights() {
  lights.sun = new THREE.DirectionalLight(0xffeedd, 1.2);
  // initial position before a model is loaded; updateSunShadow sets it afterwards
  lights.sun.position.copy(sunDirection).multiplyScalar(30);
  lights.sun.castShadow = true;
  lights.sun.shadow.mapSize.width = 2048;
  lights.sun.shadow.mapSize.height = 2048;
  scene.add(lights.sun);
  // The target must be in the scene explicitly: without it shadows are built around the origin,
  // while the model may be somewhere else entirely.
  scene.add(lights.sun.target);

  lights.fill = new THREE.DirectionalLight(0x88bbff, 0.4);
  lights.fill.position.set(-10, 5, -10);
  scene.add(lights.fill);

  lights.ambient = new THREE.AmbientLight(0x404060, 0.5);
  scene.add(lights.ambient);

  lights.ground = new THREE.DirectionalLight(0x8b6b3d, 0.2);
  lights.ground.position.set(0, -10, 0);
  scene.add(lights.ground);

  lights.front = new THREE.PointLight(0xffffff, 0.3, 30);
  lights.front.position.set(0, 5, 15);
  scene.add(lights.front);

  lights.rim = new THREE.DirectionalLight(0x88ddff, 0.2);
  lights.rim.position.set(-10, 5, 10);
  scene.add(lights.rim);
}

setupLights();

const lightModes = {
  day: {
    sun:     { intensity: 1.2, color: 0xffeedd },
    fill:    { intensity: 0.4, color: 0x88bbff },
    ambient: { intensity: 0.5, color: 0x404060 },
    ground:  { intensity: 0.2, color: 0x8b6b3d },
    front:   { intensity: 0.3, color: 0xffffff },
    rim:     { intensity: 0.2, color: 0x88ddff },
  },
  studio: {
    sun:     { intensity: 0.5, color: 0xffffff },
    fill:    { intensity: 0.8, color: 0xffffff },
    ambient: { intensity: 0.2, color: 0x888888 },
    ground:  { intensity: 0.3, color: 0xffffff },
    front:   { intensity: 0.8, color: 0xffffff },
    rim:     { intensity: 0.6, color: 0xffffff },
  },
};

function applyLightMode(mode, brightness = currentBrightness) {
  currentMode = mode;
  const config = lightModes[mode];
  if (!config) return;

  Object.keys(config).forEach((key) => {
    if (!lights[key]) return;
    lights[key].intensity = config[key].intensity * brightness;
    if (config[key].color !== undefined) lights[key].color.setHex(config[key].color);
  });

  if (mode === 'studio') {
    lights.fill.position.set(-5, 2, 5);
    lights.rim.position.set(-5, 3, -5);
  } else {
    lights.fill.position.set(-10, 5, -10);
    lights.rim.position.set(-10, 5, 10);
  }

  // updateSunShadow places the sun and fill light, since they need the model extent
  sunDirection = (SUN_DIR[mode] || SUN_DIR.day).clone();
  frontDirection = (FRONT_DIR[mode] || FRONT_DIR.day).clone();

  const box = visibleBox();
  if (box) updateSunShadow(box);
  else lights.sun.position.copy(sunDirection).multiplyScalar(30);
}

function updateBrightness(value) {
  currentBrightness = value / 100;
  applyLightMode(currentMode, currentBrightness);
  const label = document.getElementById('brightness-label');
  if (label) label.textContent = Math.round(value) + '%';
}

function initLightControls() {
  const modeDay = document.getElementById('mode-day');
  const modeStudio = document.getElementById('mode-studio');
  const brightnessSlider = document.getElementById('brightness-slider');

  if (!modeDay || !brightnessSlider) {
    console.warn('Lighting controls not found');
    return;
  }

  function setActiveMode(activeButton) {
    [modeDay, modeStudio].forEach((btn) => btn && btn.classList.remove('active'));
    if (activeButton) activeButton.classList.add('active');
  }

  modeDay.addEventListener('click', () => {
    setActiveMode(modeDay);
    applyLightMode('day');
  });

  if (modeStudio) {
    modeStudio.addEventListener('click', () => {
      setActiveMode(modeStudio);
      applyLightMode('studio');
    });
  }

  brightnessSlider.addEventListener('input', (e) => updateBrightness(parseFloat(e.target.value)));

  // read the initial brightness from the slider itself so the value
  // is not kept in two places
  updateBrightness(parseFloat(brightnessSlider.value));
}

// ---------------------------------------------------------------------------
// Camera controls, grid
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
const controls = new CameraControls(camera, renderer.domElement);
controls.smoothTime = 0.18;
controls.draggingSmoothTime = 0.1;

// Mouse button mapping.
//
// The left button is not handed to the library: both TRUCK and SCREEN_PAN move the camera
// "by so many pixels", converted through the distance to the orbit
// point. On a long linear asset that point sits in the middle of the model, so
// dragging crawls at one end and jumps
// half a kilometre at the other. Instead, the point under the cursor is grabbed below.
controls.mouseButtons.left = CameraControls.ACTION.NONE;
controls.mouseButtons.middle = CameraControls.ACTION.NONE;
controls.mouseButtons.right = CameraControls.ACTION.ROTATE;
controls.mouseButtons.wheel = CameraControls.ACTION.DOLLY;

// Zoom to the point under the cursor, not the screen centre: on a long model
// that is the difference between "got there" and "missed, search again".
controls.dollyToCursor = true;

controls.touches.one = CameraControls.ACTION.TOUCH_TRUCK;
controls.touches.two = CameraControls.ACTION.TOUCH_DOLLY_ROTATE;

// Windows turns on autoscroll for the middle button and swaps the cursor.
// The middle button is not used, but the scroll icon on top of the scene
// is still in the way, so it is suppressed.
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault();
});
renderer.domElement.addEventListener('auxclick', (e) => {
  if (e.button === 1) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Dragging the scene with the left button: "grab and pull"
//
// On press we remember the model point under the cursor and a horizontal plane
// through it. On every move the camera is shifted so that this point
// stays exactly under the cursor, like dragging a map. Speed
// needs no tuning: the motion matches the cursor one to one by definition and
// is equally correct up close and from a kilometre away.
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const dragPlane = new THREE.Plane();
const dragAnchor = new THREE.Vector3();
const dragCurrent = new THREE.Vector3();
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();

let dragging = false;
let dragPointerId = null;

// Drag smoothing and inertia.
//
// pendingX/pendingZ: how far the camera still lags behind the cursor. Note that
// this is not an accumulator: updateSceneDrag computes the REMAINING error from
// the current camera position each time, so it is assigned, not added;
// otherwise the motion would double up.
let pendingX = 0;
let pendingZ = 0;

// smoothed velocity of the last frames, IN UNITS PER SECOND; it drives
// the glide after release. Per second, not per frame: otherwise at 144 Hz
// the glide would be half as long as at 60 Hz.
let velX = 0;
let velZ = 0;

// Rates are per second, not per frame: otherwise on a 144 Hz monitor
// the camera would catch up with the cursor twice as fast as at 60 Hz.
const FOLLOW_RATE = 17;   // how fast the camera catches up with the cursor while the button is held
const GLIDE_RATE = 9;     // how fast the glide fades after release
const GLIDE_TIME = 0.05;  // glide length: how many seconds of motion to add to the path
const STOP_EPS = 1e-5;    // below this the camera is considered stopped

function groundLevel() {
  const box = visibleBox();
  return box ? box.min.y : 0;
}

// What was grabbed: first try the model itself, otherwise a plane at the level
// of its bottom, so missing the geometry does not break the drag.
function pickGrabPoint(event) {
  const onModel = getPointOnModel(event);
  if (onModel) return onModel.clone();

  raycaster.setFromCamera(eventToNdc(event), camera);
  const ground = new THREE.Plane().setFromNormalAndCoplanarPoint(
    UP, new THREE.Vector3(0, groundLevel(), 0)
  );
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(ground, hit) ? hit : null;
}

function startSceneDrag(event) {
  if (isEditing) return false;
  if (getDotUnderEvent(event)) return false;   // this is a marker drag

  const grab = pickGrabPoint(event);
  if (!grab) return false;

  dragAnchor.copy(grab);
  dragPlane.setFromNormalAndCoplanarPoint(UP, dragAnchor);
  dragging = true;
  dragPointerId = event.pointerId;
  return true;
}

function updateSceneDrag(event) {
  raycaster.setFromCamera(eventToNdc(event), camera);

  // Looking almost along the horizon: the intersection runs off to infinity,
  // and one mouse pixel would throw the camera kilometres. Such frames are skipped.
  if (Math.abs(raycaster.ray.direction.y) < 1e-3) return;
  if (!raycaster.ray.intersectPlane(dragPlane, dragCurrent)) return;

  const dx = dragAnchor.x - dragCurrent.x;
  const dz = dragAnchor.z - dragCurrent.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;

  // guard against a jump right at the horizon
  const limit = sceneScale * 2;
  if (Math.hypot(dx, dz) > limit) return;

  // applyPanSmoothing moves the camera in the render loop, hence the slight lag
  pendingX = dx;
  pendingZ = dz;
}

// Moves the camera horizontally by the given amount.
function panCamera(dx, dz) {
  controls.getPosition(camPos);
  controls.getTarget(camTarget);
  controls.setLookAt(
    camPos.x + dx, camPos.y, camPos.z + dz,
    camTarget.x + dx, camTarget.y, camTarget.z + dz,
    false
  );
}

// Each frame works off part of the residual: the camera follows the cursor with
// a slight lag and keeps gliding after release.
function applyPanSmoothing(dt) {
  if (pendingX === 0 && pendingZ === 0) return;

  if (!dragging && Math.hypot(pendingX, pendingZ) < sceneScale * STOP_EPS) {
    pendingX = pendingZ = 0;
    velX = velZ = 0;
    return;
  }

  // frame-rate-independent exponential approach to the target
  const rate = dragging ? FOLLOW_RATE : GLIDE_RATE;
  const k = 1 - Math.exp(-rate * Math.min(dt, 0.1));   // clamp: dt is huge after the window was minimized

  const stepX = pendingX * k;
  const stepZ = pendingZ * k;

  pendingX -= stepX;
  pendingZ -= stepZ;

  if (dragging && dt > 0) {
    // smoothed velocity: the glide impulse on release comes from it
    velX = velX * 0.7 + (stepX / dt) * 0.3;
    velZ = velZ * 0.7 + (stepZ / dt) * 0.3;
  }

  if (stepX || stepZ) panCamera(stepX, stepZ);
}

function endSceneDrag(withGlide = true) {
  dragging = false;
  dragPointerId = null;

  if (withGlide) {
    // the remaining velocity becomes the distance the camera still travels.
    // The impulse is one-off: adding velocity every frame would stretch
    // the glide over dozens of steps instead of "a little extra".
    pendingX += velX * GLIDE_TIME;
    pendingZ += velZ * GLIDE_TIME;
  } else {
    velX = velZ = 0;
  }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 0) {
    if (startSceneDrag(e)) {
      renderer.domElement.style.cursor = measuring ? 'crosshair' : 'grabbing';
      renderer.domElement.setPointerCapture(e.pointerId);
    }
    return;
  }

  // Orbit around the point under the cursor, not the centre of the whole model:
  // otherwise on a long asset the orbit carries the camera off somewhere.
  if (e.button === 2) {
    const p = getPointOnModel(e);
    if (p) controls.setOrbitPoint(p.x, p.y, p.z);
  }
});

window.addEventListener('pointermove', (e) => {
  if (dragging && e.pointerId === dragPointerId) updateSceneDrag(e);
});

window.addEventListener('pointerup', (e) => {
  if (dragging && e.pointerId === dragPointerId) {
    endSceneDrag();
    renderer.domElement.style.cursor = measuring ? 'crosshair' : 'grab';
  }
});

window.addEventListener('pointercancel', () => {
  if (dragging) endSceneDrag(false);
});

// Double click on the model: fly towards that point, approaching the surface.
// The camera used to only move the orbit centre to the point and stay at
// the same height: on a 20 km section that was "move", not "fly closer".
// Now the camera flies along the line of sight and cuts the distance to
// the point by FLY_FACTOR; each further double click gets closer still.
// Disabled while measuring: there a double click just places two points.
const FLY_FACTOR = 0.3;
const _flyDir = new THREE.Vector3();

renderer.domElement.addEventListener('dblclick', (e) => {
  if (measuring) return;
  const p = getPointOnModel(e);
  if (!p) return;

  const dist = camera.position.distanceTo(p);
  // never closer than this: ~0.5 m on small models, ~2 m on a 20 km section
  const minDist = Math.max(sceneScale * 1e-4, 0.5);
  const target = Math.max(dist * FLY_FACTOR, minDist);
  if (!Number.isFinite(dist) || dist <= minDist * 1.01) {
    controls.moveTo(p.x, p.y, p.z, true);   // already close: just centre it
    return;
  }

  _flyDir.subVectors(camera.position, p).normalize();
  // setOrbitPoint (orbit around the cursor) shifts focalOffset; reset it,
  // otherwise the camera arrives off to the side
  controls.setFocalOffset(0, 0, 0, true);
  controls.setLookAt(
    p.x + _flyDir.x * target, p.y + _flyDir.y * target, p.z + _flyDir.z * target,
    p.x, p.y, p.z,
    true
  );
});

function niceStep(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = value / Math.pow(10, exp);
  let nice;
  if (base < 1.5) nice = 1;
  else if (base < 3.5) nice = 2;
  else if (base < 7.5) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

function rebuildGrid(box) {
  if (gridHelper) {
    scene.remove(gridHelper);
    gridHelper.geometry.dispose();
    gridHelper.material.dispose();
    gridHelper = null;
  }

  const width = box.max.x - box.min.x;
  const depth = box.max.z - box.min.z;
  const long = Math.max(width, depth);
  const short = Math.max(Math.min(width, depth), long * 0.02);
  if (!Number.isFinite(long) || long <= 0) return;

  // The step used to depend only on the long side, so a long asset
  // got only one or two lines across and the grid was unreadable. Take
  // the smaller of the two: not too dense along, not empty across.
  let spacing = Math.min(niceStep(long / 40), niceStep(short / 4));

  // Guard against freezing: on degenerate extents the step could be
  // so small that there would be millions of cells.
  const MAX_CELLS = 200000;
  while ((width / spacing + 3) * (depth / spacing + 3) > MAX_CELLS) spacing = niceStep(spacing * 2.01);

  // The grid is drawn only where there are objects. It used to fill the whole
  // bounding rectangle plus 20%; for a road running diagonally or in an
  // arc that meant kilometres of emptiness. Now we mark the cells that
  // contain vertices of visible models (thinned out if there are millions),
  // add one cell of margin around them and draw only their borders.
  const occupied = new Set();
  const cellKey = (i, j) => i + ',' + j;
  const mark = (x, z) => occupied.add(cellKey(Math.floor(x / spacing), Math.floor(z / spacing)));

  const sources = [];
  let totalVerts = 0;
  for (const { object } of models.values()) {
    if (!object.visible) continue;
    object.traverse((o) => {
      if (!(o.isMesh || o.isLine || o.isPoints) || !o.geometry || !o.geometry.attributes.position) return;
      if (!isPickable(o)) return;   // skip hidden DXF layers and the like
      sources.push(o);
      totalVerts += o.geometry.attributes.position.count;
    });
  }
  const stride = Math.max(1, Math.floor(totalVerts / 400000));
  for (const o of sources) {
    const a = o.geometry.attributes.position.array;
    const e = o.matrixWorld.elements;
    const n = o.geometry.attributes.position.count;
    const wx = (k) => e[0] * a[k] + e[4] * a[k + 1] + e[8] * a[k + 2] + e[12];
    const wz = (k) => e[2] * a[k] + e[6] * a[k + 1] + e[10] * a[k + 2] + e[14];
    for (let v = 0; v < n; v += stride) mark(wx(v * 3), wz(v * 3));
    // large triangles (bridge decks, drawing faces): there are few vertices and
    // vertices alone are not enough, so mark everything the triangle covers
    if (o.isMesh && !o.geometry.index && n <= 900000) {
      for (let v = 0; v + 2 < n; v += 3) {
        const xa = wx(v * 3), xb = wx(v * 3 + 3), xc = wx(v * 3 + 6);
        const za = wz(v * 3), zb = wz(v * 3 + 3), zc = wz(v * 3 + 6);
        const i0 = Math.floor(Math.min(xa, xb, xc) / spacing), i1 = Math.floor(Math.max(xa, xb, xc) / spacing);
        const j0 = Math.floor(Math.min(za, zb, zc) / spacing), j1 = Math.floor(Math.max(za, zb, zc) / spacing);
        if (i0 === i1 && j0 === j1) continue;          // small: already marked by its vertices
        if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) continue;
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) occupied.add(cellKey(i, j));
      }
    }
    // long drawing segments: also mark between the ends, otherwise a straight
    // kilometre-long line would give two cells at the ends and a hole in between
    if (o.isLineSegments && n < 400000) {
      for (let v = 0; v + 1 < n; v += 2) {
        const x0 = wx(v * 3), z0 = wz(v * 3), x1 = wx(v * 3 + 3), z1 = wz(v * 3 + 3);
        const steps = Math.floor(Math.hypot(x1 - x0, z1 - z0) / (spacing / 2));
        for (let s = 1; s < steps; s++) mark(x0 + (x1 - x0) * s / steps, z0 + (z1 - z0) * s / steps);
      }
    }
  }
  if (occupied.size === 0) return;

  // one cell of margin around objects
  const cells = new Set();
  for (const k of occupied) {
    const [i, j] = k.split(',').map(Number);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) cells.add(cellKey(i + di, j + dj));
  }

  // cell borders; adjacent segments on one line are merged into one
  const hEdges = new Map();   // line z = j·step -> cell indices along x
  const vEdges = new Map();   // line x = i·step -> cell indices along z
  const addTo = (map, line, idx) => { let s = map.get(line); if (!s) map.set(line, (s = new Set())); s.add(idx); };
  for (const k of cells) {
    const [i, j] = k.split(',').map(Number);
    addTo(hEdges, j, i); addTo(hEdges, j + 1, i);
    addTo(vEdges, i, j); addTo(vEdges, i + 1, j);
  }

  const y = box.min.y;
  const points = [];
  const runs = (set, emit) => {
    const idx = [...set].sort((p, q) => p - q);
    let start = idx[0], prev = idx[0];
    for (let t = 1; t <= idx.length; t++) {
      if (t < idx.length && idx[t] === prev + 1) { prev = idx[t]; continue; }
      emit(start, prev + 1);
      if (t < idx.length) start = prev = idx[t];
    }
  };
  for (const [j, set] of hEdges) runs(set, (i0, i1) => points.push(i0 * spacing, y, j * spacing, i1 * spacing, y, j * spacing));
  for (const [i, set] of vEdges) runs(set, (j0, j1) => points.push(i * spacing, y, j0 * spacing, i * spacing, y, j1 * spacing));

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const mat = new THREE.LineBasicMaterial({
    color: isLightTheme ? 0x9c7a4e : 0x4a3520,
    transparent: true,
    opacity: 0.3,
  });

  gridHelper = new THREE.LineSegments(geom, mat);
  gridHelper.userData.isMeasureHelper = true;
  scene.add(gridHelper);
}

// Combined bbox of all visible models, or null if there is nothing to show.
// Stored boxes are merged instead of recomputing with setFromObject:
// after fixRaycastBounds the geometries report infinite bounds.
function visibleBox() {
  const box = new THREE.Box3();
  let any = false;
  for (const entry of models.values()) {
    if (!entry.object.visible || !entry.box || entry.box.isEmpty()) continue;
    box.union(entry.box);
    any = true;
  }
  return any && !box.isEmpty() ? box : null;
}

// fit: whether to fit the camera to what remains visible.
// smooth: animated (layer toggle) or instant (first load).
function refreshScene(fit, smooth = false) {
  const box = visibleBox();
  if (!box) {
    if (gridHelper) {
      scene.remove(gridHelper);
      gridHelper.geometry.dispose();
      gridHelper.material.dispose();
      gridHelper = null;
    }
    return;
  }
  applyWorldScale(box);
  updateCameraRange(box);
  updateSunShadow(box);
  rebuildGrid(box);
  if (!fit) return;

  // setOrbitPoint (orbit around the cursor) shifts focalOffset. If it is not
  // cleared, the fit ends up offset from the screen centre.
  controls.setFocalOffset(0, 0, 0, false);

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  // broken geometry gives NaN/Infinity: fitToSphere would send the camera nowhere
  // and only the background would remain in view
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
    console.warn('Invalid model extent, skipping camera fit');
    return;
  }
  controls.fitToSphere(sphere, smooth);
}

// Clipping planes from the model extent.
//
// far must cover the whole model with room for the camera to pull back; near must be
// small enough to get up close, but not so small as to
// ruin depth buffer precision: the far/near ratio is what controls it.
// With logarithmicDepthBuffer the far/near ratio barely affects precision.
function updateCameraRange(box) {
  const diagonal = box.getSize(new THREE.Vector3()).length();
  if (!Number.isFinite(diagonal) || diagonal <= 0) return;

  // near used to be diagonal * 0.0005: on a 20 km road section that is 10 m,
  // and everything closer than 10 m was clipped when zooming in. With a logarithmic
  // depth buffer near can be tiny: a millionth of the diagonal
  // (2 cm on 20 km), but no more than 5 cm and no less than 0.1 mm.
  camera.near = Math.min(Math.max(diagonal * 1e-6, 1e-4), 0.05);
  camera.far = diagonal * 50;
  camera.updateProjectionMatrix();

  // The background sphere must sit between near and far, otherwise it either vanishes
  // or gets clipped. Its geometry has radius 10000, so it is scaled.
  background.scale.setScalar((camera.far * 0.4) / 10000);
}

// The shadow camera is orthographic and by default covers a few units
// around the origin. On any real model it missed entirely: no shadows
// appeared, yet the 2048x2048 map was still recomputed every frame.
// It is fitted to the extent and the sun is moved away by the same amount.
const SHADOW_MAX_TEXEL = 0.25;   // metres per shadow map texel

function updateSunShadow(box) {
  const sun = lights.sun;
  if (!sun) return;

  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  if (!Number.isFinite(radius) || radius <= 0) return;

  sun.target.position.copy(center);
  sun.target.updateMatrixWorld();

  // keep the light direction, change only the distance
  const dir = sunDirection.clone().normalize().multiplyScalar(radius * 2.5);
  sun.position.copy(center).add(dir);

  const cam = sun.shadow.camera;
  cam.left = -radius * 1.1;
  cam.right = radius * 1.1;
  cam.top = radius * 1.1;
  cam.bottom = -radius * 1.1;
  cam.near = radius * 0.05;
  cam.far = radius * 6;
  cam.updateProjectionMatrix();

  // the bias is also proportional to the scene, otherwise large models show
  // striped self-shadowing
  sun.shadow.bias = -0.0005 * radius * 0.05;
  sun.shadow.normalBias = radius * 0.002;

  // There is one shadow map for the whole scene. On a 20 km road section one texel
  // is 10–20 m: shadows come out as blurry blobs, and on flat asphalt
  // they produce flickering self-shadowing stripes. No benefit, and it is
  // one more pass over the whole scene. So shadows are enabled only while the scene
  // is small and a texel is no larger than SHADOW_MAX_TEXEL.
  const texel = (2.2 * radius) / sun.shadow.mapSize.width;
  sun.castShadow = texel <= SHADOW_MAX_TEXEL;

  // the point fill light reaches a fixed 30 units, which misses too
  if (lights.front) {
    lights.front.distance = radius * 4;
    lights.front.position.copy(center).add(frontDirection.clone().multiplyScalar(radius * 1.5));
  }
}

// Recomputes everything that must scale with the scene.
function applyWorldScale(box) {
  const diagonal = box.getSize(new THREE.Vector3()).length();
  if (!Number.isFinite(diagonal) || diagonal <= 0) return;
  if (Math.abs(diagonal - sceneScale) / sceneScale < 0.01) return;   // insignificant change

  sceneScale = diagonal;

  raycaster.params.Points.threshold = sceneScale * SCALE.pick;
  raycaster.params.Line = { threshold: sceneScale * SCALE.pick };

  const pointSize = sceneScale * SCALE.point;
  for (const entry of models.values()) {
    entry.object.traverse((c) => {
      if (c.isPoints && c.material) c.material.size = pointSize;
    });
  }

  const r = dotRadius();
  for (const m of measurements) {
    m.dots.forEach((d) => d.scale.setScalar(r));
    m.updateLineTransform();
  }
  currentDots.forEach((d) => d.scale.setScalar(r));
}

// Places a model relative to the shared scene origin.
function placeAtOrigin(object, info) {
  const origin = Array.isArray(info.origin) ? info.origin : [0, 0, 0];

  if (!sceneOrigin) {
    sceneOrigin = new THREE.Vector3(origin[0], origin[1], origin[2]);
  }

  object.position.set(
    origin[0] - sceneOrigin.x,
    origin[1] - sceneOrigin.y,
    origin[2] - sceneOrigin.z
  );
}

function disposeObject(object) {
  object.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (!c.material) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    mats.forEach((m) => {
      if (m.map) m.map.dispose();
      m.dispose();
    });
  });
}

// Huge models: three culls them by boundingSphere before testing
// triangles, so measurement clicks miss. The limit is removed.
// Except for IfcOpenShell meshes: their bounds are exact, and "infinite" ones
// made every click test all 10+ million triangles in the scene,
// which caused the hiccups at the start of every move.
function fixRaycastBounds(object) {
  object.traverse((child) => {
    if (child.isMesh && child.geometry && !child.userData.exactBounds) {
      child.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
      child.geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(-Infinity, -Infinity, -Infinity),
        new THREE.Vector3(Infinity, Infinity, Infinity)
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Colour: sRGB -> linear
//
// ColorManagement.enabled = true means the working colour space is linear.
// Everything coming from files (Kd in .mtl, point RGB from LAS) is sRGB,
// so it has to be converted by hand, otherwise colours come out washed out.
// ---------------------------------------------------------------------------

function srgbToLinear(c) {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_LUT[i] = srgbToLinear(i / 255);

// ---------------------------------------------------------------------------
// .mtl parsing
//
// OBJLoader never reads .mtl itself. The full MTLLoader is not used:
// only Kd / Ka / Ks / Ns / d / map_Kd are needed, and this means fewer dependencies.
// Files are fetched through the /asset/ route (see viewer.py).
// ---------------------------------------------------------------------------

async function loadMtlMaterials(modelId, mtlName) {
  const assetPath = `/asset/${modelId}/`;
  let text;
  try {
    const res = await fetch(assetPath + encodeURIComponent(mtlName));
    if (!res.ok) return null;
    text = await res.text();
  } catch (err) {
    console.warn('Could not read .mtl:', err);
    return null;
  }

  const texLoader = new THREE.TextureLoader().setPath(assetPath);
  const materials = {};
  let cur = null;

  const loadTexture = (value) => {
    // map_Kd may carry options like "-s 1 1 1 texture.png"; take the last token
    const file = value.split(/\s+/).pop();
    const tex = texLoader.load(encodeURIComponent(file));
    tex.encoding = THREE.sRGBEncoding;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const value = sp < 0 ? '' : line.slice(sp + 1).trim();

    if (key === 'newmtl') {
      cur = new THREE.MeshStandardMaterial({ name: value, roughness: 0.7, metalness: 0.0 });
      materials[value] = cur;
      continue;
    }
    if (!cur) continue;

    const nums = () => value.split(/\s+/).map(Number);

    switch (key) {
      case 'kd': {
        const [r, g, b] = nums();
        cur.color.setRGB(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
        break;
      }
      case 'ke': {
        const [r, g, b] = nums();
        cur.emissive.setRGB(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
        break;
      }
      case 'ns': {
        const ns = Number(value);
        // exporters often inflate Ns in .mtl; do not let it turn surfaces into mirrors
        if (Number.isFinite(ns)) cur.roughness = Math.min(1, Math.max(MIN_ROUGHNESS, Math.sqrt(2 / (ns + 2))));
        break;
      }
      case 'd': {
        const d = Number(value);
        if (Number.isFinite(d) && d < 1) { cur.opacity = d; cur.transparent = true; }
        break;
      }
      case 'tr': {
        const tr = Number(value);
        if (Number.isFinite(tr) && tr > 0) { cur.opacity = 1 - tr; cur.transparent = true; }
        break;
      }
      case 'map_kd':
        cur.map = loadTexture(value);
        break;
      case 'map_bump':
      case 'bump':
        cur.bumpMap = texLoader.load(encodeURIComponent(value.split(/\s+/).pop()));
        break;
      case 'map_d':
        cur.alphaMap = texLoader.load(encodeURIComponent(value.split(/\s+/).pop()));
        cur.transparent = true;
        break;
    }
  }

  return Object.keys(materials).length ? materials : null;
}

function applyObjMaterials(obj, mtlMaterials) {
  obj.traverse((c) => {
    if (!c.isMesh) return;

    c.castShadow = true;
    c.receiveShadow = true;

    // 1. Vertex colours are the most reliable source when present
    if (c.geometry.attributes.color) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => { m.vertexColors = true; m.needsUpdate = true; });
      return;
    }

    // 2. Material from .mtl by name (OBJLoader puts it in material.name)
    if (mtlMaterials) {
      const pick = (m) => (m && mtlMaterials[m.name]) || null;
      if (Array.isArray(c.material)) {
        const replaced = c.material.map((m) => pick(m) || m);
        if (replaced.some((m, i) => m !== c.material[i])) c.material = replaced;
        return;
      }
      const found = pick(c.material);
      if (found) { c.material = found; return; }
    }

    // 3. Fallback, only when there really is no material (white, no texture).
    //    An unconditional replacement here is what used to make every model grey.
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    const blank = mats.every((m) => !m.map && m.color && m.color.getHex() === 0xffffff);
    if (blank) {
      c.material = new THREE.MeshStandardMaterial({
        color: 0xcccccc,
        roughness: MATTE_ROUGHNESS,
        metalness: 0,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// IFC length units
//
// Measurement labels always say "m". If a file is authored in
// millimetres, the number is a thousand times larger, and the picture gives
// no hint, because the camera fits the model to the frame anyway.
//
// Diagnostics only for now: the detected unit and extent are logged to the console (F12).
// Rescaling geometry blindly is unsafe: different web-ifc builds behave
// differently, and double scaling would be worse than the original error.
// ---------------------------------------------------------------------------

const SI_PREFIX = {
  MILLI: 0.001, CENTI: 0.01, DECI: 0.1, DECA: 10, HECTO: 100, KILO: 1000,
};

async function reportIfcUnits(model, info) {
  const manager = ifcLoader.ifcManager;
  if (!manager || typeof WebIFC === 'undefined' || !WebIFC.IFCUNITASSIGNMENT) return;

  try {
    const assignments = await manager.getAllItemsOfType(
      model.modelID, WebIFC.IFCUNITASSIGNMENT, true
    );

    for (const assignment of assignments || []) {
      for (const ref of assignment.Units || []) {
        const unit = await manager.getItemProperties(model.modelID, ref.value);
        if (!unit || unit.UnitType?.value !== 'LENGTHUNIT') continue;

        const name = unit.Name?.value;
        const prefix = unit.Prefix?.value;
        const scale = prefix ? (SI_PREFIX[prefix] ?? 1) : 1;

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());

        console.log(
          `[units] ${info.name}: ${prefix || ''}${name || 'unknown'}` +
          ` (to metre x${scale}); scene extent ` +
          `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)}`
        );
        return;
      }
    }
    console.log(`[units] ${info.name}: IfcUnitAssignment not found`);
  } catch (err) {
    console.warn('[units] could not read:', err);
  }
}

const ifcLoader = new IFCLoader();
// Depending on the web-ifc-three version, setWasmPath may or may not return a promise.
// Promise.resolve hides the difference: without it .then/.finally fail on undefined.
const ifcReady = Promise.resolve(ifcLoader.ifcManager.setWasmPath('./', true));

// Paths to .mtl and textures depend on the model: /asset/<id>/<file>
async function loadMtlFor(info) {
  return info.mtl ? loadMtlMaterials(info.id, info.mtl) : null;
}

// ---------------------------------------------------------------------------
// IFC from IfcOpenShell (see ifc_to_binary in viewer.py)
//
// Format: "IFCM", uint32 version, uint32 group count; per group:
// float32 r, g, b, opacity (sRGB), uint32 vertex count, float32 xyz.
// Non-indexed triangles, already in Three.js axes and shifted by info.origin.
//
// Normals are not stored: flatShading computes them per face in the shader. On large
// files this matters: for 10 million triangles of guardrails a normal attribute
// would take another ~400 MB. For the same reason positions are a view on the response buffer,
// not a copy.
// ---------------------------------------------------------------------------

// Flicker on the road. Markings, islands and flat symbols lie exactly
// in the pavement (DTM) plane. Two coplanar surfaces with different
// triangulation are drawn interleaved by the GPU: a "zebra" that shimmers
// with every camera move, especially on weak GPUs.
// Layers that are entirely flat (almost all faces lie along the pavement)
// are lifted: narrow strips (markings) by 2 cm, solid flat sheets
// (e.g. a separate pavement layer) by 1 cm, so markings stay above
// them too. Terrain with slopes is left alone. Nothing changes in plan
// or to the eye, and the fight for pixels is gone.
const OVERLAY_LIFT_STRIPS = 0.02;
const OVERLAY_LIFT_SHEETS = 0.01;
const OVERLAY_MAX_TRIS = 2000000;

// 0: not a flat layer; otherwise how much to lift it
function flatOverlayLift(positions) {
  const n = positions.length / 9;
  if (n === 0 || n > OVERLAY_MAX_TRIS) return 0;
  let flat = 0, total = 0, widthSum = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = positions[o + 3] - positions[o], ay = positions[o + 4] - positions[o + 1], az = positions[o + 5] - positions[o + 2];
    const bx = positions[o + 6] - positions[o], by = positions[o + 7] - positions[o + 1], bz = positions[o + 8] - positions[o + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const area = Math.sqrt(cx * cx + cy * cy + cz * cz);
    total += area;
    if (area > 0 && Math.abs(cy) / area > 0.98) flat += area;   // slope up to ~11°
    // triangle "width" across its long side, area-weighted
    const longest = Math.sqrt(Math.max(ax * ax + ay * ay + az * az, bx * bx + by * by + bz * bz,
      (bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az)));
    if (longest > 0) widthSum += area * (area / longest);
  }
  if (!(total > 0) || flat / total < 0.995) return 0;
  return widthSum / total < 0.5 ? OVERLAY_LIFT_STRIPS : OVERLAY_LIFT_SHEETS;
}

function parseIfcMesh(buf) {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'IFCM') throw new Error('Unknown IFC mesh format');

  let offset = 8;   // magic + version
  const groupCount = view.getUint32(offset, true); offset += 4;
  const group = new THREE.Group();

  for (let i = 0; i < groupCount; i++) {
    const r = view.getFloat32(offset, true);
    const g = view.getFloat32(offset + 4, true);
    const b = view.getFloat32(offset + 8, true);
    const opacity = view.getFloat32(offset + 12, true);
    const count = view.getUint32(offset + 16, true);
    offset += 20;

    const positions = new Float32Array(buf, offset, count * 3);
    offset += count * 12;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Real tile bounds: three.js uses them to skip tiles that the click ray
    // missed or that are off screen (see tile_ifcm in viewer.py)
    geom.computeBoundingBox();
    geom.computeBoundingSphere();

    const transparent = opacity < 0.999;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)),
      // Matte material: road, concrete and sign metal in IFC are untextured
      // colours, and with roughness 0.6 / metalness 0.1 large asphalt triangles
      // gave sharp, blade-like highlights. The highlight also jumped
      // from face to face because of flat normals.
      roughness: MATTE_ROUGHNESS,
      metalness: 0,
      flatShading: true,
      // IFC has plenty of open surfaces (pavement, slopes);
      // a one-sided material would show them full of holes
      side: THREE.DoubleSide,
      transparent,
      opacity,
      depthWrite: !transparent,
    });

    const mesh = new THREE.Mesh(geom, material);
    mesh.castShadow = !transparent;
    mesh.receiveShadow = true;
    mesh.userData.exactBounds = true;   // bounds are not "infinite", see fixRaycastBounds
    const lift = flatOverlayLift(positions);
    if (lift > 0) {
      mesh.position.y += lift;
      mesh.castShadow = false;   // flat paint has nothing to cast
      mesh.userData.flatOverlay = lift;   // lift amount, needed for height measurement
    }
    group.add(mesh);
  }

  return group;
}

// ---------------------------------------------------------------------------
// DXF (see dxf_to_binary in viewer.py)
//
// Each drawing layer is its own group: in the Layers panel a DXF expands into
// a list of its layers with checkboxes. Segments are LineSegments, faces are a mesh.
// A flat drawing (Z = 0, an ordinary plan) is drawn on top of the models at their
// mean height: otherwise it would end up hundreds of metres below the terrain and
// be hidden under it. A 3D drawing stays at its own elevations.
// ---------------------------------------------------------------------------

function parseDxf(buf) {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'DXFL') throw new Error('Unknown DXF stream format');
  const flags = view.getUint32(8, true);
  const layerCount = view.getUint32(12, true);
  const flat = (flags & 1) === 1;
  let offset = 16;
  const decoder = new TextDecoder('utf-8');

  const root = new THREE.Group();
  root.userData.flat = flat;
  root.userData.layers = [];

  for (let i = 0; i < layerCount; i++) {
    const nameLen = view.getUint32(offset, true); offset += 4;
    const name = decoder.decode(new Uint8Array(buf, offset, nameLen));
    offset += nameLen + ((4 - (nameLen % 4)) % 4);
    const layerFlags = view.getUint32(offset, true);
    const groupCount = view.getUint32(offset + 4, true);
    offset += 8;

    const layerGroup = new THREE.Group();
    layerGroup.name = name;
    layerGroup.visible = (layerFlags & 1) === 0;   // layers switched off in the DXF stay hidden

    for (let g = 0; g < groupCount; g++) {
      const kind = view.getUint32(offset, true);
      const r = view.getFloat32(offset + 4, true);
      const gg = view.getFloat32(offset + 8, true);
      const b = view.getFloat32(offset + 12, true);
      const count = view.getUint32(offset + 20, true);
      offset += 24;
      const positions = new Float32Array(buf, offset, count * 3);
      offset += count * 12;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.computeBoundingBox();
      geom.computeBoundingSphere();
      const color = new THREE.Color(srgbToLinear(r), srgbToLinear(gg), srgbToLinear(b));

      let obj;
      if (kind === 0) {
        obj = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
          color, toneMapped: false, depthTest: !flat,
        }));
      } else {
        obj = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
          color, roughness: MATTE_ROUGHNESS, metalness: 0, flatShading: true, side: THREE.DoubleSide,
          transparent: flat, opacity: flat ? 0.5 : 1, depthTest: !flat, depthWrite: !flat,
        }));
        obj.userData.exactBounds = true;
        obj.castShadow = !flat;
        obj.receiveShadow = true;
      }
      if (flat) obj.renderOrder = 900;   // plan drawn on top of the models
      layerGroup.add(obj);
    }
    root.add(layerGroup);
    root.userData.layers.push(layerGroup);
  }
  return root;
}

// Flat drawings go to the mean height of the other models (they are drawn
// on top anyway; the height keeps the plan from sliding sideways when orbiting).
function levelFlatModels() {
  let lo = Infinity, hi = -Infinity;
  for (const entry of models.values()) {
    if (entry.object.userData.flat || !entry.box || entry.box.isEmpty()) continue;
    lo = Math.min(lo, entry.box.min.y);
    hi = Math.max(hi, entry.box.max.y);
  }
  if (!Number.isFinite(lo)) return;
  const y = (lo + hi) / 2;
  for (const entry of models.values()) {
    if (!entry.object.userData.flat) continue;
    if (Math.abs(entry.object.position.y - y) < 1e-6) continue;
    entry.object.position.y = y;
    entry.object.updateMatrixWorld(true);
    entry.box = new THREE.Box3().setFromObject(entry.object);
  }
  invalidateScene();
}

// The ray hit threshold for lines is about 6 screen pixels, not a fraction
// of the whole scene (on a 20 km section that would be tens of metres, and DXF lines
// would intercept every click).
const _pickTarget = new THREE.Vector3();
function updatePickThresholds() {
  controls.getTarget(_pickTarget);
  raycaster.params.Line = { threshold: Math.max(1e-4, worldPerPixel(_pickTarget) * 6) };
}

function loadOne(info) {
  const url = `/model?id=${info.id}&t=${Date.now()}`;

  // IFC already parsed by IfcOpenShell on the Python side (info.mesh). Without
  // ifcopenshell Python sends the raw file and it goes through web-ifc below.
  if (info.kind === 'ifc' && info.mesh) {
    return fetch(url).then((r) => r.arrayBuffer()).then(parseIfcMesh);
  }

  if (info.kind === 'ifc') {
    return ifcReady.then(() => new Promise((resolve, reject) => {
      ifcLoader.load(
        url,
        (model) => { reportIfcUnits(model, info); resolve(model); },
        undefined,
        reject
      );
    }));
  }

  if (info.kind === 'dxf') {
    return fetch(url).then((r) => r.arrayBuffer()).then(parseDxf);
  }

  if (info.kind === 'obj') {
    return loadMtlFor(info).then((mtlMaterials) => new Promise((resolve, reject) => {
      new OBJLoader().load(
        url,
        (obj) => { applyObjMaterials(obj, mtlMaterials); resolve(obj); },
        undefined,
        reject
      );
    }));
  }

  if (info.kind === 'points') {
    return fetch(url).then((r) => r.arrayBuffer()).then((buf) => {
      const view = new DataView(buf);

      let offset = 0;
      const count = view.getUint32(offset, true); offset += 4;
      const hasColor = view.getUint8(offset); offset += 4;

      const positions = new Float32Array(buf.slice(offset, offset + count * 3 * 4));
      offset += count * 3 * 4;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      let material;
      if (hasColor) {
        const colorsU8 = new Uint8Array(buf.slice(offset, offset + count * 3));
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < colorsU8.length; i++) colors[i] = SRGB_LUT[colorsU8[i]];
        geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        material = new THREE.PointsMaterial({
          size: sceneScale * SCALE.point, vertexColors: true, sizeAttenuation: true,
        });
      } else {
        material = new THREE.PointsMaterial({
          size: sceneScale * SCALE.point, color: 0x3b82f6, sizeAttenuation: true,
        });
      }

      return new THREE.Points(geom, material);
    });
  }

  return Promise.reject(new Error('Unsupported format: ' + info.kind));
}

// Syncs the scene with the list from Python: loads new models, drops removed ones.
// Called from Python once the files have been read (see load_files).
async function syncModels() {
  let listing;
  try {
    listing = await (await fetch('/models')).json();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Could not get the model list';
    return;
  }

  const alive = new Set(listing.map((info) => info.id));
  for (const [id, entry] of [...models]) {
    if (!alive.has(id)) {
      scene.remove(entry.object);
      disposeObject(entry.object);
      models.delete(id);
    }
  }

  // the scene is empty: the next model sets the origin again
  if (models.size === 0) sceneOrigin = null;

  const fresh = listing.filter((info) => !models.has(info.id) && !loadingIds.has(info.id));
  if (fresh.length) statusEl.textContent = 'Loading...';

  for (const info of fresh) {
    loadingIds.add(info.id);
    try {
      const object = await loadOne(info);
      // the model may have been removed from the panel while loading
      if (!models.has(info.id) && (await isStillListed(info.id))) {
        object.userData.modelId = info.id;
        placeAtOrigin(object, info);
        scene.add(object);
        // ORDER MATTERS: fixRaycastBounds makes boundingBox infinite,
        // after it setFromObject returns Infinity. Compute the extent before it
        // and keep it: the model does not move, so there is nothing to recompute.
        const box = new THREE.Box3().setFromObject(object);
        fixRaycastBounds(object);
        models.set(info.id, { info, object, box });
      } else {
        disposeObject(object);
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = `Failed to load: ${info.name}`;
    } finally {
      loadingIds.delete(info.id);
    }
  }

  levelFlatModels();

  // fitting the camera only makes sense when something new appeared in the scene
  refreshScene(fresh.length > 0);
  renderModelList();
  updateStatus();
  if (bootDone) hideOverlay();
}

async function isStillListed(id) {
  try {
    const listing = await (await fetch('/models')).json();
    return listing.some((info) => info.id === id);
  } catch {
    return true;
  }
}

function updateStatus() {
  const total = models.size;
  const shown = [...models.values()].filter((e) => e.object.visible).length;

  // The bottom status line is only needed while nothing is loaded (and for loading
  // and error messages). The number of visible layers is now in the panel title.
  statusEl.textContent = total === 0 ? 'No file loaded. Click "Open file"' : '';

  const fileNameEl = document.getElementById('file-name');
  if (fileNameEl) fileNameEl.textContent = '';

  const countEl = document.getElementById('layers-count');
  if (countEl) {
    countEl.textContent = total ? `${shown} of ${total} shown` : '';
    countEl.classList.toggle('partial', shown < total);
  }
}

// ---------------------------------------------------------------------------
// Model list panel
// ---------------------------------------------------------------------------

function setModelVisible(id, visible) {
  const entry = models.get(id);
  if (!entry) return;
  entry.object.visible = visible;
  // The view is left alone: the camera stays put, and so do the grid and scene extent;
  // otherwise the picture would jump with every checkbox click.
  // Redraw and recompute shadows (a hidden layer no longer casts a shadow).
  invalidateScene();
  updateStatus();
}

function removeModel(id) {
  const entry = models.get(id);
  if (!entry) return;

  scene.remove(entry.object);
  disposeObject(entry.object);
  models.delete(id);
  if (models.size === 0) sceneOrigin = null;

  if (window.pyBackend && window.pyBackend.onModelRemove) {
    window.pyBackend.onModelRemove(id);
  }

  // the camera is not moved, same as when a layer is hidden
  refreshScene(false);
  renderModelList();
  updateStatus();
}

// Top view: the camera directly above the centre of the visible layers, north up,
// the whole plan in frame. Button in the top bar.
function topView() {
  const box = visibleBox();
  if (!box) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // distance at which the whole plan (X × Z) fits in the frame, plus a 10% margin
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const fitW = size.x / 2 / (tanHalf * camera.aspect);
  const fitH = size.z / 2 / tanHalf;
  const dist = Math.max(fitW, fitH, 1) * 1.1 + size.y / 2;

  controls.setFocalOffset(0, 0, 0, true);
  // a tiny shift south (+Z): a strictly vertical view does not define where
  // the screen "up" points; this way north (−Z, i.e. +Y in file coordinates) is at the top
  controls.setLookAt(
    center.x, center.y + dist, center.z + dist * 1e-4,
    center.x, center.y, center.z,
    true
  );
}

function focusModel(id) {
  const entry = models.get(id);
  if (!entry || !entry.object.visible || !entry.box || entry.box.isEmpty()) return;
  controls.setFocalOffset(0, 0, 0, false);
  controls.fitToSphere(entry.box.getBoundingSphere(new THREE.Sphere()), true);
}

const KIND_LABEL = { ifc: 'IFC', obj: 'OBJ', points: 'Points', dxf: 'DXF' };

// which DXFs have their layer list expanded
const expandedLayers = new Set();

function renderModelList() {
  const panel = document.getElementById('model-panel');
  const list = document.getElementById('model-list');
  if (!panel || !list) return;

  panel.classList.toggle('hidden', models.size === 0);
  list.textContent = '';

  for (const { info, object } of models.values()) {
    const row = document.createElement('div');
    row.className = 'model-row';

    const label = document.createElement('label');
    label.className = 'model-toggle';
    label.title = info.name;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = object.visible;
    box.addEventListener('change', () => setModelVisible(info.id, box.checked));

    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = info.name;

    const kind = document.createElement('span');
    kind.className = 'model-kind';
    kind.textContent = KIND_LABEL[info.kind] || info.kind;

    label.append(box, name, kind);

    // double click on a row flies the camera to that model
    label.addEventListener('dblclick', (e) => {
      if (e.target === box) return;
      focusModel(info.id);
    });

    const remove = document.createElement('button');
    remove.className = 'model-remove';
    remove.title = 'Unload';
    remove.textContent = '×';
    remove.addEventListener('click', () => removeModel(info.id));

    const layers = object.userData.layers;
    if (layers && layers.length) {
      // button that expands the drawing's layer list
      const expand = document.createElement('button');
      expand.className = 'model-expand';
      const open = expandedLayers.has(info.id);
      expand.textContent = open ? '▾' : '▸';
      expand.title = open ? 'Hide drawing layers' : `Drawing layers (${layers.length})`;
      expand.addEventListener('click', (e) => {
        e.preventDefault();
        if (expandedLayers.has(info.id)) expandedLayers.delete(info.id);
        else expandedLayers.add(info.id);
        renderModelList();
      });
      row.append(expand, label, remove);
      list.appendChild(row);

      if (open) {
        const sub = document.createElement('div');
        sub.className = 'layer-list';
        for (const layer of layers) {
          const lrow = document.createElement('label');
          lrow.className = 'layer-row';
          lrow.title = layer.name;
          const lbox = document.createElement('input');
          lbox.type = 'checkbox';
          lbox.checked = layer.visible;
          lbox.addEventListener('change', () => {
            layer.visible = lbox.checked;
            invalidateScene();
          });
          const lname = document.createElement('span');
          lname.className = 'layer-name';
          lname.textContent = layer.name;
          lrow.append(lbox, lname);
          sub.appendChild(lrow);
        }
        list.appendChild(sub);
      }
      continue;
    }

    row.append(label, remove);
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Measuring tool
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = sceneScale * SCALE.pick;
raycaster.params.Line = { threshold: sceneScale * SCALE.pick };

let measuring = false;
let measureMode = 'distance';   // 'distance': plain, 'width': lane width, 'height': height
let measurePoints = [];
let currentLine = null;
let currentDots = [];
let isEditing = false;
let editTarget = null;
const measurements = [];

let mouseDownPos = { x: 0, y: 0 };
let contextMenu = null;
let contextMenuTarget = null;
let contextMenuTargetType = null;

const MEASURE_COLOR = 0xff7a1f;   // the same orange as --accent in the UI

// Measurement marker material. toneMapped: false is required: the scene's ACES tone mapping
// bleached the orange to pale beige, and the markers did not match
// the UI accent colour.
function measureMaterial(extra) {
  return new THREE.MeshBasicMaterial(Object.assign({ color: MEASURE_COLOR, toneMapped: false }, extra));
}

function eventToNdc(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
}

// three's Raycaster ignores object.visible, so hidden models
// would keep catching measurement clicks; visibility is checked up the tree by hand.
function isPickable(object) {
  for (let o = object; o; o = o.parent) {
    if (o.visible === false) return false;
    if (o.userData && o.userData.isMeasureHelper) return false;
  }
  return !object.isCSS2DObject;
}

// ---------------------------------------------------------------------------
// Lane width: perpendicular to the marking's centre line
//
// A road marking in IFC is a flat strip 10–20 cm wide (a dashed one consists of
// separate dashes). On click we find its centre line and direction at that spot:
// take the strip boundaries within LANE_R of the click (edges that
// belong to just one triangle); the direction comes from the longest
// of them, the centre line lies midway between the nearest boundaries left and right.
// Tested on IndorCAD markings: widths of 0.10 and 0.20 m are detected exactly,
// direction within a fraction of a degree on straights and curves.
//
// The width is then measured strictly perpendicular to the first line in plan, to the centre
// of the second line (or to any point: a kerb, an edge), so the result does not
// depend on how precisely you clicked.
// ---------------------------------------------------------------------------

const LANE_R = 1.5;               // search radius around the strip, m
const LANE_CELL = 2;              // spatial index cell size, m
const MARK_MAX_WIDTH = 0.7;       // anything wider is not a marking line
const LANE_INDEX_MAX_TRIS = 1500000;

// vertex k (0..2) of triangle t: vertex index in the position buffer
function triVertex(geom, t, k) {
  return geom.index ? geom.index.getX(t * 3 + k) : t * 3 + k;
}

// Plan index of mesh triangles: which triangles fall into which
// 2×2 m cell. Built once on first use.
function laneIndexFor(geom) {
  if (geom.userData.laneIndex !== undefined) return geom.userData.laneIndex;
  const pos = geom.attributes.position;
  const triCount = geom.index ? geom.index.count / 3 : pos.count / 3;
  if (!pos || triCount > LANE_INDEX_MAX_TRIS) {
    geom.userData.laneIndex = null;   // a huge mesh (guardrails, DTM) is not a marking
    return null;
  }
  const cells = new Map();
  for (let t = 0; t < triCount; t++) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = triVertex(geom, t, k);
      const x = pos.getX(v), z = pos.getZ(v);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const i0 = Math.floor(x0 / LANE_CELL), i1 = Math.floor(x1 / LANE_CELL);
    const j0 = Math.floor(z0 / LANE_CELL), j1 = Math.floor(z1 / LANE_CELL);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 2500) continue;   // a giant triangle is not a marking
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = i * 1000003 + j;
        let list = cells.get(key);
        if (!list) cells.set(key, (list = []));
        list.push(t);
      }
    }
  }
  geom.userData.laneIndex = cells;
  return cells;
}

// plan distance from point (px, pz) to a segment
function segDist2D(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 1e-12 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = ax + vx * t - px, dz = az + vz * t - pz;
  return Math.sqrt(dx * dx + dz * dz);
}

// Centre line of the marking under the hit point: { point, dir, width } in world
// coordinates, or null if there is no marking under the cursor.
function markingAxisAt(hit) {
  const obj = hit && hit.object;
  const geom = obj && obj.geometry;
  if (!obj || !obj.isMesh || obj.isInstancedMesh || !geom || !geom.attributes.position || !hit.face) return null;
  const pos = geom.attributes.position;

  // Quick rejection: the triangle under the cursor must be narrow
  // (on asphalt, soil or guardrail posts it is wide or vertical).
  {
    const a = new THREE.Vector3().fromBufferAttribute(pos, hit.face.a);
    const b = new THREE.Vector3().fromBufferAttribute(pos, hit.face.b);
    const c = new THREE.Vector3().fromBufferAttribute(pos, hit.face.c);
    const ab = new THREE.Vector3().subVectors(b, a), ac = new THREE.Vector3().subVectors(c, a);
    const normal = new THREE.Vector3().crossVectors(ab, ac);
    const area2 = normal.length();
    if (area2 < 1e-12 || Math.abs(normal.y) / area2 < 0.7) return null;   // not a horizontal face
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    if (area2 / longest > MARK_MAX_WIDTH * 1.5) return null;
  }

  const cells = laneIndexFor(geom);
  if (!cells) return null;

  const p = obj.worldToLocal(hit.point.clone());
  const px = p.x, pz = p.z;

  // triangles near the click
  const seen = new Set();
  const i0 = Math.floor((px - LANE_R) / LANE_CELL), i1 = Math.floor((px + LANE_R) / LANE_CELL);
  const j0 = Math.floor((pz - LANE_R) / LANE_CELL), j1 = Math.floor((pz + LANE_R) / LANE_CELL);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const list = cells.get(i * 1000003 + j);
      if (list) for (const t of list) seen.add(t);
    }
  }

  // edges of these triangles; a strip boundary is an edge that belongs
  // to exactly one triangle
  const edges = new Map();
  const q = (x) => Math.round(x * 1000);
  for (const t of seen) {
    const vs = [0, 1, 2].map((k) => triVertex(geom, t, k));
    let near = false;
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3];
      if (segDist2D(px, pz, pos.getX(a), pos.getZ(a), pos.getX(b), pos.getZ(b)) < LANE_R) { near = true; break; }
    }
    if (!near) continue;
    for (let k = 0; k < 3; k++) {
      const a = vs[k], b = vs[(k + 1) % 3];
      const ka = q(pos.getX(a)) + ',' + q(pos.getY(a)) + ',' + q(pos.getZ(a));
      const kb = q(pos.getX(b)) + ',' + q(pos.getY(b)) + ',' + q(pos.getZ(b));
      const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      const e = edges.get(key);
      if (e) e.n++;
      else edges.set(key, { n: 1, ax: pos.getX(a), az: pos.getZ(a), bx: pos.getX(b), bz: pos.getZ(b) });
    }
  }

  // direction: principal axis of the orientation tensor of the boundary edges
  // (edge sign does not matter; long edges outweigh short end caps)
  const border = [];
  let sxx = 0, sxz = 0, szz = 0;
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    const vx = e.bx - e.ax, vz = e.bz - e.az;
    const len = Math.hypot(vx, vz);
    if (len < 1e-6) continue;
    if (segDist2D(px, pz, e.ax, e.az, e.bx, e.bz) >= LANE_R) continue;
    const dx = vx / len, dz = vz / len, w = Math.min(len, 2 * LANE_R);
    sxx += w * dx * dx; sxz += w * dx * dz; szz += w * dz * dz;
    border.push({ e, dx, dz });
  }
  if (border.length < 2) return null;
  const tr = sxx + szz;
  const disc = Math.sqrt((sxx - szz) * (sxx - szz) + 4 * sxz * sxz);
  const l1 = (tr + disc) / 2, l2 = (tr - disc) / 2;
  if (l1 <= 1e-9 || l2 / l1 > 0.3) return null;   // not elongated, so not a line
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const dx = Math.cos(ang), dz = Math.sin(ang);
  const nx = -dz, nz = dx;

  // nearest boundaries left and right of the click, using edges along the line
  const along = px * dx + pz * dz;
  let sNeg = -Infinity, sPos = Infinity;
  for (const { e, dx: ex, dz: ez } of border) {
    if (Math.abs(ex * dx + ez * dz) < 0.99) continue;
    const a0 = e.ax * dx + e.az * dz, a1 = e.bx * dx + e.bz * dz;
    if (along < Math.min(a0, a1) - 0.05 || along > Math.max(a0, a1) + 0.05) continue;
    const t = Math.abs(a1 - a0) > 1e-9 ? Math.max(0, Math.min(1, (along - a0) / (a1 - a0))) : 0;
    const qx = e.ax + (e.bx - e.ax) * t, qz = e.az + (e.bz - e.az) * t;
    const s = (qx - px) * nx + (qz - pz) * nz;
    if (s <= 1e-6 && s > sNeg) sNeg = s;
    if (s >= -1e-6 && s < sPos) sPos = s;
  }
  if (!Number.isFinite(sNeg) || !Number.isFinite(sPos)) return null;
  const width = sPos - sNeg;
  if (width < 0.03 || width > MARK_MAX_WIDTH) return null;

  const mid = (sNeg + sPos) / 2;
  const axisLocal = new THREE.Vector3(px + nx * mid, p.y, pz + nz * mid);
  const dir = new THREE.Vector3(dx, 0, dz).transformDirection(obj.matrixWorld);
  dir.y = 0;
  dir.normalize();
  return { point: obj.localToWorld(axisLocal), dir, width };
}

function getHitOnModel(event) {
  updatePickThresholds();
  raycaster.setFromCamera(eventToNdc(event), camera);
  const hits = raycaster
    .intersectObjects(scene.children, true)
    .filter((h) => isPickable(h.object));
  return hits.length > 0 ? hits[0] : null;
}

// start of a width measurement: a point on the first line's centre and the perpendicular to it
let widthStart = null;

// Second point: intersection of the perpendicular from the start with the centre line
// under the cursor. Not a marking (or a line across the first one): null;
// a point cannot be placed off the centre line.
const _laneRay = new THREE.Raycaster();

// parameter t of the intersection of the perpendicular A + t·n with the centre line ax
function perpendicularHit(A, n, ax) {
  const d2 = ax.dir;
  const det = -n.x * d2.z + n.z * d2.x;
  if (Math.abs(det) <= 0.4) return null;   // lines nearly perpendicular: nothing to intersect
  const qx = ax.point.x - A.x, qz = ax.point.z - A.z;
  return (qx * -d2.z - qz * -d2.x) / det;
}

function widthEndPoint(hit) {
  const A = widthStart.point, n = widthStart.n;
  const ax = markingAxisAt(hit);
  let t = null, y = hit.point.y, snapped = false;
  if (ax) {
    t = perpendicularHit(A, n, ax);
    if (t !== null) {
      y = ax.point.y;
      snapped = true;
      // Refinement: the second line's direction is taken not where the click was but
      // right at the foot of the perpendicular; otherwise on a curve or kink a click
      // a metre along the line would cause an error of centimetres.
      _laneRay.set(new THREE.Vector3(A.x + n.x * t, y + 50, A.z + n.z * t), new THREE.Vector3(0, -1, 0));
      const h2 = _laneRay.intersectObject(hit.object, false)[0];
      const ax2 = h2 && markingAxisAt(h2);
      const t2 = ax2 ? perpendicularHit(A, n, ax2) : null;
      if (t2 !== null && Math.abs(t2 - t) < 0.5) {
        t = t2;
        y = ax2.point.y;
      }
    }
  }
  if (t === null) return null;
  return { point: new THREE.Vector3(A.x + n.x * t, y, A.z + n.z * t), snapped };
}

// Hit test for width mode: only small meshes are considered (markings
// are only among them), so the DTM, asphalt and guardrails over the
// markings neither interfere nor slow things down. Of the first hits we take the one where
// a centre line was found.
function getLaneHit(event) {
  raycaster.setFromCamera(eventToNdc(event), camera);
  const candidates = [];
  for (const { object } of models.values()) {
    if (!object.visible) continue;
    object.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const g = o.geometry;
      const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      if (tris <= LANE_INDEX_MAX_TRIS) candidates.push(o);
    });
  }
  const hits = raycaster.intersectObjects(candidates, false).filter((h) => isPickable(h.object));
  for (const h of hits.slice(0, 4)) {
    const ax = markingAxisAt(h);
    if (ax) return { hit: h, ax };
  }
  return null;
}

// Where a point would go if clicked here: { point } or null.
function widthSnapAt(event) {
  const found = getLaneHit(event);
  if (!found) return null;
  if (!widthStart) return { point: found.ax.point };
  return widthEndPoint(found.hit);
}

// Snap marker: shows where the point will go before the click.
// No marker and a "not allowed" cursor mean there is no marking centre line under the cursor.
const snapMarker = new THREE.Mesh(UNIT_SPHERE, measureMaterial({ depthTest: false, transparent: true, opacity: 0.55 }));
snapMarker.renderOrder = 1000;
snapMarker.visible = false;
snapMarker.userData.isMeasureHelper = true;
scene.add(snapMarker);

let snapPending = false;
let snapEvent = null;

function hideSnap() {
  snapMarker.visible = false;
}

function updateWidthSnap() {
  snapPending = false;
  const e = snapEvent;
  if (e && measuring && measureMode === 'height') { updateHeightPreview(e); return; }
  if (!e || !measuring || measureMode !== 'width') { hideSnap(); return; }
  const snap = widthSnapAt(e);
  renderer.domElement.style.cursor = snap ? 'crosshair' : 'not-allowed';
  if (!snap) {
    hideSnap();
    if (currentLine) currentLine.visible = false;
  } else {
    snapMarker.position.copy(snap.point);
    snapMarker.visible = true;
    if (currentLine && widthStart) {
      currentLine.visible = true;
      setTubeSegment(currentLine, widthStart.point, snap.point);
    }
  }
  requestRender();
}

// ---------------------------------------------------------------------------
// Height above the surface: from a model point straight down to the surface
//
// Click a point (top of a sign, underside of a span, a lighting pole) and a plumb line
// drops from it to the first surface below. Surfaces are
// gently sloping faces (walls, posts and edges are skipped) of other layers: if
// you click a sign, the plumb line passes through the sign itself to the DTM or pavement
// below. Markings (lifted by 2 cm against flicker) are corrected for.
// ---------------------------------------------------------------------------

const HEIGHT_MAX_TRIS = 3000000;   // huge meshes (guardrails) are not a surface
const _downRay = new THREE.Raycaster();
const _downDir = new THREE.Vector3(0, -1, 0);
const _hitNormal = new THREE.Vector3();

// root object of the model the mesh belongs to
function modelRootOf(object) {
  for (let o = object; o; o = o.parent) if (o.userData && o.userData.modelId !== undefined) return o;
  return null;
}

function surfaceBelow(point, ownRoot) {
  const candidates = [];
  for (const { object } of models.values()) {
    if (!object.visible) continue;
    object.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const g = o.geometry;
      const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      if (tris <= HEIGHT_MAX_TRIS) candidates.push(o);
    });
  }
  _downRay.set(new THREE.Vector3(point.x, point.y - 0.005, point.z), _downDir);
  const hits = _downRay.intersectObjects(candidates, false).filter((h) => h.face && isPickable(h.object));

  let overlay = null, own = null;
  for (const h of hits) {
    _hitNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (Math.abs(_hitNormal.y) < 0.5) continue;   // a wall, a post, a slope steeper than 60°: skip
    if (h.object.userData.flatOverlay) { if (!overlay) overlay = h; continue; }
    if (ownRoot && modelRootOf(h.object) === ownRoot) { if (!own && h.distance > 0.05) own = h; continue; }
    return h.point.clone();
  }
  if (overlay) {
    const p = overlay.point.clone();
    p.y -= overlay.object.userData.flatOverlay;   // remove the marking lift
    return p;
  }
  // no other layers under the point: use the surface of the same model
  return own ? own.point.clone() : null;
}

// { top, bottom } for the point under the cursor, or null
function heightAt(event) {
  const hit = getHitOnModel(event);
  if (!hit) return null;
  const top = hit.point.clone();
  if (hit.object.userData.flatOverlay) top.y -= hit.object.userData.flatOverlay;
  const bottom = surfaceBelow(top, modelRootOf(hit.object));
  if (!bottom) return null;
  return { top, bottom };
}

function updateHeightPreview(e) {
  const h = heightAt(e);
  renderer.domElement.style.cursor = h ? 'crosshair' : 'not-allowed';
  if (!h) {
    hideSnap();
    if (currentLine) currentLine.visible = false;
  } else {
    if (!currentLine) {
      currentLine = new THREE.Mesh(UNIT_TUBE, measureMaterial({ transparent: true, opacity: 0.75 }));
      currentLine.userData.isMeasureHelper = true;
      scene.add(currentLine);
    }
    currentLine.visible = true;
    setTubeSegment(currentLine, h.top, h.bottom);
    snapMarker.position.copy(h.top);
    snapMarker.visible = true;
  }
  requestRender();
}

function handlePointClick(e) {
  const point = getPointOnModel(e);
  if (!point) return;
  measurements.push(new Measurement([point], 'point'));
}

function handleHeightClick(e) {
  const h = heightAt(e);
  if (!h) {
    showError('There is no surface under this point to drop a plumb line to.');
    return;
  }
  measurements.push(new Measurement([h.top, h.bottom], 'height'));
}

function getPointOnModel(event) {
  updatePickThresholds();
  raycaster.setFromCamera(eventToNdc(event), camera);
  const hits = raycaster
    .intersectObjects(scene.children, true)
    .filter((h) => isPickable(h.object));
  return hits.length > 0 ? hits[0].point : null;
}

function getDotUnderEvent(event) {
  raycaster.setFromCamera(eventToNdc(event), camera);
  const allDots = measurements.flatMap((m) => m.dots);
  if (allDots.length === 0) return null;
  const hits = raycaster.intersectObjects(allDots, false);
  return hits.length > 0 ? hits[0].object : null;
}

function getMeasurableUnderEvent(event) {
  raycaster.setFromCamera(eventToNdc(event), camera);

  const allDots = measurements.flatMap((m) => m.dots);
  if (allDots.length > 0) {
    const dotHits = raycaster.intersectObjects(allDots, false);
    if (dotHits.length > 0) {
      return { measurement: dotHits[0].object.userData.measurement, type: 'dot' };
    }
  }

  const allLines = measurements.map((m) => m.line).filter(Boolean);
  if (allLines.length > 0) {
    const lineHits = raycaster.intersectObjects(allLines, false);
    if (lineHits.length > 0) {
      return { measurement: lineHits[0].object.userData.measurement, type: 'line' };
    }
  }

  return null;
}

// the measurement line is a cylinder, not THREE.Line: linewidth does not work in WebGL
function setTubeSegment(mesh, p1, p2) {
  const dir = new THREE.Vector3().subVectors(p2, p1);
  const length = dir.length() || 1e-4;
  mesh.userData.seg = [p1.clone(), p2.clone()];
  const r = tubeScreenRadius(p1, p2);
  mesh.position.copy(p1).addScaledVector(dir, 0.5);
  mesh.scale.set(r, length, r);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
}

// ---------------------------------------------------------------------------
// Point coordinates: scene -> UTM -> WGS 84 (latitude, longitude)
//
// Models are in UTM (WGS 84): Python shifts each one to its own
// centre, and the first model's shift is stored in sceneOrigin. The scene uses
// Three.js axes: x is east, y is up, -z is north. The UTM zone is chosen in the
// chip below the buttons while Coordinates mode is on; the default is 41N.
// ---------------------------------------------------------------------------

const UTM_ZONE_KEY = '3dviewer.utmZone';
let utmZone = 41;
try {
  const z = parseInt(localStorage.getItem(UTM_ZONE_KEY), 10);
  if (z >= 1 && z <= 60) utmZone = z;
} catch (e) { /* storage unavailable: keep the default zone */ }

function setUtmZone(z) {
  utmZone = z;
  try { localStorage.setItem(UTM_ZONE_KEY, String(z)); } catch (e) { /* ignore */ }
  for (const m of measurements) if (m.mode === 'point') m.fillLabel(m.label.element);
}

// Inverse transverse Mercator using Krüger series (Karney, 2011),
// accurate to a fraction of a millimetre within the zone.
function utmToLatLon(easting, northing, zone) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n;
  const A = a / (1 + n) * (1 + n2 / 4 + n2 * n2 / 64);
  const beta = [n / 2 - 2 / 3 * n2 + 37 / 96 * n3, n2 / 48 + n3 / 15, 17 / 480 * n3];
  const delta = [2 * n - 2 / 3 * n2 - 2 * n3, 7 / 3 * n2 - 8 / 5 * n3, 56 / 15 * n3];
  const xi = northing / (k0 * A);
  const eta = (easting - 500000) / (k0 * A);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 3; j++) {
    xi1 -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let lat = chi;
  for (let j = 1; j <= 3; j++) lat += delta[j - 1] * Math.sin(2 * j * chi);
  const lon0 = (zone * 6 - 183) * Math.PI / 180;
  const lon = lon0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  return [lat * 180 / Math.PI, lon * 180 / Math.PI];
}

// "56.279862, 60.872609", or null if the scene is not georeferenced
function pointLatLonText(p) {
  const o = sceneOrigin || new THREE.Vector3();
  const east = p.x + o.x;
  const north = -(p.z + o.z);
  // outside plausible UTM values: the model is in local coordinates (OBJ etc.)
  if (!(east > 100000 && east < 900000 && north > 0 && north < 9400000)) return null;
  const [lat, lon] = utmToLatLon(east, north, utmZone);
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// Copying: through Python (the Windows clipboard always works), otherwise via the browser
function copyText(text) {
  if (window.pyBackend && typeof window.pyBackend.onCopyText === 'function') {
    window.pyBackend.onCopyText(text);
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
}

// lengths in metres to the centimetre
function fmtMeters(v) {
  return v.toFixed(2) + ' m';
}

class Measurement {
  constructor(points, mode = 'distance') {
    this.mode = mode;
    this.points = points.map((p) => p.clone());
    this.label = null;
    this.dots = [];
    this.line = null;
    this.createGeometry();
    this.createDots();
    this.createLabel();
  }

  createGeometry() {
    if (this.points.length < 2) return;   // a coordinate point has no line
    this.line = new THREE.Mesh(
      UNIT_TUBE,
      measureMaterial()
    );
    this.line.userData.measurement = this;
    this.line.userData.isMeasureHelper = true;
    this.line.renderOrder = 998;
    scene.add(this.line);
    this.updateLineTransform();
  }

  updateLineTransform() {
    if (!this.line) return;
    setTubeSegment(this.line, this.points[0], this.points[1]);
  }

  createDots() {
    this.points.forEach((p, i) => {
      const dot = new THREE.Mesh(
        UNIT_SPHERE,
        measureMaterial({ depthTest: false })
      );
      dot.position.copy(p);
      dot.scale.setScalar(dotRadius());
      dot.renderOrder = 999;
      dot.userData.measurement = this;
      dot.userData.pointIndex = i;
      dot.userData.isMeasureHelper = true;
      scene.add(dot);
      this.dots.push(dot);
    });
  }

  createLabel() {
    const el = document.createElement('div');
    el.className = 'measure-label';
    this.fillLabel(el);
    const label = new CSS2DObject(el);
    label.position.copy(this.getMidpoint());
    label.userData.measurement = this;
    scene.add(label);
    this.label = label;
  }

  getMidpoint() {
    if (this.points.length < 2) return this.points[0].clone();
    return new THREE.Vector3().addVectors(this.points[0], this.points[1]).multiplyScalar(0.5);
  }

  getPlanDistance() {
    return Math.hypot(this.points[1].x - this.points[0].x, this.points[1].z - this.points[0].z);
  }

  getDistance() {
    // lane width is always measured in plan: the height difference between lines does not change it
    if (this.mode === 'width') return this.getPlanDistance();
    if (this.mode === 'height') return Math.abs(this.points[0].y - this.points[1].y);
    return this.points[0].distanceTo(this.points[1]);
  }

  getDistanceText() {
    return fmtMeters(this.getDistance());
  }

  // Label: the result in large type. A plain measurement adds small print below:
  // L is the horizontal distance (projection on the horizontal), H the height (projection on the
  // vertical), i the slope in percent. Explained in the "?" help.
  // Lane width and height have no extra labels, just the number.
  fillLabel(el) {
    el.textContent = '';
    if (this.mode === 'point') {
      this.fillCoordLabel(el);
      return;
    }
    const main = document.createElement('span');
    main.textContent = this.getDistanceText();
    el.appendChild(main);
    if (this.mode !== 'distance') return;
    const dh = Math.abs(this.points[1].y - this.points[0].y);
    const sub = document.createElement('span');
    sub.className = 'sub';
    const plan = this.getPlanDistance();
    let text = `L ${fmtMeters(plan)} · H ${fmtMeters(dh)}`;
    // slope is meaningless for an almost vertical segment, so it is omitted
    if (plan >= 0.05) text += ` · i ${(dh / plan * 100).toFixed(1)} %`;
    sub.textContent = text;
    el.appendChild(sub);
  }

  // Point label: "latitude, longitude" and a copy button. It sits above the point,
  // not on it, so the clicked spot stays visible.
  fillCoordLabel(el) {
    el.classList.add('coord-label');
    const text = pointLatLonText(this.points[0]);
    const value = document.createElement('span');
    value.textContent = text || 'not georeferenced';
    el.appendChild(value);
    if (!text) return;
    const btn = document.createElement('button');
    btn.className = 'coord-copy';
    btn.title = 'Copy coordinates';
    btn.innerHTML = COPY_ICON;
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyText(text);
      btn.innerHTML = CHECK_ICON;
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.innerHTML = COPY_ICON; }, 1200);
    });
    el.appendChild(btn);
  }

  updatePoint(index, position) {
    this.points[index].copy(position);
    this.updateLineTransform();
    this.dots[index].position.copy(position);
    this.label.position.copy(this.getMidpoint());
    this.fillLabel(this.label.element);
  }

  dispose() {
    // the UNIT_* geometries are shared by all measurements; leave them alone
    if (this.line) {
      scene.remove(this.line);
      this.line.material.dispose();
    }

    this.dots.forEach((d) => {
      scene.remove(d);
      d.material.dispose();
    });
    this.dots = [];

    if (this.label) {
      scene.remove(this.label);
      if (this.label.element && this.label.element.parentNode) {
        this.label.element.parentNode.removeChild(this.label.element);
      }
      this.label = null;
    }
  }
}

function cancelCurrentMeasurement() {
  measurePoints = [];
  widthStart = null;
  currentDots.forEach((d) => {
    scene.remove(d);
    d.material.dispose();
  });
  currentDots = [];
  if (currentLine) {
    scene.remove(currentLine);
    currentLine.material.dispose();
    currentLine = null;
  }
}

function clearAllMeasurements() {
  measurements.forEach((m) => m.dispose());
  measurements.length = 0;
  cancelCurrentMeasurement();
  hideContextMenu();
}

function setMeasuring(value, mode = measureMode) {
  if (mode !== measureMode) cancelCurrentMeasurement();
  measureMode = mode;
  measuring = value;
  for (const [id, m] of [['btn-measure', 'distance'], ['btn-measure-width', 'width'], ['btn-measure-height', 'height'], ['btn-measure-point', 'point']]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const on = measuring && measureMode === m;
    btn.classList.toggle('active', on);
    btn.style.background = on ? 'rgba(255, 122, 31, 0.22)' : '';
    btn.style.borderColor = on ? 'var(--accent)' : '';
  }
  renderer.domElement.style.cursor = measuring ? 'crosshair' : 'grab';
  if (!measuring) cancelCurrentMeasurement();
  if (!measuring || measureMode === 'distance' || measureMode === 'point') hideSnap();
  const zoneChip = document.getElementById('utm-zone-chip');
  if (zoneChip) zoneChip.classList.toggle('hidden', !(measuring && measureMode === 'point'));
}

function initMeasureButtons() {
  const measureBtn = document.getElementById('btn-measure');
  const clearBtn = document.getElementById('btn-clear-measurements');
  const widthBtn = document.getElementById('btn-measure-width');
  // clicking the active mode button again turns measuring off;
  // clicking another one switches the mode
  const toggle = (mode) => setMeasuring(!(measuring && measureMode === mode), mode);
  if (measureBtn) measureBtn.addEventListener('click', () => toggle('distance'));
  if (widthBtn) widthBtn.addEventListener('click', () => toggle('width'));
  const heightBtn = document.getElementById('btn-measure-height');
  if (heightBtn) heightBtn.addEventListener('click', () => toggle('height'));
  const pointBtn = document.getElementById('btn-measure-point');
  if (pointBtn) pointBtn.addEventListener('click', () => toggle('point'));
  const zoneSelect = document.getElementById('utm-zone');
  if (zoneSelect) {
    for (let z = 1; z <= 60; z++) {
      const opt = document.createElement('option');
      opt.value = String(z);
      opt.textContent = `UTM ${z}N`;
      zoneSelect.appendChild(opt);
    }
    zoneSelect.value = String(utmZone);
    zoneSelect.addEventListener('change', () => setUtmZone(parseInt(zoneSelect.value, 10)));
  }
  if (clearBtn) clearBtn.addEventListener('click', () => clearAllMeasurements());
}

// ---------------------------------------------------------------------------
// Measurement context menu
// ---------------------------------------------------------------------------

function ensureContextMenu() {
  if (contextMenu) return contextMenu;

  contextMenu = document.createElement('div');
  contextMenu.id = 'measure-context-menu';
  contextMenu.classList.add('hidden');

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'danger';
  deleteBtn.textContent = 'Delete measurement';
  deleteBtn.addEventListener('click', () => {
    if (contextMenuTarget) {
      const idx = measurements.indexOf(contextMenuTarget);
      if (idx !== -1) {
        contextMenuTarget.dispose();
        measurements.splice(idx, 1);
      }
    }
    hideContextMenu();
  });

  contextMenu.appendChild(deleteBtn);
  document.body.appendChild(contextMenu);
  return contextMenu;
}

function showContextMenu(x, y, measurement, type) {
  const menu = ensureContextMenu();
  contextMenuTarget = measurement;
  contextMenuTargetType = type;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  if (contextMenu) contextMenu.classList.add('hidden');
  contextMenuTarget = null;
  contextMenuTargetType = null;
}

document.addEventListener('click', (e) => {
  if (contextMenu && !contextMenu.contains(e.target)) hideContextMenu();
});

// The right button both opens the menu and orbits the scene. The menu
// is shown only if the mouse did not move, otherwise it would pop up at the end
// of every orbit.
let rightDownPos = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 2) rightDownPos = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();

  if (rightDownPos) {
    const dx = e.clientX - rightDownPos.x;
    const dy = e.clientY - rightDownPos.y;
    rightDownPos = null;
    if (Math.sqrt(dx * dx + dy * dy) > 4) {
      hideContextMenu();
      return;
    }
  }

  const hit = getMeasurableUnderEvent(e);
  if (hit) showContextMenu(e.clientX, e.clientY, hit.measurement, hit.type);
  else hideContextMenu();
});

// ---------------------------------------------------------------------------
// Mouse clicks: measuring and editing points
// ---------------------------------------------------------------------------

renderer.domElement.addEventListener('pointerdown', (e) => {
  mouseDownPos = { x: e.clientX, y: e.clientY };

  if (e.button === 0 && !measuring) {
    const dot = getDotUnderEvent(e);
    // width and height points are not draggable: they are tied to the centre line and the plumb line
    const dm = dot && dot.userData.measurement;
    if (dm && dm.mode !== 'distance' && dm.mode !== 'point') return;
    if (dot) {
      isEditing = true;
      editTarget = dot;
      controls.enabled = false;
    }
  }
});

window.addEventListener('pointermove', (e) => {
  if (!isEditing || !editTarget) return;
  const point = getPointOnModel(e);
  if (!point) return;
  editTarget.userData.measurement.updatePoint(editTarget.userData.pointIndex, point);
});

window.addEventListener('pointerup', () => {
  if (isEditing) {
    isEditing = false;
    editTarget = null;
    controls.enabled = true;
  }
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (isEditing) return;
  if (e.button !== 0) return;
  if (!measuring) return;

  const dx = e.clientX - mouseDownPos.x;
  const dy = e.clientY - mouseDownPos.y;
  if (Math.sqrt(dx * dx + dy * dy) > 4) return;   // that was a camera orbit, not a click

  if (measureMode === 'width') {
    handleWidthClick(e);
    return;
  }
  if (measureMode === 'height') {
    handleHeightClick(e);
    return;
  }
  if (measureMode === 'point') {
    handlePointClick(e);
    return;
  }

  const point = getPointOnModel(e);
  if (!point) return;

  measurePoints.push(point.clone());

  const dot = new THREE.Mesh(
    UNIT_SPHERE,
    measureMaterial({ depthTest: false })
  );
  dot.position.copy(point);
  dot.scale.setScalar(dotRadius());
  dot.renderOrder = 999;
  dot.userData.isMeasureHelper = true;
  scene.add(dot);
  currentDots.push(dot);

  if (measurePoints.length === 1) {
    currentLine = new THREE.Mesh(
      UNIT_TUBE,
      measureMaterial({ transparent: true, opacity: 0.75 })
    );
    currentLine.userData.isMeasureHelper = true;
    setTubeSegment(currentLine, point, point);
    scene.add(currentLine);
  }

  if (measurePoints.length === 2) {
    measurements.push(new Measurement(measurePoints));

    currentDots.forEach((d) => {
      scene.remove(d);
      d.material.dispose();
    });
    currentDots = [];

    if (currentLine) {
      scene.remove(currentLine);
      currentLine.material.dispose();
      currentLine = null;
    }

    measurePoints = [];
  }
});

window.addEventListener('pointermove', (e) => {
  if (measuring && (measureMode === 'width' || measureMode === 'height')) {
    // centre line search once per frame, not on every mouse move
    snapEvent = e;
    if (!snapPending) {
      snapPending = true;
      requestAnimationFrame(updateWidthSnap);
    }
    return;
  }
  if (!measuring || measurePoints.length !== 1 || !currentLine) return;
  const point = getPointOnModel(e);
  if (!point) return;
  setTubeSegment(currentLine, measurePoints[0], point);
});

function addCurrentDot(point) {
  const dot = new THREE.Mesh(UNIT_SPHERE, measureMaterial({ depthTest: false }));
  dot.position.copy(point);
  dot.scale.setScalar(dotRadius());
  dot.renderOrder = 999;
  dot.userData.isMeasureHelper = true;
  scene.add(dot);
  currentDots.push(dot);
}

function handleWidthClick(e) {
  const found = getLaneHit(e);

  if (!widthStart) {
    if (!found) {
      showError('Click a road marking: the point snaps to its centre line.');
      return;
    }
    const ax = found.ax;
    widthStart = { point: ax.point.clone(), n: new THREE.Vector3(-ax.dir.z, 0, ax.dir.x) };
    measurePoints = [ax.point.clone()];
    addCurrentDot(ax.point);
    currentLine = new THREE.Mesh(UNIT_TUBE, measureMaterial({ transparent: true, opacity: 0.75 }));
    currentLine.userData.isMeasureHelper = true;
    setTubeSegment(currentLine, ax.point, ax.point);
    scene.add(currentLine);
    return;
  }

  const end = found && widthEndPoint(found.hit);
  if (!end) {
    showError('For the second point, click another marking: the point lands on its centre line opposite the first.');
    return;
  }
  measurements.push(new Measurement([widthStart.point, end.point], 'width'));
  cancelCurrentMeasurement();
  hideSnap();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (measuring) cancelCurrentMeasurement();
    hideContextMenu();
  }
});

// ---------------------------------------------------------------------------
// Window resize and render loop
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = mount.clientWidth / mount.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(mount.clientWidth, mount.clientHeight);
  labelRenderer.setSize(mount.clientWidth, mount.clientHeight);
});

// The startup screen is hidden not on DOMContentLoaded but after the first real
// frame: by then the WebGL context exists and the scene is drawn,
// so no empty frame flashes under the overlay.
function finishBoot() {
  if (bootDone) return;
  bootDone = true;
  ifcReady.finally(() => {
    hideOverlay();
    updateStatus();
  });
}

// ---------------------------------------------------------------------------
// Measurement markers with a constant screen size
//
// Point and line radii used to be a fraction of the scene diagonal. On a
// 20 km road section that is ~17 m for a point and ~20 m for a line: up close a marker
// covered half the screen. Now the size is recomputed every frame from
// the camera distance, and a marker is always a few pixels, as in CAD.
// ---------------------------------------------------------------------------

const MEASURE_DOT_PX = 5;     // point radius, px
const MEASURE_TUBE_PX = 1.5;  // line radius, px
const _measureSeg = new THREE.Line3();
const _measureTmp = new THREE.Vector3();

// how many world units one pixel spans at the distance of pos
function worldPerPixel(pos) {
  const dist = camera.position.distanceTo(pos);
  const h = Math.max(1, renderer.domElement.clientHeight);
  return (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / h;
}

// line radius from its point nearest to the camera
function tubeScreenRadius(p1, p2) {
  _measureSeg.set(p1, p2);
  _measureSeg.closestPointToPoint(camera.position, true, _measureTmp);
  return worldPerPixel(_measureTmp) * MEASURE_TUBE_PX;
}

function fitTube(mesh) {
  const seg = mesh && mesh.userData.seg;
  if (!seg) return;
  const r = tubeScreenRadius(seg[0], seg[1]);
  mesh.scale.x = r;
  mesh.scale.z = r;
}

function updateMeasureSizes() {
  for (const m of measurements) {
    for (const d of m.dots) d.scale.setScalar(worldPerPixel(d.position) * MEASURE_DOT_PX);
    fitTube(m.line);
  }
  for (const d of currentDots) d.scale.setScalar(worldPerPixel(d.position) * MEASURE_DOT_PX);
  fitTube(currentLine);   // temporary line until the second point is placed
  if (snapMarker.visible) snapMarker.scale.setScalar(worldPerPixel(snapMarker.position) * MEASURE_DOT_PX * 1.6);
}

// ---------------------------------------------------------------------------
// Render on demand
//
// Frames used to be drawn 60 times a second even when nobody touched
// the mouse: the GPU sat at 100% and laptop fans howled. Now a frame
// is drawn only when something changes: the camera moves, a model arrives,
// a button is pressed, the light changes. At rest the loop idles.
//
// Shadows. The shadow map is one more pass over the whole scene (guardrails add
// 10 million triangles per frame). The sun and its shadow camera are tied to
// the model extent, not to the viewer's camera, so shadows do not change
// while orbiting. They are recomputed only when the scene or the light changes.
// ---------------------------------------------------------------------------

renderer.shadowMap.autoUpdate = false;

let renderFrames = 2;        // frames left to draw; 2 for finishBoot
let shadowsDirty = true;

// the camera or something on screen moved: redraw a couple of frames
function requestRender(frames = 2) {
  if (frames > renderFrames) renderFrames = frames;
}

// scene content or light changed: redraw and recompute shadows
function invalidateScene() {
  shadowsDirty = true;
  requestRender(3);
}

// Anything added to or removed from the scene (models, measurements,
// hints) wakes up rendering automatically.
for (const method of ['add', 'remove']) {
  const original = scene[method];
  scene[method] = function (...args) {
    invalidateScene();
    return original.apply(this, args);
  };
}

// OBJ textures load asynchronously; redraw when each one is ready.
{
  const manager = THREE.DefaultLoadingManager;
  const prevProgress = manager.onProgress;
  manager.onProgress = function (...args) {
    invalidateScene();
    if (prevProgress) prevProgress.apply(this, args);
  };
}

// Mouse and keyboard. Moves and the wheel only trigger a redraw (camera,
// highlight, temporary measurement line). Clicks, sliders and keys may
// change the scene or the light, so they also recompute shadows.
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'resize']) {
  window.addEventListener(type, () => requestRender(), { capture: true, passive: true });
}
for (const type of ['click', 'input', 'change', 'keydown', 'contextmenu']) {
  window.addEventListener(type, () => invalidateScene(), { capture: true, passive: true });
}

// Commands from Python (theme, loading, model sync) also change the scene.
for (const key of Object.keys(window.viewerApp)) {
  const fn = window.viewerApp[key];
  if (typeof fn !== 'function') continue;
  window.viewerApp[key] = function (...args) {
    const result = fn.apply(this, args);
    invalidateScene();
    return result;
  };
}

// ---------------------------------------------------------------------------
// Low-power mode for slower PCs (switch in the bottom right)
//
// While the camera moves (drag, orbit, zoom, fly-to) the frame
// is drawn at half resolution (4 times fewer pixels), and objects that are
// tiny on screen (under a couple of pixels) are skipped. The outlines
// of everything else stay, the picture is just slightly softer. As soon as
// motion stops, one sharp full-quality frame is drawn.
// ---------------------------------------------------------------------------

const BASE_PIXEL_RATIO = Math.min(window.devicePixelRatio, 2);
const LOW_PIXEL_RATIO = BASE_PIXEL_RATIO * 0.5;
const LOW_MIN_PX = 2;            // objects smaller than this on screen are skipped while moving
const LOW_SETTLE_MS = 150;       // pause before the sharp frame is drawn

let lowPower = false;
let lowActive = false;           // currently drawing in reduced quality
let lastMoveTime = 0;
const _lowHidden = [];
const _lowSphere = new THREE.Sphere();

function setLowPower(value) {
  lowPower = !!value;
  if (!lowPower && lowActive) {
    renderer.setPixelRatio(BASE_PIXEL_RATIO);
    lowActive = false;
  }
  requestRender();
}

// meshes that are tiny on screen are hidden for one frame (layer visibility is untouched)
function hideTinyMeshes() {
  const h = Math.max(1, renderer.domElement.clientHeight);
  const k = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  for (const { object } of models.values()) {
    if (!object.visible) continue;
    object.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry) return;
      const bs = o.geometry.boundingSphere;
      if (!bs || !Number.isFinite(bs.radius)) return;
      _lowSphere.copy(bs).applyMatrix4(o.matrixWorld);
      const dist = Math.max(1e-6, _lowSphere.center.distanceTo(camera.position) - _lowSphere.radius);
      if ((_lowSphere.radius / dist) * k < LOW_MIN_PX) {
        o.visible = false;
        _lowHidden.push(o);
      }
    });
  }
}

function restoreTinyMeshes() {
  for (const o of _lowHidden) o.visible = true;
  _lowHidden.length = 0;
}

let framesDrawn = 0;

function animate() {
  requestAnimationFrame(animate);
  // getDelta resets the timer, so it is read once per frame
  const dt = clock.getDelta();

  // scene drag and glide after release
  const panning = dragging || pendingX !== 0 || pendingZ !== 0;
  applyPanSmoothing(dt);
  // true while the camera is moving: orbit, zoom, smooth fly-to
  const cameraMoving = controls.update(dt);
  const moving = panning || cameraMoving;
  if (moving) requestRender(2);

  // low-power mode: half resolution while moving, then
  // one sharp frame once stopped
  if (lowPower) {
    const now = performance.now();
    if (moving) {
      lastMoveTime = now;
      if (!lowActive) {
        renderer.setPixelRatio(LOW_PIXEL_RATIO);
        lowActive = true;
      }
    } else if (lowActive && now - lastMoveTime > LOW_SETTLE_MS) {
      renderer.setPixelRatio(BASE_PIXEL_RATIO);
      lowActive = false;
      requestRender(1);
    } else if (lowActive) {
      return;   // wait in case the motion continues; the soft frame is already on screen
    }
  }

  if (renderFrames <= 0) return;   // nothing changed: the GPU rests
  renderFrames--;

  if (shadowsDirty) {
    renderer.shadowMap.needsUpdate = true;
    shadowsDirty = false;
  }

  // the background follows the camera: otherwise on models larger than 10000 units the camera
  // leaves the sphere and you see its inside instead of the gradient
  background.position.copy(camera.position);
  updateMeasureSizes();
  if (lowActive) hideTinyMeshes();
  renderer.render(scene, camera);
  if (lowActive) restoreTinyMeshes();
  labelRenderer.render(scene, camera);

  if (++framesDrawn === 2) finishBoot();
}

animate();
