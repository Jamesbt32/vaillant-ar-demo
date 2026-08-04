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

export async function startWebXRPlacement({ modelUrl, scale, overlayRoot, onScanning, onReadyToPlace, onPlaced, onEnd, onError }) {
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
    modelRoot = await loadModel(modelUrl);
    modelRoot.scale.set(scale, scale, scale);
    modelRoot.visible = false;

    const canvas = document.createElement("canvas");
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, canvas });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.3));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 2, 1);
    scene.add(dirLight);

    reticle = createReticle();
    scene.add(reticle);
    scene.add(modelRoot);

    xrSession = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: overlayRoot }
    });

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

window.VaillantWebXROriginal = { isWebXRArSupported, startWebXRPlacement, endWebXRPlacement };
