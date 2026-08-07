// PROTOTYPE: places the heat pump using 8th Wall's World Tracking engine
// instead of raw WebXR hit-test (see webxr-ar.js). Not wired into the main
// app - loaded only by test-8thwall.html for on-device evaluation.
//
// Why this exists: WebXR's hit-test API detects real surfaces via
// ARCore/ARKit plane detection, and this project's placement bugs have
// consistently traced back to that layer being flaky (dropped tracking,
// relocalization jumps) on real Android devices. 8th Wall's World Tracking
// (the SLAM engine that made 8th Wall's reputation for "rock solid"
// placement, now free/self-hosted as of the Feb 2026 platform retirement -
// see https://8thwall.org) gives much more stable 6DoF camera pose
// tracking. The trade-off: the free engine binary does NOT do real surface
// detection (that's part of paid/VPS-only products it explicitly excludes).
// Placement here works by raycasting a tap against an assumed flat ground
// plane at an estimated floor height (FLOOR_HEIGHT_M below) - exactly the
// pattern in 8th Wall's own reference example (examples/threejs/placeground
// in github.com/8thwall/web). That's a real trade-off to evaluate: tracking
// stability goes up, but "floor" is an estimate you can nudge, not a
// measurement, unless the phone's starting height guess happens to be right.
//
// This also prototypes the door/window marking flow: no AR SDK (8th Wall,
// Zappar, or raw WebXR/ARCore) ships a classifier that recognizes a door or
// window in the camera feed - that's not a capability that exists today in
// any of the engines researched for this. So marking one is a guided manual
// step: aim at it, drag a distance slider until the marker lines up with
// the real door/window (there's no depth data for an arbitrary tapped point
// without a real hit-test), then tag it Door/Window and Habitable/Not. Only
// markers tagged "habitable" feed the MCS 020 estimate, matching the real
// standard (which only cares about the nearest habitable room of a
// neighbouring dwelling).

/* globals XR8, XRExtras, THREE */

const FLOOR_HEIGHT_M = 1.3; // estimated phone-in-hand height; nudge with adjustFloorHeight() if the model doesn't sit on the real floor
const MODEL_URL = "assets/models/arotherm-plus.glb";
const DEFAULT_MARK_DISTANCE_M = 4;

// Same real aroTHERM plus 3.5/5kW datasheet figure + MCS 020 default threshold
// used in the main app (app.js), duplicated here since this prototype file is
// intentionally standalone.
const LWA_DB = 54;
const MCS020_THRESHOLD_DB = 42;
function predictedSpl(lwa, distanceM, q) {
  const d = Math.max(distanceM, 0.1);
  return lwa + 10 * Math.log10(q / (4 * Math.PI * d * d));
}

const ROTATE_SENSITIVITY = 0.012; // radians per pixel of horizontal drag
const TAP_MOVE_THRESHOLD = 12; // px - below this, a touch is a tap, not a drag

let scene, camera, renderer, groundPlane, canvasEl;
let heatPump = null;
let reticle = null; // circle on the floor showing where a tap will drop the heat pump
let dropLabel = null; // "Tap to drop" sprite, floats just above the reticle
let placed = false;
let userYaw = 0; // left/right spin only - the ground is always flat here, so no pitch/roll needed
let markMode = false;
let aiming = null; // { origin: Vector3, direction: Vector3, distanceM, mesh, labelSprite }
const markers = [];

let dragActive = false;
let dragStartX = 0;
let dragStartY = 0;
let yawAtDragStart = 0;
let dragMoved = false;
// Not constructed until start() runs (i.e. after the user taps the Start
// button), even though this script tag loads well before that. These need
// THREE to already be the real three.js module, but the inline module
// script in test-8thwall.html that sets window.THREE is deferred (all
// `type="module"` scripts are, per spec) and so actually executes AFTER
// this plain, non-deferred script tag further down the page - building
// these at load time hit `THREE is not defined` immediately, before
// anything in this file ever ran, with no on-screen trace of the crash.
let raycaster;
let tapNdc;
let loader;

let hooks = {};

function log(msg) {
  console.log("[8thwall]", msg);
  if (hooks.onLog) hooks.onLog(msg);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLabelSprite(lines, accentColor) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(10, 20, 18, 0.85)";
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18);
  ctx.fill();
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 4;
  roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, i) => {
    ctx.font = i === 0 ? "bold 30px sans-serif" : "22px sans-serif";
    ctx.fillStyle = i === 0 ? "#ffffff" : accentColor;
    ctx.fillText(line, canvas.width / 2, 40 + i * 40);
  });
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.6, 0.2, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function createReticle() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.16, 0.21, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
  );
  ring.rotateX(-Math.PI / 2);
  return ring;
}

// Raycasts from the CENTER of the screen (not wherever the finger happens to
// be) against the ground plane - this is the standard mobile-AR placement
// pattern (aim the phone, a reticle follows where you're looking; tap
// anywhere just confirms whatever the reticle is currently over). Runs every
// frame before placement so the heat pump and its floor circle both track
// live as the phone moves, instead of only appearing once at tap time.
function updateLivePreview() {
  if (placed || markMode || !groundPlane) return;
  tapNdc.set(0, 0);
  raycaster.setFromCamera(tapNdc, camera);
  const hits = raycaster.intersectObject(groundPlane);
  if (hits.length === 0) return;
  const p = hits[0].point;

  if (reticle) {
    reticle.position.set(p.x, 0.01, p.z);
    reticle.visible = true;
  }
  if (dropLabel) {
    dropLabel.position.set(p.x, 0.22, p.z);
    dropLabel.visible = true;
  }
  if (heatPump) {
    heatPump.position.set(p.x, 0, p.z);
    heatPump.rotation.y = userYaw;
    heatPump.visible = true;
  }
}

// Freezes the heat pump wherever the live-follow reticle currently is -
// there's nothing else to compute here, since the model has already been
// tracking that same ground point every frame up to this point.
function confirmPlacement() {
  if (!heatPump || !heatPump.visible) return;
  placed = true;
  if (reticle) reticle.visible = false;
  if (dropLabel) dropLabel.visible = false;
  log("Heat pump placed. Drag left/right to turn it, or tap Mark door/window.");
  if (hooks.onPlaced) hooks.onPlaced();
}

function applyYaw() {
  if (!heatPump) return;
  heatPump.rotation.y = userYaw;
}

function screenToRay(clientX, clientY) {
  tapNdc.x = (clientX / window.innerWidth) * 2 - 1;
  tapNdc.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(tapNdc, camera);
  return { origin: raycaster.ray.origin.clone(), direction: raycaster.ray.direction.clone() };
}

function startAiming(clientX, clientY) {
  const ray = screenToRay(clientX, clientY);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffd23f })
  );
  scene.add(mesh);
  aiming = { ...ray, distanceM: DEFAULT_MARK_DISTANCE_M, mesh, kind: "door", habitable: true };
  updateAimingPosition();
  log("Aiming at a point - use the distance slider to line it up, then tag it.");
  if (hooks.onAiming) hooks.onAiming();
}

function updateAimingPosition() {
  if (!aiming) return;
  const p = aiming.origin.clone().addScaledVector(aiming.direction, aiming.distanceM);
  aiming.mesh.position.copy(p);
}

function setAimingDistance(m) {
  if (!aiming) return;
  aiming.distanceM = m;
  updateAimingPosition();
}

function setAimingKind(kind) {
  if (!aiming) return;
  aiming.kind = kind;
}

function setAimingHabitable(habitable) {
  if (!aiming) return;
  aiming.habitable = habitable;
}

function cancelAiming() {
  if (!aiming) return;
  scene.remove(aiming.mesh);
  aiming = null;
  markMode = false;
}

function confirmAiming() {
  if (!aiming || !heatPump) return;
  const point = aiming.origin.clone().addScaledVector(aiming.direction, aiming.distanceM);
  const distanceFromPump = point.distanceTo(heatPump.position);
  const accent = aiming.habitable ? "#2fc6a6" : "#7c8b96";
  aiming.mesh.material.color.set(aiming.habitable ? 0x2fc6a6 : 0x7c8b96);

  const label = makeLabelSprite(
    [
      `${aiming.kind === "door" ? "Door" : "Window"} · ${aiming.habitable ? "Habitable room" : "Not habitable"}`,
      `${distanceFromPump.toFixed(1)}m from unit`
    ],
    accent
  );
  label.position.copy(aiming.mesh.position).add(new THREE.Vector3(0, 0.18, 0));
  scene.add(label);

  const record = {
    kind: aiming.kind,
    habitable: aiming.habitable,
    distanceFromPumpM: distanceFromPump,
    predictedDb: aiming.habitable ? predictedSpl(LWA_DB, distanceFromPump, 2) : null,
    thresholdDb: MCS020_THRESHOLD_DB
  };
  markers.push(record);

  aiming = null;
  markMode = false;
  log(
    `Marked ${record.kind} (${record.habitable ? "habitable" : "not habitable"}) at ${distanceFromPump.toFixed(1)}m` +
      (record.predictedDb != null
        ? ` - predicted ${record.predictedDb.toFixed(1)}dB(A) (limit ${MCS020_THRESHOLD_DB})`
        : "")
  );
  if (hooks.onMarkerConfirmed) hooks.onMarkerConfirmed(record);
}

// Distinguishes a tap (place/mark) from a drag (turn the heat pump left or
// right) the same way the production webxr-ar.js does: track movement
// across touchstart -> touchmove -> touchend, and only decide which one it
// was once the finger lifts, rather than reacting instantly on touchstart.
function onTouchStart(e) {
  if (e.touches.length === 2) {
    XR8.XrController.recenter();
    log("Recentered tracking.");
    return;
  }
  if (e.touches.length !== 1) return;
  dragActive = true;
  dragMoved = false;
  dragStartX = e.touches[0].clientX;
  dragStartY = e.touches[0].clientY;
  yawAtDragStart = userYaw;
}

function onTouchMove(e) {
  e.preventDefault();
  if (!dragActive || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - dragStartX;
  const dy = e.touches[0].clientY - dragStartY;
  if (!dragMoved) {
    if (Math.abs(dx) <= TAP_MOVE_THRESHOLD && Math.abs(dy) <= TAP_MOVE_THRESHOLD) return;
    dragMoved = true;
    // Rebase so rotation continues smoothly from the current angle instead
    // of jumping by the threshold distance the instant a drag is recognised.
    yawAtDragStart = userYaw - dx * ROTATE_SENSITIVITY;
  }
  // Left/right only - turning the unit to face a different way along the
  // wall is the only rotation that makes sense for a floor-standing heat
  // pump, so drag is deliberately mapped to yaw regardless of vertical
  // finger movement (dy is tracked only for the tap-vs-drag decision above).
  userYaw = yawAtDragStart + dx * ROTATE_SENSITIVITY;
  applyYaw();
}

function onTouchEnd(e) {
  dragActive = false;
  if (dragMoved) return; // was a drag, not a tap - nothing more to do

  const touch = e.changedTouches[0];
  if (!touch) return;

  if (markMode) {
    if (!aiming) startAiming(touch.clientX, touch.clientY);
    return;
  }

  // Not in mark mode: confirm placement wherever the live reticle currently
  // is - NOT at the tap's own screen position, matching how a real AR
  // placement reticle works (you aim with the phone, tap just confirms).
  if (!placed) confirmPlacement();
}

function pipelineModule() {
  return {
    name: "vaillantEightWallPrototype",

    onStart: ({ canvas }) => {
      canvasEl = canvas;
      const xrScene = XR8.Threejs.xrScene();
      scene = xrScene.scene;
      camera = xrScene.camera;
      renderer = xrScene.renderer;

      // Same explicit color management as the production WebXR path
      // (webxr-ar.js) - without it a GLB loaded through raw three.js can
      // render far too dark against the camera passthrough.
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.3;

      // Canvas/camera-feed sizing to fill the window is handled by
      // XRExtras.FullWindowCanvas.pipelineModule() (added in start() below)
      // - a hand-rolled renderer.setSize() here was tried first and did NOT
      // work: it resizes three.js's own render target, but not the
      // engine's separate internal camera-texture viewport that
      // XR8.GlTextureRenderer draws the passthrough video into, so the
      // camera feed stayed a small fixed-size square in the middle of the
      // screen. FullWindowCanvas is 8th Wall's own module for this exact
      // problem, used in all of their reference examples.

      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.6));
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
      dirLight.position.set(1, 3, 1);
      scene.add(dirLight);

      groundPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200, 1, 1),
        new THREE.MeshBasicMaterial({ visible: false })
      );
      groundPlane.rotateX(-Math.PI / 2);
      scene.add(groundPlane);

      camera.position.set(0, FLOOR_HEIGHT_M, 0);
      XR8.XrController.updateCameraProjectionMatrix({ origin: camera.position, facing: camera.quaternion });

      reticle = createReticle();
      reticle.visible = false;
      scene.add(reticle);
      dropLabel = makeLabelSprite(["Tap to drop"], "#2fc6a6");
      dropLabel.visible = false;
      scene.add(dropLabel);

      canvas.addEventListener("touchstart", onTouchStart, true);
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("touchend", onTouchEnd, true);
      canvas.addEventListener("touchcancel", () => {
        dragActive = false;
      });

      log("World tracking started. Point the phone at the floor.");

      loader.load(
        MODEL_URL,
        (gltf) => {
          heatPump = gltf.scene;
          heatPump.visible = false; // updateLivePreview() reveals it once the first ground raycast lands
          scene.add(heatPump);
          log("Model loaded - it'll follow where you point the phone until you tap to drop it.");
        },
        undefined,
        (err) => log("Model failed to load: " + err.message)
      );
    },

    // Runs every processed frame - drives the live floor-following reticle
    // and heat pump position before placement (see updateLivePreview).
    onUpdate: () => {
      updateLivePreview();
    },

    // The engine's own hook for camera acquisition progress - without this,
    // a camera permission prompt that's denied, ignored, or silently
    // pre-blocked (Chrome doesn't re-prompt once a site's camera permission
    // is set to "block" - it just never asks again) looks identical to
    // "stuck loading" from the page's point of view, since onStart above
    // only ever fires once a camera stream actually exists.
    onCameraStatusChange: ({ status }) => {
      log("Camera status: " + status);
      if (status === "failed") {
        log("Camera access failed. Check Chrome's site settings (tap the lock/info icon in the address bar) for this page's Camera permission - if it's set to Block, reset it there and reload.");
      }
    },

    onException: (error) => {
      log("XR8 exception: " + (error && error.message ? error.message : error));
    }
  };
}

function start({ canvasId, onLog, onPlaced, onAiming, onMarkerConfirmed }) {
  hooks = { onLog, onPlaced, onAiming, onMarkerConfirmed };
  raycaster = new THREE.Raycaster();
  tapNdc = new THREE.Vector2();
  loader = new THREE.GLTFLoader();

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions
      .query({ name: "camera" })
      .then((status) => log("Camera permission (before starting): " + status.state))
      .catch(() => {}); // not every browser supports querying the camera permission - non-fatal if so
  }

  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    XR8.XrController.pipelineModule(),
    XRExtras.FullWindowCanvas.pipelineModule(),
    pipelineModule()
  ]);
  XR8.run({ canvas: document.getElementById(canvasId) });

  setTimeout(() => {
    if (!placed && !scene) {
      log(
        "Still waiting 8s after starting - world tracking never reported a camera status at all. " +
          "This points to the engine itself failing silently rather than a permission prompt (that would " +
          "have logged a Camera status line above). Try reloading, or check the browser console."
      );
    }
  }, 8000);
}

function enterMarkMode() {
  markMode = true;
  // updateLivePreview() stops touching these while markMode is true, but
  // won't hide them itself - do it here so the placement reticle doesn't
  // sit frozen on screen, overlapping the door/window aiming marker.
  if (!placed) {
    if (reticle) reticle.visible = false;
    if (dropLabel) dropLabel.visible = false;
  }
  log("Mark mode: tap the door or window you want to tag.");
}

function adjustFloorHeight(deltaM) {
  if (!camera) return;
  camera.position.y += deltaM;
  log(`Floor height estimate now ${camera.position.y.toFixed(2)}m (nudge until the model sits on the real floor).`);
}

window.VaillantEightWall = {
  start,
  enterMarkMode,
  setAimingDistance,
  setAimingKind,
  setAimingHabitable,
  confirmAiming,
  cancelAiming,
  adjustFloorHeight,
  getMarkers: () => markers.slice()
};
