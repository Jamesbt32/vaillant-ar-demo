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

export async function isWebXRArSupported() {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

let active = null; // holds the current session's teardown state, or null

export async function startWebXRPlacement({ modelUrl, scale, overlayRoot, onScanning, onReadyToPlace, onPlaced, onEnd, onError, onSessionStarted, onDebugFrame }) {
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
        optionalFeatures: ["dom-overlay", "plane-detection", "anchors"],
        domOverlay: { root: overlayRoot }
      })
      .catch((err) => {
        if (err && err.name === "NotSupportedError") {
          console.warn("immersive-ar with dom-overlay rejected, retrying with hit-test + local only:", err);
          return navigator.xr.requestSession("immersive-ar", {
            requiredFeatures: ["hit-test", "local"],
            optionalFeatures: ["plane-detection", "anchors"]
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
    modelRoot.visible = true;

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
    // Matches the reference app: the product shows immediately as a large
    // floating preview attached to the view, even before a surface is
    // found, rather than staying hidden until hit-test succeeds. It's
    // reparented into world space (anchored to the reticle) the moment a
    // real surface is detected, and back to floating if that lock is lost.
    camera.add(modelRoot);
    modelRoot.position.set(0, -0.25, -2.2);
    modelRoot.quaternion.identity();

    hud = createHud();
    camera.add(hud.sprite);
    hud.setLines("Scan where you want your heat pump");

    canvas.style.position = "fixed";
    canvas.style.inset = "0";
    canvas.style.zIndex = "9998";
    document.body.appendChild(canvas);

    await renderer.xr.setSession(xrSession);
    referenceSpace = renderer.xr.getReferenceSpace();

    xrSession.addEventListener("end", () => {
      cleanup();
      if (onEnd) onEnd();
    });
    xrSession.addEventListener("select", onSelect);

    active = { xrSession };

    // DEBUG: temporary diagnostics for why the reticle never appears -
    // remove once the real cause is confirmed. Shown both via onDebugFrame
    // (dom-overlay debug line, works only on devices that grant it) and as
    // a second line on the in-scene HUD sprite (works everywhere).
    let hitTestSourceError = null;
    let debugFrameCount = 0;

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
            hitTestSourceError = err;
            console.warn("requestHitTestSource failed:", err);
          });
      }

      let hitCount = 0;
      if (hitTestSource && !placed) {
        const hitResults = frame.getHitTestResults(hitTestSource);
        hitCount = hitResults.length;
        if (hitResults.length > 0) {
          const hit = hitResults[0];
          const pose = hit.getPose(referenceSpace);
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
          if (!hasHit) {
            // Lock found: switch the model from floating-with-camera to
            // anchored-in-world-space at the reticle.
            camera.remove(modelRoot);
            scene.add(modelRoot);
            hasHit = true;
            hud.setLines("Tap to drop");
            if (onReadyToPlace) onReadyToPlace();
          }
          modelRoot.position.setFromMatrixPosition(reticle.matrix);
          modelRoot.quaternion.setFromRotationMatrix(reticle.matrix);
          maybeSpawnDot(pose.transform.position);

          if (selectRequested) {
            selectRequested = false;
            placed = true;
            reticle.visible = false;
            clearScanDots();
            hud.setLines(null);
            if (typeof hit.createAnchor === "function") {
              hit.createAnchor().then(
                (anchor) => {
                  modelAnchor = anchor;
                },
                (err) => console.warn("createAnchor failed, staying with a fixed position:", err)
              );
            }
            if (onPlaced) onPlaced();
          }
        } else {
          reticle.visible = false;
          if (hasHit) {
            // Lock lost: go back to floating with the camera rather than
            // hiding the model - matches the reference app always showing
            // the product during scanning, and means losing tracking
            // doesn't make the whole preview disappear.
            scene.remove(modelRoot);
            camera.add(modelRoot);
            modelRoot.position.set(0, -0.25, -2.2);
            modelRoot.quaternion.identity();
            hasHit = false;
            hud.setLines("Scan where you want your heat pump");
            if (onScanning) onScanning();
          }
        }
      }

      // A tap while still floating (no confirmed hit-test lock) would
      // otherwise just set selectRequested and never get consumed, since
      // the real-hit path above is the only place it was handled - leaving
      // "tap to drop" completely non-functional on a device where hit-test
      // never locks on. Drop it wherever it's currently floating instead;
      // an estimated position the user can see and confirm is better than
      // a placement flow that silently never works.
      if (selectRequested && !placed) {
        selectRequested = false;
        placed = true;
        reticle.visible = false;
        clearScanDots();
        hud.setLines(null);
        if (modelRoot.parent === camera) {
          const worldPos = new THREE.Vector3();
          const worldQuat = new THREE.Quaternion();
          modelRoot.getWorldPosition(worldPos);
          modelRoot.getWorldQuaternion(worldQuat);
          camera.remove(modelRoot);
          scene.add(modelRoot);
          modelRoot.position.copy(worldPos);
          modelRoot.quaternion.copy(worldQuat);
        }
        if (onPlaced) onPlaced();
      }

      // Once placed, if an anchor was granted, re-sync modelRoot to its
      // (platform-corrected) pose every frame instead of trusting the pose
      // captured at the moment of placement.
      if (placed && modelAnchor) {
        const anchorPose = frame.getPose(modelAnchor.anchorSpace, referenceSpace);
        if (anchorPose) {
          const m = new THREE.Matrix4().fromArray(anchorPose.transform.matrix);
          modelRoot.position.setFromMatrixPosition(m);
          modelRoot.quaternion.setFromRotationMatrix(m);
        }
      }

      debugFrameCount++;
      if (debugFrameCount % 20 === 0 && !placed) {
        // DEBUG: independent second signal - if frame.detectedPlanes finds
        // planes while hit-test still returns 0, that points to a hit-test-
        // specific bug rather than a tracking/environment problem.
        const planesInfo = frame.detectedPlanes ? `planes:${frame.detectedPlanes.size}` : "planes:n/a";
        const debugLine = `hts:${hitTestSource ? "ok" : "waiting"}${hitTestSourceError ? " ERR:" + hitTestSourceError.name : ""} hits:${hitCount} ${planesInfo} ovl:${domOverlayGranted ? "y" : "n"}`;
        hud.setLines([hasHit ? "Tap to drop" : "Scan where you want your heat pump", debugLine]);
        if (onDebugFrame) {
          onDebugFrame({
            domOverlayGranted,
            hitTestSourceReady: !!hitTestSource,
            hitTestSourceError: hitTestSourceError ? `${hitTestSourceError.name}: ${hitTestSourceError.message}` : null,
            hitCount,
            placed
          });
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
