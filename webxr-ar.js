// Raw WebXR AR placement: hit-test driven, so we get full control over
// exactly when the model appears (only once a real surface is found) and
// exactly when it's confirmed (only on tap), matching real AR placement UX.
// model-viewer's own AR mode doesn't expose these two moments separately,
// which is why this bypasses it for the live AR session specifically -
// the on-page 3D preview still uses model-viewer as before.
//
// The scanning UI (status text, yellow surface dots) is drawn INSIDE the
// WebGL scene, not as HTML dom-overlay content. dom-overlay is optional and
// not every device grants it (confirmed: on at least one real test device,
// none of the HTML overlay content rendered at all during the session,
// including a plain debug line, while the underlying hit-test itself was
// fine) - so the UI can't depend on it. Text is a canvas-texture sprite
// parented to the camera (a screen-space HUD), and the scan dots are small
// glowing sprites dropped in world space at hit-test points as the user
// pans the phone around - both render on the same canvas as the camera
// passthrough and don't need dom-overlay at all.
//
// Placement itself is the standard AR pattern: a reticle tracks the live
// hit-test result while scanning, and a tap drops the model directly at
// that surface point. There is deliberately no "floating preview attached
// to the camera" stage before that - reparenting a camera-attached object
// into world space every frame (or worse, on tap) is what caused this
// model's earlier "flying"/jitter bugs, since any camera relocalization
// between frames shows up as the object visibly jumping. Not having that
// stage at all removes the whole bug class instead of chasing it further.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const modelCache = new Map();

function loadModel(url) {
  if (modelCache.has(url)) {
    return Promise.resolve(modelCache.get(url).clone());
  }
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        modelCache.set(url, gltf.scene);
        resolve(gltf.scene.clone());
      },
      undefined,
      reject
    );
  });
}

function createReticle() {
  const geometry = new THREE.RingGeometry(0.14, 0.18, 32).rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  material.toneMapped = false; // keep it crisply white regardless of scene tone-mapping
  const ring = new THREE.Mesh(geometry, material);
  ring.matrixAutoUpdate = false;
  ring.visible = false;
  return ring;
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

// Screen-space HUD: a text sprite parented to the camera so it stays fixed
// in view. Needs `scene.add(camera)` so the sprite (camera's child) is
// actually part of the render graph.
function createHud() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  material.toneMapped = false;
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 999;
  sprite.scale.set(0.5, 0.156, 1);
  sprite.position.set(0, -0.2, -0.6);
  sprite.visible = false;

  function setLines(lines) {
    const arr = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (arr.length === 0) {
      texture.needsUpdate = true;
      sprite.visible = false;
      return;
    }
    sprite.visible = true;
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    roundRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 24);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineHeight = 40;
    const startY = canvas.height / 2 - ((arr.length - 1) * lineHeight) / 2;
    arr.forEach((line, i) => {
      ctx.font = i === 0 ? "bold 34px sans-serif" : "22px monospace";
      ctx.fillStyle = i === 0 ? "#ffffff" : "#7CFC7C";
      ctx.fillText(line, canvas.width / 2, startY + i * lineHeight);
    });
    texture.needsUpdate = true;
  }

  return { sprite, setLines };
}

let dotTexture = null;
function getDotTexture() {
  if (dotTexture) return dotTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,210,63,1)");
  gradient.addColorStop(0.5, "rgba(255,210,63,0.85)");
  gradient.addColorStop(1, "rgba(255,210,63,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  dotTexture = new THREE.CanvasTexture(canvas);
  return dotTexture;
}

const MAX_SCAN_DOTS = 45;
const UP = new THREE.Vector3(0, 1, 0);
const ROTATE_SENSITIVITY = 0.012; // radians per pixel of horizontal drag
const DISTANCE_UPDATE_INTERVAL_MS = 100;

export async function isWebXRArSupported() {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

let active = null; // holds the current session's teardown state, or null

export async function startWebXRPlacement({ modelUrl, scale, overlayRoot, onScanning, onReadyToPlace, onPlaced, onDistance, onEnd, onError, onSessionStarted }) {
  if (active) {
    endWebXRPlacement();
  }

  let renderer, scene, camera, reticle, modelRoot, xrSession, hud;
  let hitTestSource = null;
  let hitTestSourceRequested = false;
  let referenceSpace = null;
  let placed = false;
  let hasHit = false;
  const scanDots = [];
  let lastDotTime = 0;
  let lastDistanceTime = 0;
  const camWorldPos = new THREE.Vector3();
  const modelWorldPos = new THREE.Vector3();

  function cleanup() {
    if (renderer) {
      renderer.setAnimationLoop(null);
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      renderer.dispose();
    }
    hitTestSource = null;
    hitTestSourceRequested = false;
    active = null;
  }

  function clearScanDots() {
    scanDots.forEach((dot) => scene.remove(dot));
    scanDots.length = 0;
  }

  function maybeSpawnDot(position) {
    if (scanDots.length >= MAX_SCAN_DOTS) return;
    const now = performance.now();
    if (now - lastDotTime < 120) return;
    lastDotTime = now;
    const material = new THREE.SpriteMaterial({ map: getDotTexture(), transparent: true, depthWrite: false });
    material.toneMapped = false;
    const dot = new THREE.Sprite(material);
    dot.scale.set(0.05, 0.05, 1);
    // Small jitter so dots scatter across the area being panned over, rather
    // than stacking at the exact center-ray hit point every time. Kept
    // small (+/-6cm) so dots read as "on the surface", not floating off it.
    dot.position.set(
      position.x + (Math.random() - 0.5) * 0.12,
      position.y + 0.003,
      position.z + (Math.random() - 0.5) * 0.12
    );
    scene.add(dot);
    scanDots.push(dot);
  }

  // A raw hit-test pose is only accurate at the instant it's read. Freezing
  // modelRoot's position from it once and never touching it again (the old
  // approach) looks anchored on a device with rock-solid tracking, but if
  // the platform ever relocalizes/corrects its understanding of where the
  // camera is (common on a device with marginal tracking, which this one
  // has already shown), a frozen position doesn't get that correction and
  // the model appears to drift or shoot away. XRAnchor exists specifically
  // to solve this: the platform keeps its pose updated to compensate for
  // relocalization, so it's used here when available, with a graceful
  // fallback to the old frozen-position behaviour if anchors aren't
  // supported on this device.
  let modelAnchor = null;
  let selectRequested = false;

  function onSelect() {
    selectRequested = true;
  }

  try {
    // Request the XR session FIRST, synchronously off the click's user
    // activation. Loading the GLB is a network fetch + parse - if we awaited
    // that before requestSession(), the tap's transient activation can
    // expire by the time we ask for the session, and Chrome silently rejects
    // it (no crash, no visible error) - which looked exactly like "nothing
    // happens, it just falls back to the native AR viewer".
    //
    // 'local' is supposed to be a spec default that doesn't need to be
    // requested explicitly, but not every device honours that - some reject
    // Three.js's internal requestReferenceSpace('local') call with
    // NotSupportedError unless 'local' is listed explicitly, so it's listed
    // here for real-world compatibility.
    //
    // Some devices also throw NotSupportedError for the whole request when
    // dom-overlay can't be granted, rather than just silently dropping that
    // one optional feature as the spec intends. Retry with hit-test + local
    // only in that case.
    const sessionPromise = navigator.xr
      .requestSession("immersive-ar", {
        requiredFeatures: ["hit-test", "local"],
        optionalFeatures: ["dom-overlay", "anchors"],
        domOverlay: { root: overlayRoot }
      })
      .catch((err) => {
        if (err && err.name === "NotSupportedError") {
          console.warn("immersive-ar with dom-overlay rejected, retrying with hit-test + local only:", err);
          return navigator.xr.requestSession("immersive-ar", {
            requiredFeatures: ["hit-test", "local"],
            optionalFeatures: ["anchors"]
          });
        }
        throw err;
      });

    const modelPromise = loadModel(modelUrl);
    modelPromise.catch(() => {}); // avoid an unhandled rejection if the session fails first

    xrSession = await sessionPromise;
    const domOverlayGranted = !!xrSession.domOverlayState;
    if (onSessionStarted) onSessionStarted({ domOverlayGranted });
    modelRoot = await modelPromise;
    modelRoot.scale.set(scale, scale, scale);
    modelRoot.visible = false; // hidden until placed - no floating preview stage

    const canvas = document.createElement("canvas");
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, canvas });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    // Three.js defaults to requesting the 'local-floor' reference space,
    // which needs floor-level tracking and must be explicitly granted as a
    // feature (unlike plain 'local', which is a spec-implicit default) -
    // that's the exact type this device was rejecting with NotSupportedError
    // even after 'local' was added to requiredFeatures. Use 'local' instead;
    // hit-test poses are still accurate in it, just relative to the
    // starting head position rather than the floor.
    renderer.xr.setReferenceSpaceType("local");
    // Without explicit color management, a GLB loaded through raw Three.js
    // can render far too dark/wrong compared to model-viewer (which handles
    // this internally) - on an already-dark anthracite model that can mean
    // effectively invisible against the camera passthrough.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();
    scene.add(camera); // needed so sprites parented to the camera actually render

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
    dirLight.position.set(1, 3, 1);
    scene.add(dirLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.9);
    fillLight.position.set(-1, 2, -1);
    scene.add(fillLight);

    reticle = createReticle();
    scene.add(reticle);

    // baseQuaternion is whatever tracking/anchoring logic thinks the
    // orientation should be; userYaw is a user-controlled spin on top of
    // that, applied via applyOrientation() everywhere baseQuaternion changes.
    let userYaw = 0;
    const baseQuaternion = new THREE.Quaternion();
    function applyOrientation() {
      const yawQuat = new THREE.Quaternion().setFromAxisAngle(UP, userYaw);
      modelRoot.quaternion.copy(baseQuaternion).multiply(yawQuat);
    }

    scene.add(modelRoot);

    hud = createHud();
    camera.add(hud.sprite);
    hud.setLines("Scan where you want your heat pump");

    canvas.style.position = "fixed";
    canvas.style.inset = "0";
    canvas.style.zIndex = "9998";
    canvas.style.touchAction = "none";
    document.body.appendChild(canvas);

    // Drag left/right to spin the model once it's placed. Also detects
    // plain taps (pointerdown+pointerup with barely any movement) and
    // treats them as "select" directly: setting
    // `canvas.style.touchAction = "none"` above (needed so drag gestures
    // aren't eaten by the browser's default scroll/zoom handling) can make
    // some WebXR implementations stop auto-firing the native session
    // "select" event for taps on that element, since touch-action:none
    // signals "the page handles this touch itself" - so tap-to-drop can't
    // rely on the native event alone.
    let dragActive = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let yawAtDragStart = 0;
    let dragMoved = false;
    const TAP_MOVE_THRESHOLD = 12; // px
    canvas.addEventListener("pointerdown", (e) => {
      dragActive = true;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      yawAtDragStart = userYaw;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!dragActive) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (!dragMoved) {
        // Don't rotate at all until the movement is big enough to count as
        // a deliberate drag rather than natural finger tremor during a tap
        // - applying rotation proportionally from pixel 1 made every tap
        // attempt visibly twitch the model.
        if (Math.abs(dx) <= TAP_MOVE_THRESHOLD && Math.abs(dy) <= TAP_MOVE_THRESHOLD) return;
        dragMoved = true;
        // Rebase so rotation continues smoothly from the current angle
        // instead of jumping by the threshold distance the instant a drag
        // is recognised.
        yawAtDragStart = userYaw - dx * ROTATE_SENSITIVITY;
      }
      userYaw = yawAtDragStart + dx * ROTATE_SENSITIVITY;
      applyOrientation();
    });
    canvas.addEventListener("pointerup", (e) => {
      if (dragActive && !dragMoved) {
        selectRequested = true;
      }
      dragActive = false;
    });
    canvas.addEventListener("pointercancel", () => {
      dragActive = false;
    });

    // Drops modelRoot at the given hit-test pose, once, at the moment of
    // placement. Only ever called with a confirmed hit - a tap while no
    // surface has been found yet is simply ignored (the HUD is already
    // telling the user to keep scanning).
    function placeModel(hitMatrix, hit) {
      placed = true;
      reticle.visible = false;
      clearScanDots();
      hud.setLines(null);

      const m = new THREE.Matrix4().fromArray(hitMatrix);
      baseQuaternion.setFromRotationMatrix(m);
      modelRoot.position.setFromMatrixPosition(m);
      modelRoot.visible = true;
      applyOrientation();

      if (hit && typeof hit.createAnchor === "function") {
        hit.createAnchor().then(
          (anchor) => {
            modelAnchor = anchor;
          },
          (err) => console.warn("createAnchor failed, staying with a fixed position:", err)
        );
      }
      if (onPlaced) onPlaced();
    }

    await renderer.xr.setSession(xrSession);
    referenceSpace = renderer.xr.getReferenceSpace();

    xrSession.addEventListener("end", () => {
      cleanup();
      if (onEnd) onEnd();
    });
    xrSession.addEventListener("select", onSelect);

    active = { xrSession };

    renderer.setAnimationLoop((_, frame) => {
      if (!frame) return;
      const session = frame.session;

      if (!hitTestSourceRequested) {
        hitTestSourceRequested = true;
        session
          .requestReferenceSpace("viewer")
          .then((viewerSpace) => session.requestHitTestSource({ space: viewerSpace }))
          .then((source) => {
            hitTestSource = source;
          })
          .catch((err) => {
            console.warn("requestHitTestSource failed:", err);
          });
      }

      if (hitTestSource && !placed) {
        const hitResults = frame.getHitTestResults(hitTestSource);
        if (hitResults.length > 0) {
          const hit = hitResults[0];
          const pose = hit.getPose(referenceSpace);
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
          if (!hasHit) {
            hasHit = true;
            hud.setLines("Tap to drop");
            if (onReadyToPlace) onReadyToPlace();
          }
          maybeSpawnDot(pose.transform.position);

          if (selectRequested) {
            selectRequested = false;
            placeModel(pose.transform.matrix, hit);
          }
        } else {
          reticle.visible = false;
          selectRequested = false; // a tap with no surface under it is a no-op, not a queued placement
          if (hasHit) {
            hasHit = false;
            hud.setLines("Scan where you want your heat pump");
            if (onScanning) onScanning();
          }
        }
      }

      // Once placed, if an anchor was granted, re-sync modelRoot to its
      // (platform-corrected) pose every frame instead of trusting the pose
      // captured at the moment of placement. Position only - baseQuaternion
      // + applyOrientation() keeps any user drag-rotation layered on top.
      if (placed) {
        if (modelAnchor) {
          const anchorPose = frame.getPose(modelAnchor.anchorSpace, referenceSpace);
          if (anchorPose) {
            const m = new THREE.Matrix4().fromArray(anchorPose.transform.matrix);
            modelRoot.position.setFromMatrixPosition(m);
            baseQuaternion.setFromRotationMatrix(m);
            applyOrientation();
          }
        }

        if (onDistance) {
          const now = performance.now();
          if (now - lastDistanceTime >= DISTANCE_UPDATE_INTERVAL_MS) {
            lastDistanceTime = now;
            camera.getWorldPosition(camWorldPos);
            modelRoot.getWorldPosition(modelWorldPos);
            onDistance(camWorldPos.distanceTo(modelWorldPos));
          }
        }
      }

      renderer.render(scene, camera);
    });
  } catch (err) {
    cleanup();
    if (onError) onError(err);
  }
}

export function endWebXRPlacement() {
  if (active && active.xrSession) {
    active.xrSession.end().catch(() => {});
  }
}

window.VaillantWebXR = { isWebXRArSupported, startWebXRPlacement, endWebXRPlacement };
