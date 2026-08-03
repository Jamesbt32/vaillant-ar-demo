/* ---------------------------------------------------------------------
 * Product data
 * -------------------------------------------------------------------*/
// versioned query string busts stale browser/CDN caches whenever this asset is replaced
const SHARED_IMAGE = "assets/device-arotherm-render.png?v=5";
const SHARED_MODEL = "assets/models/arotherm-plus.glb";
const REFERENCE_HEIGHT_MM = 765; // real height of the 3.5/5kW case the 3D model was scanned from

// Real Vaillant aroTHERM plus datasheet figures (width 1100mm / depth 450mm on every
// variant; height and sound power both scale up with output). heightMm drives the
// on-screen size difference between variants; lwa is the declared sound power level.
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
    mounts: ["Floor mount", "Wall mount"],
    variants: [
      { label: "3.5/5 kW", lwa: 54, heightMm: 765 },
      { label: "7 kW", lwa: 55, heightMm: 965 },
      { label: "10/12 kW", lwa: 60, heightMm: 1565 }
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
    mounts: ["Floor mount", "Wall mount"],
    // Real datasheet figures: VWL 55/7 & VWL 75/7 share a 750mm case (1104mm wide,
    // 454mm deep); VWL 115/7 steps up to 1103mm (1169mm wide). Sound power for the
    // 5/7kW case is the confirmed published value; the 11kW figure isn't published
    // yet (this variant was still pre-order at last check) so it's an estimate
    // extrapolated from the plus range's small-to-large case increase - verify
    // against the datasheet once Vaillant publishes it.
    variants: [
      { label: "5 kW", lwa: 49, heightMm: 750 },
      { label: "7 kW", lwa: 49, heightMm: 750 },
      { label: "11 kW", lwa: 55, heightMm: 1103 }
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

function slideToScreen(fromName, toName, durationMs = 420) {
  const fromEl = document.querySelector(`[data-screen="${fromName}"]`);
  const toEl = document.querySelector(`[data-screen="${toName}"]`);

  toEl.classList.add("active", "slide-in-start");
  void toEl.offsetWidth; // force reflow so the starting position is applied first
  fromEl.classList.add("slide-out");
  toEl.classList.remove("slide-in-start");
  toEl.classList.add("slide-in");

  setTimeout(() => {
    fromEl.classList.remove("active", "slide-out");
    toEl.classList.remove("slide-in");
    state.screen = toName;
  }, durationMs);
}

$$("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.back));
});

/* ---------------------------------------------------------------------
 * Splash
 * -------------------------------------------------------------------*/
$("#splashContinue").addEventListener("click", () => slideToScreen("splash", "menu"));

/* ---------------------------------------------------------------------
 * Menu: carousel + topic list
 * -------------------------------------------------------------------*/
function renderCarousel() {
  const carousel = $("#carousel");
  const dots = $("#carouselDots");
  carousel.innerHTML = products
    .map(
      (p) =>
        `<div class="carousel-card" data-product-id="${p.id}"><img src="${p.image}" alt="${p.name}" /><span>${p.name}</span></div>`
    )
    .join("");
  dots.innerHTML = products.map((_, i) => `<span class="${i === 0 ? "active" : ""}"></span>`).join("");

  let lastActiveCardIndex = 0;
  let scrollBounceTimer = null;
  carousel.addEventListener("scroll", () => {
    const cardWidth = carousel.firstElementChild.getBoundingClientRect().width + 14;
    const index = Math.round(carousel.scrollLeft / cardWidth);
    $$("#carouselDots span").forEach((dot, i) => dot.classList.toggle("active", i === index));

    // debounce so the bounce plays once the swipe actually settles on a new card
    clearTimeout(scrollBounceTimer);
    scrollBounceTimer = setTimeout(() => {
      if (index === lastActiveCardIndex) return;
      lastActiveCardIndex = index;
      const cards = $$(".carousel-card");
      const activeImg = cards[index] && cards[index].querySelector("img");
      if (!activeImg) return;
      activeImg.classList.remove("bounce");
      void activeImg.offsetWidth; // restart the animation if it's still running
      activeImg.classList.add("bounce");
    }, 120);
  });

  // Tapping a heat pump image jumps straight into the AR/drop screen for it.
  carousel.addEventListener("click", (e) => {
    const card = e.target.closest(".carousel-card");
    if (!card) return;
    openProductDetail(card.dataset.productId);
    enterArScreen();
  });
}

$(".topic-highlight").addEventListener("click", () => showScreen("list"));

$$("#topicList li:not(.topic-highlight)").forEach((li) => {
  li.addEventListener("click", () => {
    const content = topicContent[li.dataset.topic];
    $("#topicTitle").textContent = content.title;
    $("#topicBody").innerHTML = content.html;
    showScreen("topic");
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
 * AR screen (model-viewer: real WebXR / Scene Viewer / Quick Look AR when
 * the device and browser support it, orbit-able 3D inspector otherwise)
 * -------------------------------------------------------------------*/
const arViewport = $("#arViewport");
const mvViewer = $("#mvViewer");
const dbReadout = $("#dbReadout");
const distanceSlider = $("#distanceSlider");
const xrOverlay = $("#xrOverlay");
const xrScanNote = $("#xrScanNote");
const xrTapNote = $("#xrTapNote");
const xrScanDots = $("#xrScanDots");

function spawnScanDots() {
  xrScanDots.innerHTML = "";
  for (let i = 0; i < 22; i++) {
    const dot = document.createElement("span");
    dot.className = "scan-dot";
    dot.style.left = `${8 + Math.random() * 84}%`;
    dot.style.top = `${18 + Math.random() * 64}%`;
    dot.style.animationDelay = `${Math.random() * 1.8}s`;
    xrScanDots.appendChild(dot);
  }
  xrScanDots.classList.add("show");
}

function clearScanDots() {
  xrScanDots.classList.remove("show");
  xrScanDots.innerHTML = "";
}

// On WebXR-capable devices (Chrome/Android with ARCore) we drive the AR
// session ourselves via raw hit-testing (see webxr-ar.js), because that's
// the only way to control the exact moment the model appears (once a
// surface is found) versus when it's confirmed (only on tap) - model-viewer's
// own AR mode doesn't expose those two moments separately. Everywhere else
// (iOS Safari, desktop) we fall back to model-viewer's native handoff
// (Quick Look / Scene Viewer), which brings its own native placement UI.
$("#mvArButton").addEventListener("click", async () => {
  const supported = window.VaillantWebXR && (await window.VaillantWebXR.isWebXRArSupported());
  if (supported) {
    startCustomArSession();
  } else {
    console.warn("WebXR immersive-ar not supported here, using device AR viewer");
    // DEBUG: a toast can be swept away instantly when the device switches to
    // Scene Viewer/Quick Look, so this uses a blocking alert instead - it's
    // temporary instrumentation to find out why the custom overlay never
    // engages. Remove once the real cause is confirmed.
    alert("DEBUG: WebXR not supported here - using device AR viewer");
    mvViewer.activateAR();
  }
});

// DEBUG: model-viewer's own AR handoff (Scene Viewer/Quick Look) status,
// so we can see if/why a *second* tap of "Place in your room" silently
// fails to relaunch it. Remove once the real cause is confirmed.
mvViewer.addEventListener("ar-status", (e) => {
  console.log("model-viewer ar-status:", e.detail && e.detail.status);
  if (e.detail && e.detail.status === "failed") {
    alert("DEBUG: model-viewer AR status = failed");
  }
});

function startCustomArSession() {
  const product = state.activeProduct;
  const scale = currentVariantHeightMm() / REFERENCE_HEIGHT_MM;

  xrOverlay.classList.add("active");
  xrScanNote.classList.add("show");
  xrTapNote.classList.remove("show");
  spawnScanDots();

  window.VaillantWebXR.startWebXRPlacement({
    modelUrl: product.model,
    scale,
    overlayRoot: xrOverlay,
    onScanning: () => {
      xrScanNote.classList.add("show");
      xrTapNote.classList.remove("show");
      spawnScanDots();
    },
    onReadyToPlace: () => {
      xrScanNote.classList.remove("show");
      xrTapNote.classList.add("show");
      clearScanDots();
    },
    onPlaced: () => {
      xrTapNote.classList.remove("show");
      showToast("Placed");
    },
    onEnd: () => {
      xrOverlay.classList.remove("active");
      xrScanNote.classList.remove("show");
      xrTapNote.classList.remove("show");
      clearScanDots();
    },
    onError: (err) => {
      xrOverlay.classList.remove("active");
      clearScanDots();
      const reason = `${(err && err.name) || "Error"}: ${(err && err.message) || String(err)}`;
      console.warn("Custom WebXR placement failed, falling back to native AR:", err);
      // DEBUG: blocking alert instead of a toast, since a toast can be swept
      // away instantly when the device switches to Scene Viewer. Remove once
      // the real cause is confirmed.
      alert(`DEBUG: custom WebXR failed - ${reason}`);
      // isWebXRArSupported() only confirms a bare "immersive-ar" session is
      // possible - it doesn't guarantee the hit-test feature we need is also
      // available, so a real failure here still needs a fallback rather than
      // just stopping.
      mvViewer.activateAR();
    }
  });
}

$("#xrExitBtn").addEventListener("click", () => {
  if (window.VaillantWebXR) window.VaillantWebXR.endWebXRPlacement();
});

function currentVariantHeightMm() {
  const product = state.activeProduct;
  const variant = product.variants[state.activeVariantIndex];
  return (variant && variant.heightMm) || REFERENCE_HEIGHT_MM;
}

// model-viewer only properly auto-frames a model once, right when it first
// loads. Changing `scale` afterwards on the same live instance doesn't
// re-frame it: neither the camera-orbit/field-of-view attributes, their
// (non-existent) property setters, nor forcing a reload via src reliably
// reach the live camera once camera-controls has taken over - all three
// were tried and confirmed not to work (getCameraOrbit() kept returning the
// original radius, and the reload path left it permanently unloaded).
// Rather than keep fighting that, the inline preview stays at a single
// consistent scale (the 3.5/5kW reference case, which frames correctly),
// and the real height is shown as text instead. Actual relative sizing
// between variants only applies where it can be done correctly: our own
// WebXR placement code, which sets scale on a freshly-loaded Three.js scene
// graph rather than mutating an already-interactive model-viewer instance.
function applyVariantScale() {
  const heightM = (currentVariantHeightMm() / 1000).toFixed(2);
  $("#variantHeightNote").textContent = `Actual unit height: ${heightM}m`;
}

// The "distance" here is a manual, honestly-simulated input (see the
// Farther/Closer slider) rather than a real measured distance - a browser
// has no access to the phone's real position, only WebXR/ARCore does.
function currentDistanceM() {
  return Number(distanceSlider.value);
}

function updateDbReadoutIfVisible() {
  if (!dbReadout.classList.contains("show")) return;
  const product = state.activeProduct;
  const variant = product.variants[state.activeVariantIndex];
  const lwa = variant ? variant.lwa : 50;
  const distance = currentDistanceM();
  const spl = state.silentMode ? -Infinity : predictedSpl(lwa, distance, 1, 2);
  $("#dbNumber").textContent = state.silentMode ? "--" : spl.toFixed(1);
  $("#dbDistance").textContent = `Simulated distance: ${distance.toFixed(1)}m`;
  updateHumVolume(state.silentMode ? -Infinity : spl);
}

distanceSlider.addEventListener("input", updateDbReadoutIfVisible);

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
  applyVariantScale();
  updateDbReadoutIfVisible();
});

$("#mountPills").addEventListener("click", (e) => {
  const btn = e.target.closest(".mount-pill");
  if (!btn) return;
  state.activeMountIndex = Number(btn.dataset.index);
  renderMountPills();
});

function enterArScreen() {
  const product = state.activeProduct;
  $("#arProductName").textContent = product.name;

  dbReadout.classList.remove("show");
  state.soundConfirmed = false;
  state.silentMode = false;
  $("#silentModeToggle").checked = false;
  distanceSlider.value = 2;

  $("#soundFab").style.display = product.hasNoise ? "flex" : "none";

  renderVariantPills();
  renderMountPills();
  applyVariantScale();
  mvViewer.src = product.model;

  showScreen("ar");
}

$("#arCloseBtn").addEventListener("click", () => {
  stopHum();
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
 * Capture (screenshot of the 3D view)
 * -------------------------------------------------------------------*/
$("#captureFab").addEventListener("click", () => {
  const dataUrl = mvViewer.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `${state.activeProduct.id}-showpoint.png`;
  a.click();
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
  $("#mcsDirectivity").value = "2"; // free-standing default; user can switch to corner-mounted (Q=4)
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
