// Raw WebXR AR placement: hit-test driven, so we get full control over
// exactly when the model appears (only once a real surface is found) and
// exactly when it's confirmed (only on tap), matching real AR placement UX.
// model-viewer's own AR mode doesn't expose these two moments separately,
// which is why this bypasses it for the live AR session specifically -
// the on-page 3D preview still uses model-viewer as before.
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

export async function isWebXRArSupported() {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch {
    return false;
  }
}

let active = null; // holds the current session's teardown state, or null

export async function startWebXRPlacement({ modelUrl, scale, overlayRoot, onScanning, onReadyToPlace, onPlaced, onEnd, onError, onSessionStarted }) {
  if (active) {
    endWebXRPlacement();
  }

  let renderer, scene, camera, reticle, modelRoot, xrSession;
  let hitTestSource = null;
  let hitTestSourceRequested = false;
  let referenceSpace = null;
  let placed = false;
  let hasHit = false;

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

  function onSelect() {
    if (placed || !reticle.visible) return;
    modelRoot.position.setFromMatrixPosition(reticle.matrix);
    modelRoot.quaternion.setFromRotationMatrix(reticle.matrix);
    modelRoot.visible = true;
    reticle.visible = false;
    placed = true;
    if (onPlaced) onPlaced();
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
    // only in that case - real floor-anchored placement can still work even
    // if our HTML overlay (phone icon/scan dots/tap note) can't be drawn
    // over it.
    const sessionPromise = navigator.xr
      .requestSession("immersive-ar", {
        requiredFeatures: ["hit-test", "local"],
        optionalFeatures: ["dom-overlay"],
        domOverlay: { root: overlayRoot }
      })
      .catch((err) => {
        if (err && err.name === "NotSupportedError") {
          console.warn("immersive-ar with dom-overlay rejected, retrying with hit-test + local only:", err);
          return navigator.xr.requestSession("immersive-ar", { requiredFeatures: ["hit-test", "local"] });
        }
        throw err;
      });

    const modelPromise = loadModel(modelUrl);
    modelPromise.catch(() => {}); // avoid an unhandled rejection if the session fails first

    xrSession = await sessionPromise;
    // DEBUG: confirm whether dom-overlay actually got granted, so we know
    // whether the custom phone-icon/scan-dots overlay can render at all on
    // this device, or whether it structurally can't and needs a different
    // approach (e.g. drawing the UI inside the WebGL canvas instead of HTML).
    if (onSessionStarted) onSessionStarted({ domOverlayGranted: !!xrSession.domOverlayState });
    modelRoot = await modelPromise;
    modelRoot.scale.set(scale, scale, scale);
    modelRoot.visible = false;

    const canvas = document.createElement("canvas");
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, canvas });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    // Without explicit color management, a GLB loaded through raw Three.js
    // can render far too dark/wrong compared to model-viewer (which handles
    // this internally) - on an already-dark anthracite model that can mean
    // effectively invisible against the camera passthrough.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();

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
    scene.add(modelRoot);

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
          .catch(() => {});
      }

      if (hitTestSource && !placed) {
        const hitResults = frame.getHitTestResults(hitTestSource);
        if (hitResults.length > 0) {
          const pose = hitResults[0].getPose(referenceSpace);
          reticle.visible = true;
          reticle.matrix.fromArray(pose.transform.matrix);
          modelRoot.position.setFromMatrixPosition(reticle.matrix);
          modelRoot.quaternion.setFromRotationMatrix(reticle.matrix);
          modelRoot.visible = true;
          if (!hasHit) {
            hasHit = true;
            if (onReadyToPlace) onReadyToPlace();
          }
        } else {
          reticle.visible = false;
          if (hasHit) {
            hasHit = false;
            modelRoot.visible = false;
            if (onScanning) onScanning();
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
