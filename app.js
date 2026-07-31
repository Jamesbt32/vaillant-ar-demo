/* ---------------------------------------------------------------------
 * Product data
 * -------------------------------------------------------------------*/
const SHARED_IMAGE = "assets/device-arotherm-render.png";
const SHARED_MODEL = "assets/models/arotherm-plus.glb";

const products = [
  {
    id: "arotherm-plus",
    name: "aroTHERM plus",
    category: "Heat pumps",
    headline: "Ultra-efficient air-to-water heat pump",
    summary:
      "Designed for future-ready homes with whisper-quiet operation, premium seasonal efficiency and intuitive controls.",
    features: ["High energy efficiency", "Future proof", "SCOP up to 4.8", "Smart home compatibility"],
    image: SHARED_IMAGE,
    model: SHARED_MODEL,
    hasNoise: true,
    mounts: ["Wall mount", "Ground mount"],
    variants: [
      { label: "3/5 kW", lwa: 55 },
      { label: "7 kW", lwa: 58 },
      { label: "10/12 kW", lwa: 61 }
    ]
  },
  {
    id: "arotherm-pro",
    name: "aroTHERM pro",
    category: "Heat pumps",
    headline: "High-capacity heat pump for larger homes",
    summary:
      "Steps up output for larger properties and commercial-scale retrofit, while keeping the same whisper-quiet, future-ready design.",
    features: ["Higher output range", "Future proof", "Multi-unit cascade ready", "Smart home compatibility"],
    image: SHARED_IMAGE,
    model: SHARED_MODEL,
    hasNoise: true,
    mounts: ["Wall mount", "Ground mount"],
    variants: [
      { label: "6 kW", lwa: 57 },
      { label: "12 kW", lwa: 60 },
      { label: "19 kW", lwa: 64 }
    ]
  }
];

const topicContent = {
  functionalities: {
    title: "Functionalities of a heat pump",
    html: `
      <h3>How a heat pump works</h3>
      <p>A heat pump moves heat from the outside air into your home using a refrigerant cycle, rather than
      burning fuel to create it. Even in cold weather there is usable heat energy in the air outside.</p>
      <h3>The refrigerant cycle</h3>
      <p>Refrigerant absorbs heat from the outside air and evaporates into a gas. A compressor raises its
      pressure and temperature, a heat exchanger transfers that heat into your heating circuit, and an
      expansion valve drops the pressure back down so the cycle can repeat.</p>
      <h3>Efficiency (SCOP)</h3>
      <p>Seasonal Coefficient of Performance (SCOP) describes how many units of heat are delivered per unit
      of electricity used across a typical year. A SCOP of 4 means 4 kWh of heat for every 1 kWh of
      electricity consumed.</p>
    `
  },
  references: {
    title: "References",
    html: `
      <h3>Standards used in this app</h3>
      <p><strong>MCS 020</strong> — MCS Planning Standards noise assessment procedure for air source heat
      pumps installed under Permitted Development in England, Wales and Scotland.</p>
      <p><strong>Hemispherical spreading model</strong> — sound power level is converted to a predicted
      sound pressure level at a receptor distance using inverse-square-law spreading over a hemisphere
      (Q = 2) or a corner reflection (Q = 4).</p>
      <h3>Disclaimer</h3>
      <p>Sound power levels shown in this demo are indicative. Always confirm the declared L<sub>WA</sub>
      value from the current product datasheet before using this tool to support a planning submission.</p>
    `
  }
};

const MCS020_DEFAULT_THRESHOLD = 42;

/* ---------------------------------------------------------------------
 * Acoustic helpers (shared by the live AR sound view and the MCS 020 tool)
 * -------------------------------------------------------------------*/
function predictedSpl(lwa, distanceM, units, q) {
  const d = Math.max(distanceM, 0.1);
  return lwa + 10 * Math.log10(units) + 10 * Math.log10(q / (4 * Math.PI * d * d));
}

function minCompliantDistance(lwa, thresholdDb, units, q) {
  const exponent = (thresholdDb - lwa - 10 * Math.log10(units)) / 10;
  const value = q / (4 * Math.PI * Math.pow(10, exponent));
  return Math.sqrt(Math.max(value, 0));
}

/* ---------------------------------------------------------------------
 * App state
 * -------------------------------------------------------------------*/
const state = {
  screen: "splash",
  listFilter: "All",
  activeProduct: products[0],
  activeVariantIndex: 0,
  activeMountIndex: 0,
  soundConfirmed: false,
  silentMode: false
};

/* ---------------------------------------------------------------------
 * Generic helpers
 * -------------------------------------------------------------------*/
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let toastTimer = null;
function showToast(message, duration = 2200) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

function showScreen(name) {
  state.screen = name;
  $$(".screen").forEach((el) => el.classList.toggle("active", el.dataset.screen === name));
}

$$("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.back));
});

/* ---------------------------------------------------------------------
 * Splash
 * -------------------------------------------------------------------*/
$("#splashContinue").addEventListener("click", () => showScreen("menu"));

/* ---------------------------------------------------------------------
 * Menu: carousel + topic list
 * -------------------------------------------------------------------*/
function renderCarousel() {
  const carousel = $("#carousel");
  const dots = $("#carouselDots");
  carousel.innerHTML = products
    .map((p) => `<div class="carousel-card"><img src="${p.image}" alt="${p.name}" /><span>${p.name}</span></div>`)
    .join("");
  dots.innerHTML = products.map((_, i) => `<span class="${i === 0 ? "active" : ""}"></span>`).join("");

  carousel.addEventListener("scroll", () => {
    const cardWidth = carousel.firstElementChild.getBoundingClientRect().width + 14;
    const index = Math.round(carousel.scrollLeft / cardWidth);
    $$("#carouselDots span").forEach((dot, i) => dot.classList.toggle("active", i === index));
  });
}

$$("#topicList li").forEach((li) => {
  li.addEventListener("click", () => {
    const topic = li.dataset.topic;
    if (topic === "products") {
      state.listFilter = "All";
      renderFilters();
      renderProductGrid();
      showScreen("list");
    } else {
      const content = topicContent[topic];
      $("#topicTitle").textContent = content.title;
      $("#topicBody").innerHTML = content.html;
      showScreen("topic");
    }
  });
});

/* ---------------------------------------------------------------------
 * Product list
 * -------------------------------------------------------------------*/
const categories = ["All", ...new Set(products.map((p) => p.category))];

function renderFilters() {
  const filters = $("#filters");
  if (categories.length <= 2) {
    filters.innerHTML = "";
    filters.style.display = "none";
    return;
  }
  filters.style.display = "";
  filters.innerHTML = categories
    .map((c) => `<button class="filter-btn ${c === state.listFilter ? "active" : ""}" data-filter="${c}">${c}</button>`)
    .join("");
}

function renderProductGrid() {
  const visible = products.filter((p) => state.listFilter === "All" || p.category === state.listFilter);
  $("#productsGrid").innerHTML = visible
    .map(
      (p) => `
      <article class="product-card" data-product-id="${p.id}">
        <div class="thumb"><img src="${p.image}" alt="${p.name}" /></div>
        <h3>${p.name}</h3>
        <p>${p.headline}</p>
      </article>`
    )
    .join("");
}

$("#filters").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  state.listFilter = btn.dataset.filter;
  renderFilters();
  renderProductGrid();
});

$("#productsGrid").addEventListener("click", (e) => {
  const card = e.target.closest(".product-card");
  if (!card) return;
  openProductDetail(card.dataset.productId);
});

/* ---------------------------------------------------------------------
 * Product detail
 * -------------------------------------------------------------------*/
function openProductDetail(productId) {
  const product = products.find((p) => p.id === productId);
  if (!product) return;
  state.activeProduct = product;
  state.activeVariantIndex = 0;
  state.activeMountIndex = 0;

  $("#detailTitle").textContent = product.name;
  $("#detailImage").src = product.image;
  $("#detailImage").alt = product.name;
  $("#detailBadgeA").textContent = product.features[0] || product.headline;
  $("#detailBadgeB").textContent = product.features[1] || "Future proof";
  $("#detailSummary").textContent = product.summary;
  $("#detailFeatures").innerHTML = product.features.map((f) => `<li>${f}</li>`).join("");
  $("#moreDetailsPanel").classList.remove("open");
  $("#openMcsFromDetail").style.display = product.hasNoise ? "block" : "none";

  showScreen("detail");
}

$("#moreDetailsToggle").addEventListener("click", () => {
  $("#moreDetailsPanel").classList.toggle("open");
});

$("#openMcsFromDetail").addEventListener("click", () => {
  const product = state.activeProduct;
  const variant = product.variants[state.activeVariantIndex] || product.variants[0];
  openMcsModal({ lwa: variant ? variant.lwa : 55, distance: 3 });
});

$("#placeProductBtn").addEventListener("click", () => {
  enterArScreen();
});

/* ---------------------------------------------------------------------
 * AR screen
 * -------------------------------------------------------------------*/
const arViewport = $("#arViewport");
const arVideo = $("#arVideo");
const arNoVideo = $("#arNoVideo");
const arObject = $("#arObject");
const arObjectImage = $("#arObjectImage");
const arScanHint = $("#arScanHint");
const arGestureHint = $("#arGestureHint");
const scaleBadge = $("#scaleBadge");
const mvViewer = $("#mvViewer");
let mvModeActive = false;
const dbReadout = $("#dbReadout");

let mediaStream = null;
let objectPlaced = false;
let objX = 0;
let objY = 0;
let objScale = 1;
let objRotation = 0;
const BASE_DISTANCE_M = 2; // metres represented by scale = 1 (100%)

const pointers = new Map();
let dragBaseline = null; // {startPointerX, startPointerY, startObjX, startObjY}
let pinchBaseline = null; // {startDist, startAngle, startScale, startRotation}

let hintTimers = [];
function clearHints() {
  hintTimers.forEach((t) => clearTimeout(t));
  hintTimers = [];
  arGestureHint.classList.remove("show");
}

function playGestureHints() {
  clearHints();
  const sequence = [
    "Drag your finger to move the object",
    "Pinch to scale the product",
    "Drag with two fingers to rotate the object"
  ];
  let delay = 300;
  sequence.forEach((text, i) => {
    hintTimers.push(
      setTimeout(() => {
        arGestureHint.textContent = text;
        arGestureHint.classList.add("show");
      }, delay)
    );
    delay += 2600;
    hintTimers.push(setTimeout(() => arGestureHint.classList.remove("show"), delay - 300));
  });
}

function applyObjectTransform() {
  arObject.style.left = `${objX}px`;
  arObject.style.top = `${objY}px`;
  arObject.style.transform = `translate(-50%, -50%) scale(${objScale}) rotate(${objRotation}deg)`;
}

function currentDistanceM() {
  if (mvModeActive) {
    const orbit = mvViewer.getCameraOrbit();
    return orbit.radius;
  }
  return BASE_DISTANCE_M / Math.max(objScale, 0.05);
}

function updateDbReadoutIfVisible() {
  if (!dbReadout.classList.contains("show")) return;
  const product = state.activeProduct;
  const variant = product.variants[state.activeVariantIndex];
  const lwa = variant ? variant.lwa : 50;
  const distance = currentDistanceM();
  const spl = state.silentMode ? -Infinity : predictedSpl(lwa, distance, 1, 2);
  $("#dbNumber").textContent = state.silentMode ? "--" : spl.toFixed(1);
  $("#dbDistance").textContent = `Current distance: ${distance.toFixed(2)}m`;
  updateHumVolume(state.silentMode ? -Infinity : spl);
}

function showScaleBadge() {
  scaleBadge.textContent = `${Math.round(objScale * 100)}%`;
  scaleBadge.classList.add("show");
  clearTimeout(showScaleBadge._t);
  showScaleBadge._t = setTimeout(() => scaleBadge.classList.remove("show"), 900);
}

function resetGestureState() {
  pointers.clear();
  dragBaseline = null;
  pinchBaseline = null;
  objectPlaced = false;
  objX = 0;
  objY = 0;
  objScale = 1;
  objRotation = 0;
  arObject.classList.remove("placed");
}

function clampObjectPosition() {
  const rect = arViewport.getBoundingClientRect();
  const margin = 40; // keep at least this much of the object reachable/visible
  objX = Math.min(Math.max(objX, margin), Math.max(rect.width - margin, margin));
  objY = Math.min(Math.max(objY, margin), Math.max(rect.height - margin, margin));
}

function placeObjectAt(x, y) {
  objX = x;
  objY = y;
  objScale = 1;
  objRotation = 0;
  objectPlaced = true;
  arObject.classList.add("placed");
  arScanHint.style.display = "none";
  applyObjectTransform();
  playGestureHints();

  // allow placing and immediately dragging in one continuous touch
  dragBaseline = { start: { x, y }, objX, objY };
}

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function pointAngle(a, b) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

// Safety net: on some browsers pointerdown-based placement can be swallowed
// (e.g. iOS Safari text-selection/callout gestures). A plain click always
// fires for a genuine tap, and placeObjectAt() is a no-op if already placed.
arViewport.addEventListener("click", (e) => {
  if (mvModeActive || objectPlaced) return;
  if (e.target.closest("button, .ar-bottom, .ar-topbar, .db-readout")) return;
  const rect = arViewport.getBoundingClientRect();
  placeObjectAt(e.clientX - rect.left, e.clientY - rect.top);
});

arViewport.addEventListener("pointerdown", (e) => {
  if (mvModeActive) return; // model-viewer owns gestures for real 3D models
  if (e.target.closest("button, .ar-bottom, .ar-topbar, .db-readout")) return;
  arViewport.setPointerCapture(e.pointerId);
  const rect = arViewport.getBoundingClientRect();
  const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

  if (!objectPlaced) {
    placeObjectAt(point.x, point.y);
    pointers.set(e.pointerId, point);
    return;
  }

  pointers.set(e.pointerId, point);

  if (pointers.size === 1) {
    dragBaseline = { start: { ...point }, objX, objY };
    pinchBaseline = null;
  } else if (pointers.size === 2) {
    const pts = Array.from(pointers.values());
    pinchBaseline = {
      dist: pointDistance(pts[0], pts[1]),
      angle: pointAngle(pts[0], pts[1]),
      scale: objScale,
      rotation: objRotation
    };
    dragBaseline = null;
  }
});

arViewport.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const rect = arViewport.getBoundingClientRect();
  const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  pointers.set(e.pointerId, point);

  if (pointers.size === 1 && dragBaseline) {
    objX = dragBaseline.objX + (point.x - dragBaseline.start.x);
    objY = dragBaseline.objY + (point.y - dragBaseline.start.y);
    clampObjectPosition();
    applyObjectTransform();
  } else if (pointers.size === 2 && pinchBaseline) {
    const pts = Array.from(pointers.values());
    const dist = pointDistance(pts[0], pts[1]);
    const angle = pointAngle(pts[0], pts[1]);
    objScale = Math.min(2.5, Math.max(0.4, pinchBaseline.scale * (dist / pinchBaseline.dist)));
    objRotation = pinchBaseline.rotation + (angle - pinchBaseline.angle);
    applyObjectTransform();
    showScaleBadge();
    updateDbReadoutIfVisible();
  }
});

function releasePointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    const [remaining] = pointers.values();
    dragBaseline = { start: { ...remaining }, objX, objY };
    pinchBaseline = null;
  } else if (pointers.size === 0) {
    dragBaseline = null;
    pinchBaseline = null;
  }
}
arViewport.addEventListener("pointerup", releasePointer);
arViewport.addEventListener("pointercancel", releasePointer);
arViewport.addEventListener("lostpointercapture", releasePointer);

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    arVideo.srcObject = mediaStream;
    arNoVideo.classList.remove("show");
  } catch (err) {
    arNoVideo.classList.add("show");
  }
}

function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

function renderVariantPills() {
  const product = state.activeProduct;
  const wrap = $("#variantPills");
  if (!product.variants.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = product.variants
    .map((v, i) => `<button class="variant-pill ${i === state.activeVariantIndex ? "active" : ""}" data-index="${i}">${v.label}</button>`)
    .join("");
}

function renderMountPills() {
  const product = state.activeProduct;
  $("#mountPills").innerHTML = product.mounts
    .map(
      (m, i) => `
      <button class="mount-pill ${i === state.activeMountIndex ? "active" : ""}" data-index="${i}">
        <span class="check">&#10003;</span>${m}
      </button>`
    )
    .join("");
}

$("#variantPills").addEventListener("click", (e) => {
  const btn = e.target.closest(".variant-pill");
  if (!btn) return;
  state.activeVariantIndex = Number(btn.dataset.index);
  renderVariantPills();
  updateDbReadoutIfVisible();
});

$("#mountPills").addEventListener("click", (e) => {
  const btn = e.target.closest(".mount-pill");
  if (!btn) return;
  state.activeMountIndex = Number(btn.dataset.index);
  renderMountPills();
});

function enterFlatMode(product) {
  mvModeActive = false;
  arViewport.classList.remove("mv-mode");
  resetGestureState();
  arObjectImage.src = product.image;
  arObjectImage.alt = product.name;
  arScanHint.style.display = "flex";
  clearHints();
  startCamera();
}

function enterMvMode(product) {
  mvModeActive = true;
  arViewport.classList.add("mv-mode");
  stopCamera();
  clearHints();
  mvViewer.src = product.model;
}

function enterArScreen() {
  const product = state.activeProduct;
  $("#arProductName").textContent = product.name;

  dbReadout.classList.remove("show");
  state.soundConfirmed = false;
  state.silentMode = false;
  $("#silentModeToggle").checked = false;

  $("#soundFab").style.display = product.hasNoise ? "flex" : "none";
  const view3dBtn = $("#view3dToggle");
  view3dBtn.style.display = product.model ? "flex" : "none";
  view3dBtn.textContent = "View true 3D";

  renderVariantPills();
  renderMountPills();

  enterFlatMode(product);

  showScreen("ar");
}

$("#view3dToggle").addEventListener("click", () => {
  const product = state.activeProduct;
  if (mvModeActive) {
    $("#view3dToggle").textContent = "View true 3D";
    enterFlatMode(product);
  } else {
    $("#view3dToggle").textContent = "Back to camera view";
    enterMvMode(product);
  }
});

mvViewer.addEventListener("camera-change", () => updateDbReadoutIfVisible());

$("#arCloseBtn").addEventListener("click", () => {
  stopCamera();
  stopHum();
  clearHints();
  showScreen("detail");
});

/* ---------------------------------------------------------------------
 * Sound simulation (modal + WebAudio hum tied to predicted dB)
 * -------------------------------------------------------------------*/
let audioCtx = null;
let humOsc = null;
let humGain = null;

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  humOsc = audioCtx.createOscillator();
  humOsc.type = "sawtooth";
  humOsc.frequency.value = 110;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 400;
  humGain = audioCtx.createGain();
  humGain.gain.value = 0;
  humOsc.connect(filter).connect(humGain).connect(audioCtx.destination);
  humOsc.start();
}

function updateHumVolume(splDb) {
  if (!humGain) return;
  const masterVolume = Number($("#volumeSlider").value) / 100;
  if (!isFinite(splDb) || masterVolume === 0) {
    humGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
    return;
  }
  const normalized = Math.min(1, Math.max(0, (splDb - 25) / 40));
  humGain.gain.setTargetAtTime(normalized * masterVolume * 0.22, audioCtx.currentTime, 0.08);
}

function stopHum() {
  if (humGain) humGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
}

$("#soundFab").addEventListener("click", () => {
  $("#soundModal").classList.add("show");
});

$("#confirmSoundBtn").addEventListener("click", () => {
  ensureAudioGraph();
  if (audioCtx.state === "suspended") audioCtx.resume();
  state.soundConfirmed = true;
  $("#soundModal").classList.remove("show");
  dbReadout.classList.add("show");
  updateDbReadoutIfVisible();
  showToast("Sound simulation active");
});

$("#silentModeToggle").addEventListener("change", (e) => {
  state.silentMode = e.target.checked;
  updateDbReadoutIfVisible();
});

$("#volumeSlider").addEventListener("input", () => updateDbReadoutIfVisible());

/* ---------------------------------------------------------------------
 * Capture (screenshot of camera feed + placed object)
 * -------------------------------------------------------------------*/
$("#captureFab").addEventListener("click", () => {
  if (mvModeActive) {
    const dataUrl = mvViewer.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `${state.activeProduct.id}-showpoint.png`;
    a.click();
    showToast("Photo saved");
    return;
  }

  const canvas = $("#arCanvas");
  const rect = arViewport.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");

  if (mediaStream && arVideo.videoWidth) {
    const videoAspect = arVideo.videoWidth / arVideo.videoHeight;
    const viewAspect = rect.width / rect.height;
    let dw = rect.width, dh = rect.height, dx = 0, dy = 0;
    if (videoAspect > viewAspect) {
      dh = rect.height;
      dw = dh * videoAspect;
      dx = (rect.width - dw) / 2;
    } else {
      dw = rect.width;
      dh = dw / videoAspect;
      dy = (rect.height - dh) / 2;
    }
    ctx.drawImage(arVideo, dx, dy, dw, dh);
  } else {
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (objectPlaced) {
    const img = arObjectImage;
    const w = arObject.getBoundingClientRect().width / objScale;
    const h = w * (img.naturalHeight / img.naturalWidth || 1);
    ctx.save();
    ctx.translate(objX, objY);
    ctx.rotate((objRotation * Math.PI) / 180);
    ctx.scale(objScale, objScale);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.activeProduct.id}-showpoint.png`;
    a.click();
    URL.revokeObjectURL(url);
  });
  showToast("Photo saved");
});

/* ---------------------------------------------------------------------
 * MCS 020 noise compliance modal
 * -------------------------------------------------------------------*/
const mcsModal = $("#mcsModal");

function openMcsModal({ lwa, distance }) {
  $("#mcsLwa").value = lwa;
  $("#mcsDistance").value = distance;
  $("#mcsUnits").value = 1;
  $("#mcsThreshold").value = MCS020_DEFAULT_THRESHOLD;
  const mountName = (state.activeProduct.mounts[state.activeMountIndex] || "").toLowerCase();
  $("#mcsDirectivity").value = mountName.includes("ground") ? "4" : "2";
  $("#mcsResult").classList.remove("show");
  mcsModal.classList.add("show");
}

$("#openMcsFromAr").addEventListener("click", () => {
  const product = state.activeProduct;
  const variant = product.variants[state.activeVariantIndex];
  openMcsModal({
    lwa: variant ? variant.lwa : 55,
    distance: Number(currentDistanceM().toFixed(2))
  });
});

$("#mcsCloseBtn").addEventListener("click", () => mcsModal.classList.remove("show"));

$("#mcsCalculateBtn").addEventListener("click", () => {
  const lwa = Number($("#mcsLwa").value);
  const distance = Number($("#mcsDistance").value);
  const units = Math.max(1, Number($("#mcsUnits").value) || 1);
  const q = Number($("#mcsDirectivity").value);
  const threshold = Number($("#mcsThreshold").value);

  const predicted = predictedSpl(lwa, distance, units, q);
  const passes = predicted <= threshold;
  const minDistance = minCompliantDistance(lwa, threshold, units, q);

  $("#mcsPredicted").textContent = predicted.toFixed(1);
  const badge = $("#mcsPassBadge");
  badge.textContent = passes ? "PASS" : "FAIL";
  badge.className = `mcs-pass-badge ${passes ? "pass" : "fail"}`;

  $("#mcsNote").textContent = passes
    ? `Compliant with a ${(threshold - predicted).toFixed(1)} dB(A) margin at ${distance}m.`
    : `Move the unit to at least ${minDistance.toFixed(2)}m from this receptor to comply (currently ${distance}m).`;

  $("#mcsResult").classList.add("show");
});

/* ---------------------------------------------------------------------
 * Init
 * -------------------------------------------------------------------*/
renderCarousel();
renderFilters();
renderProductGrid();
showScreen("splash");
