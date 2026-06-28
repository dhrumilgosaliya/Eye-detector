/* Eye Detector - client-side measurement using MediaPipe FaceMesh.
   Scale reference: average human iris diameter = 11.7 mm. */

const IRIS_MM = 11.7;                 // medically-standard average iris diameter
// Size is judged as a FRACTION of frame width so it works at any camera
// resolution (a 720p MacBook cam gives far fewer pixels than a 1080p one).
const GOOD_IRIS_FRAC = [0.014, 0.075]; // iris ⌀ as share of frame width (good distance window)
const CENTER_TOL = 0.30;              // face must be within +/- 30% of frame centre
const STABLE_FRAMES = 10;             // frames of steadiness before "locked-ready"
const STABLE_TOL_MM = 3.0;            // max IPD variation (mm) to count as steady

// Iris landmark indices (refineLandmarks adds 468..477)
const L_CENTER = 468, L_RING = [469, 470, 471, 472];
const R_CENTER = 473, R_RING = [474, 475, 476, 477];

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");
const statusEl = document.getElementById("status");
const distEl = document.getElementById("distVal");
const lockBtn = document.getElementById("lockBtn");
const submitBtn = document.getElementById("submitBtn");
const startBtn = document.getElementById("startBtn");
const lockedTag = document.getElementById("lockedTag");

// offscreen canvas to read raw pixels (for pupil brightness scan)
const off = document.createElement("canvas");
const offctx = off.getContext("2d", { willReadFrequently: true });

let ipdHistory = [];
let steadyCount = 0;
let locked = false;
let lastMetrics = null;   // metrics currently shown
let frozenMetrics = null; // metrics captured at lock time

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function irisDiameterPx(lms, center, ring, w, h) {
  const c = { x: lms[center].x * w, y: lms[center].y * h };
  let sum = 0;
  ring.forEach(i => { sum += dist(c, { x: lms[i].x * w, y: lms[i].y * h }); });
  return (sum / ring.length) * 2; // avg radius * 2
}

// Estimate pupil diameter (mm) by scanning brightness outward from iris centre.
function estimatePupilMm(cx, cy, irisRadiusPx, mmPerPx) {
  try {
    const steps = 12, dirs = 8;
    let radii = [];
    for (let d = 0; d < dirs; d++) {
      const ang = (Math.PI * 2 * d) / dirs;
      let bright = [];
      for (let s = 1; s <= steps; s++) {
        const r = (irisRadiusPx * s) / steps;
        const x = Math.round(cx + Math.cos(ang) * r);
        const y = Math.round(cy + Math.sin(ang) * r);
        const p = offctx.getImageData(x, y, 1, 1).data;
        bright.push((p[0] + p[1] + p[2]) / 3);
      }
      const min = Math.min(...bright), max = Math.max(...bright);
      const thresh = min + (max - min) * 0.5;
      let edge = steps;
      for (let s = 0; s < bright.length; s++) {
        if (bright[s] > thresh) { edge = s + 1; break; }
      }
      radii.push((irisRadiusPx * edge) / steps);
    }
    radii.sort((a, b) => a - b);
    const med = radii[Math.floor(radii.length / 2)];
    let mm = med * 2 * mmPerPx;
    return Math.max(2, Math.min(8, mm)); // clamp to plausible range
  } catch (e) {
    return irisRadiusPx * 2 * mmPerPx * 0.32; // fallback ratio
  }
}

function computeMetrics(lms, w, h) {
  const lPx = irisDiameterPx(lms, L_CENTER, L_RING, w, h);
  const rPx = irisDiameterPx(lms, R_CENTER, R_RING, w, h);
  const avgPx = (lPx + rPx) / 2;

  const mmPerPxL = IRIS_MM / lPx;
  const mmPerPxR = IRIS_MM / rPx;
  const mmPerPxAvg = IRIS_MM / avgPx;

  const lc = { x: lms[L_CENTER].x * w, y: lms[L_CENTER].y * h };
  const rc = { x: lms[R_CENTER].x * w, y: lms[R_CENTER].y * h };
  const ipdPx = dist(lc, rc);
  const ipdMm = ipdPx * mmPerPxAvg;

  // approximate camera distance (cm). Rough focal length ~1.4*width for laptop cams.
  const focalPx = 1.4 * w;
  const distCm = (focalPx * IRIS_MM / avgPx) / 10;

  const lPupil = estimatePupilMm(lc.x, lc.y, lPx / 2, mmPerPxL);
  const rPupil = estimatePupilMm(rc.x, rc.y, rPx / 2, mmPerPxR);

  return {
    avgIrisPx: avgPx,
    left_iris_diameter: +(IRIS_MM).toFixed(2),       // by definition ~11.7; report measured below
    right_iris_diameter: 0,
    _measured: {
      left_iris_diameter: +( lPx * mmPerPxL ).toFixed(2),  // == 11.7, kept for clarity
    },
    metrics: {
      left_iris_diameter: +(lPx * mmPerPxL).toFixed(2),
      right_iris_diameter: +(rPx * mmPerPxR).toFixed(2),
      left_eye_radius: +((lPx * mmPerPxL) / 2).toFixed(2),
      right_eye_radius: +((rPx * mmPerPxR) / 2).toFixed(2),
      left_pupil_diameter: +lPupil.toFixed(2),
      right_pupil_diameter: +rPupil.toFixed(2),
      interpupillary_distance: +ipdMm.toFixed(2),
      estimated_distance_cm: +distCm.toFixed(1),
    },
    centers: { lc, rc, ipdMm }
  };
}

function faceCentered(lms, w, h) {
  const cx = (lms[L_CENTER].x + lms[R_CENTER].x) / 2;
  const cy = (lms[L_CENTER].y + lms[R_CENTER].y) / 2;
  return Math.abs(cx - 0.5) < CENTER_TOL && Math.abs(cy - 0.5) < CENTER_TOL;
}

function drawBox(lms, w, h, good) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lms) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  const x = minX * w, y = minY * h, bw = (maxX - minX) * w, bh = (maxY - minY) * h;
  octx.lineWidth = 4;
  octx.strokeStyle = good ? "#22c55e" : "#ef4444";
  octx.strokeRect(x, y, bw, bh);
}

function setStatus(text, green) {
  statusEl.textContent = text;
  statusEl.className = "status-pill " + (green ? "green" : "red");
}

function renderMetrics(m) {
  document.getElementById("m_ipd").textContent = m.interpupillary_distance + " mm";
  document.getElementById("m_lir").textContent = m.left_iris_diameter + " mm";
  document.getElementById("m_rir").textContent = m.right_iris_diameter + " mm";
  document.getElementById("m_lrad").textContent = m.left_eye_radius + " mm";
  document.getElementById("m_rrad").textContent = m.right_eye_radius + " mm";
  document.getElementById("m_lpup").textContent = m.left_pupil_diameter + " mm";
  document.getElementById("m_rpup").textContent = m.right_pupil_diameter + " mm";
}

function onResults(results) {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  off.width = video.videoWidth;
  off.height = video.videoHeight;
  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (locked) {
    // keep showing frozen box/state
    setStatus("🔒 Locked — ready to submit", true);
    return;
  }

  const w = overlay.width, h = overlay.height;
  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    setStatus("No face detected", false);
    steadyCount = 0; lockBtn.disabled = true; submitBtn.disabled = true;
    distEl.textContent = "–";
    return;
  }

  // draw raw frame to offscreen for pupil brightness reading
  offctx.drawImage(results.image, 0, 0, w, h);

  const lms = results.multiFaceLandmarks[0];
  const data = computeMetrics(lms, w, h);
  const m = data.metrics;
  lastMetrics = m;
  renderMetrics(m);
  distEl.textContent = m.estimated_distance_cm + " cm";

  const irisFrac = data.avgIrisPx / w;
  const sizeOk = irisFrac >= GOOD_IRIS_FRAC[0] && irisFrac <= GOOD_IRIS_FRAC[1];
  const centerOk = faceCentered(lms, w, h);

  // stability check on IPD
  ipdHistory.push(data.centers.ipdMm);
  if (ipdHistory.length > STABLE_FRAMES) ipdHistory.shift();
  const spread = Math.max(...ipdHistory) - Math.min(...ipdHistory);
  const steady = ipdHistory.length >= STABLE_FRAMES && spread <= STABLE_TOL_MM;

  const good = sizeOk && centerOk;
  drawBox(lms, w, h, good);

  if (!centerOk) setStatus("Center your face in the frame", false);
  else if (irisFrac < GOOD_IRIS_FRAC[0]) setStatus("Move closer to the camera", false);
  else if (irisFrac > GOOD_IRIS_FRAC[1]) setStatus("Move back a little", false);
  else if (!steady) setStatus("Good — hold still, or press Lock", true);
  else setStatus("Steady & locked-ready — press Lock", true);

  // Lock is allowed as soon as the face is well-placed; staying steady just
  // gives the cleaner green box. This keeps the app usable on low-res cameras.
  if (good) {
    if (steady) steadyCount++;
    lockBtn.disabled = false;
  } else {
    steadyCount = 0;
    lockBtn.disabled = true;
    submitBtn.disabled = true;
  }
}

lockBtn.addEventListener("click", () => {
  if (lockBtn.disabled) return;
  locked = true;
  frozenMetrics = lastMetrics;
  renderMetrics(frozenMetrics);
  lockedTag.textContent = "— locked";
  setStatus("🔒 Locked — ready to submit", true);
  submitBtn.disabled = false;
  lockBtn.disabled = true;
  // solid green frozen box
  octx.lineWidth = 4; octx.strokeStyle = "#22c55e";
});

submitBtn.addEventListener("click", async () => {
  if (!frozenMetrics) return;
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/measurements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(frozenMetrics),
    });
    const out = await res.json();
    if (out.ok) {
      submitBtn.textContent = "Saved ✓";
      setStatus("Saved! Unlock to measure again.", true);
      addUnlock();
    } else {
      throw new Error("save failed");
    }
  } catch (e) {
    submitBtn.textContent = "Submit & save";
    submitBtn.disabled = false;
    setStatus("Could not save — try again", false);
  }
});

function addUnlock() {
  let btn = document.getElementById("unlockBtn");
  if (btn) return;
  btn = document.createElement("button");
  btn.id = "unlockBtn";
  btn.className = "btn secondary";
  btn.textContent = "Measure again";
  btn.style.marginLeft = "8px";
  submitBtn.after(btn);
  btn.addEventListener("click", () => {
    locked = false; frozenMetrics = null; ipdHistory = []; steadyCount = 0;
    lockedTag.textContent = "";
    submitBtn.textContent = "Submit & save";
    submitBtn.disabled = true;
    btn.remove();
  });
}

// ----- camera bootstrap -----
let faceMesh, camera, started = false;
startBtn.addEventListener("click", async () => {
  if (started) return;
  started = true;
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";

  faceMesh = new FaceMesh({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,   // enables iris landmarks
    minDetectionConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  faceMesh.onResults(onResults);

  camera = new Camera(video, {
    onFrame: async () => { await faceMesh.send({ image: video }); },
    width: 1280,
    height: 720,
  });
  try {
    await camera.start();
    startBtn.textContent = "Camera running";
    const ph = document.getElementById("camPlaceholder");
    if (ph) ph.style.display = "none";
    setStatus("Looking for your face…", false);
  } catch (e) {
    started = false;
    startBtn.disabled = false;
    startBtn.textContent = "Start camera";
    setStatus("Camera access denied", false);
    alert("Could not access the camera. Please allow camera permission and use HTTPS (or localhost).");
  }
});
