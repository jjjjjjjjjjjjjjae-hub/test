/* QAMQOR PHONE Duo request interaction.
   The request stays projected on the real inner display.
   Primary input: projected outer-screen CTA.
   Fallback input: model-space ray hit on the baked outer-screen button.
*/
(() => {
  "use strict";

  const viewer = document.querySelector(".qamqor-phone-model");
  const repair = document.getElementById("repair");
  if (!viewer || !repair) {
    console.error("QAMQOR Duo: viewer or request form is missing.");
    return;
  }

  const ANIMATION = "open-close";
  const OUTER_HOTSPOTS = [
    ["hotspot-lock-top-left", "hotspot-lock-top-right",
      "hotspot-lock-bottom-right", "hotspot-lock-bottom-left"],
    ["hotspot-lock-alt-top-left", "hotspot-lock-alt-top-right",
      "hotspot-lock-alt-bottom-right", "hotspot-lock-alt-bottom-left"]
  ];
  const INNER_HOTSPOTS = [
    "hotspot-screen-top-left", "hotspot-screen-top-right",
    "hotspot-screen-bottom-right", "hotspot-screen-bottom-left"
  ];

  // Exact outer-display CTA region measured from QAMQOR-iPhone-Duo.glb.
  // Model-space bounds: x [-0.071746, -0.010627], y [0.018292, 0.031334],
  // z around -0.002602 metres. The wider bounds allow touch tolerance.
  const CTA_HIT = {
    minX: -0.0740, maxX: -0.0084,
    minY: 0.0164, maxY: 0.0332,
    minZ: -0.0039, maxZ: -0.0015
  };

  const state = {
    phase: "loading",
    homeVisible: !document.querySelector('[data-app-page="home"]')?.hidden,
    busy: false,
    opened: false,
    pendingOpen: false,
    initPromise: null,
    placeholder: null,
    lastScreenRect: null,
    retryTimer: 0,
    overlayFrame: 0,
    rotationFrame: 0,
    rotationDrag: null,
    pendingRotationPoint: null,
    lastActivationAt: 0,
    rayHits: 0,
    rayMisses: 0,
    lastRayHit: null,
    lastError: ""
  };

  const nextFrame = () => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );

  // The button is invisible because its artwork is already inside the GLB texture.
  const lockPlane = document.createElement("div");
  lockPlane.id = "qamqor-lock-click-plane";
  lockPlane.hidden = true;
  lockPlane.innerHTML =
    '<button type="button" id="qamqor-lock-click-button" ' +
    'aria-label="Өтінім беру">Өтінім беру</button>';
  document.body.appendChild(lockPlane);
  const lockButton = lockPlane.querySelector("#qamqor-lock-click-button");

  const overlay = document.createElement("div");
  overlay.id = "qamqor-phone-form-overlay";
  overlay.className = "qamqor-phone-form-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<button type="button" class="qamqor-phone-form-close" ' +
    'aria-label="Duo телефонын жабу">×</button>' +
    '<div class="qamqor-phone-form-content"></div>';
  document.body.appendChild(overlay);

  const closeButton = overlay.querySelector(".qamqor-phone-form-close");
  const content = overlay.querySelector(".qamqor-phone-form-content");
  const hadCameraControls = viewer.hasAttribute("camera-controls");
  const normalShadowIntensity =
    Number(viewer.getAttribute("shadow-intensity")) || 0;

  // model-viewer reports the four corners in canvas coordinates. This converts
  // those points to a CSS perspective matrix that follows the real 3D display.
  function projectedRect(names, requireFacingCamera, minWidth, minHeight) {
    if (typeof viewer.queryHotspot !== "function") return null;

    const viewerRect = viewer.getBoundingClientRect();
    const canvasWidth = viewer.clientWidth || viewerRect.width;
    const canvasHeight = viewer.clientHeight || viewerRect.height;
    if (!viewerRect.width || !viewerRect.height || !canvasWidth || !canvasHeight) {
      return null;
    }

    const points = names.map(name => viewer.queryHotspot(name));
    if (points.some(point =>
      !point || !point.canvasPosition ||
      !Number.isFinite(point.canvasPosition.x) ||
      !Number.isFinite(point.canvasPosition.y) ||
      (requireFacingCamera && !point.facingCamera)
    )) return null;

    const sx = viewerRect.width / canvasWidth;
    const sy = viewerRect.height / canvasHeight;
    const p = points.map(point => ({
      x: viewerRect.left + point.canvasPosition.x * sx,
      y: viewerRect.top + point.canvasPosition.y * sy
    }));

    const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    const width =
      (distance(p[0], p[1]) + distance(p[3], p[2])) / 2;
    const height =
      (distance(p[0], p[3]) + distance(p[1], p[2])) / 2;
    if (width < minWidth || height < minHeight) return null;

    const [p0, p1, p2, p3] = p;
    const dx1 = p1.x - p2.x;
    const dx2 = p3.x - p2.x;
    const dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y;
    const dy2 = p3.y - p2.y;
    const dy3 = p0.y - p1.y + p2.y - p3.y;

    const denominator = dx1 * dy2 - dx2 * dy1;
    let g = 0;
    let h = 0;
    if (Math.abs(dx3) + Math.abs(dy3) > 1e-7) {
      if (Math.abs(denominator) < 1e-8) return null;
      g = (dx3 * dy2 - dx2 * dy3) / denominator;
      h = (dx1 * dy3 - dx3 * dy1) / denominator;
    }

    const values = [
      (p1.x - p0.x + g * p1.x) / width,
      (p1.y - p0.y + g * p1.y) / width,
      0,
      g / width,
      (p3.x - p0.x + h * p3.x) / height,
      (p3.y - p0.y + h * p3.y) / height,
      0,
      h / height,
      0, 0, 1, 0,
      p0.x, p0.y, 0, 1
    ];

    if (values.some(value => !Number.isFinite(value))) return null;
    return {
      width,
      height,
      matrix: "matrix3d(" +
        values.map(value => Number(value.toFixed(8))).join(",") + ")"
    };
  }

  function getInnerScreenRect() {
    // Prefer model-viewer's front-facing test. Some mobile WebGL builds report
    // facingCamera=false for these baked inner-screen probes after the hinge
    // animation, even while the inner display is visibly facing the user.
    const frontFacing = projectedRect(INNER_HOTSPOTS, true, 90, 60);
    if (frontFacing) return frontFacing;

    // Fallback: retain the same four measured inner-screen corners and require
    // a realistically sized projection. This avoids blocking the form solely
    // because the mobile facingCamera flag is unreliable after the animation.
    return projectedRect(INNER_HOTSPOTS, false, 90, 60);
  }

  function getOuterScreenRect() {
    // Only use the outer-display hotspot whose normal faces the current camera.
    // The first hotspot set points away from the default front view; accepting it
    // without facingCamera can place the invisible CTA hitbox on the back surface.
    for (const names of OUTER_HOTSPOTS) {
      const rect = projectedRect(names, true, 28, 28);
      if (rect) return rect;
    }
    return null;
  }

  function clearRetry() {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = 0;
    }
  }

  function scheduleLockRetry() {
    if (state.retryTimer || !state.homeVisible ||
        state.opened || state.busy) return;
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = 0;
      placeLockButton();
    }, 220);
  }

  function placeLockButton() {
    const canShow = state.homeVisible && !state.opened && !state.busy &&
      ["loading", "initializing", "closed", "error"].includes(state.phase);

    if (!canShow) {
      lockPlane.hidden = true;
      clearRetry();
      return false;
    }

    const rect = getOuterScreenRect();
    if (!rect) {
      lockPlane.hidden = true;
      scheduleLockRetry();
      return false;
    }

    clearRetry();
    lockPlane.style.left = "0px";
    lockPlane.style.top = "0px";
    lockPlane.style.width = rect.width + "px";
    lockPlane.style.height = rect.height + "px";
    lockPlane.style.transform = rect.matrix;
    lockPlane.hidden = false;
    return true;
  }

  function placeFormOverlay() {
    if (!state.opened) return false;

    const rect = getInnerScreenRect();
    if (!rect) {
      overlay.hidden = true;
      return false;
    }

    state.lastScreenRect = rect;
    overlay.style.left = "0px";
    overlay.style.top = "0px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
    overlay.style.transform = rect.matrix;
    overlay.hidden = false;
    return true;
  }

  function scheduleProjectionUpdate() {
    if (state.overlayFrame) return;
    state.overlayFrame = requestAnimationFrame(() => {
      state.overlayFrame = 0;
      if (state.opened) placeFormOverlay();
      else placeLockButton();
    });
  }

  function getClosedTime() {
    const duration = Number(viewer.duration) || 0;
    if (duration <= 0) return 0;
    return Math.max(0, duration - Math.min(0.05, duration * 0.025));
  }

  async function selectAnimation() {
    if (window.customElements?.whenDefined) {
      await customElements.whenDefined("model-viewer");
    }

    for (let i = 0; i < 45; i++) {
      if (viewer.availableAnimations?.includes(ANIMATION) &&
          Number.isFinite(viewer.duration) && viewer.duration > 0) {
        viewer.animationName = ANIMATION;
        if (viewer.updateComplete?.then) await viewer.updateComplete;
        await nextFrame();
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  async function initializeClosedDuo() {
    if (state.initPromise) return state.initPromise;

    state.initPromise = (async () => {
      if (!viewer.loaded) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("3D телефон 25 секунд ішінде жүктелмеді."));
          }, 25000);
          const onLoad = () => { cleanup(); resolve(); };
          const onError = () => {
            cleanup();
            reject(new Error("3D телефон файлын жүктеу мүмкін болмады."));
          };
          const cleanup = () => {
            clearTimeout(timer);
            viewer.removeEventListener("load", onLoad);
            viewer.removeEventListener("error", onError);
          };
          viewer.addEventListener("load", onLoad, {once: true});
          viewer.addEventListener("error", onError, {once: true});
          if (viewer.loaded) onLoad();
        });
      }

      state.phase = "initializing";
      const animationReady = await selectAnimation();
      if (!animationReady) {
        throw new Error('GLB ішінде "' + ANIMATION + '" анимациясы табылмады.');
      }

      const closedTime = getClosedTime();
      viewer.play({repetitions: 1});
      viewer.pause();
      viewer.timeScale = 1;
      viewer.currentTime = closedTime;
      await nextFrame();
      viewer.pause();

      if (Math.abs(Number(viewer.currentTime) - closedTime) > 0.05) {
        viewer.currentTime = closedTime;
        await nextFrame();
        viewer.pause();
      }
      if (Math.abs(Number(viewer.currentTime) - closedTime) > 0.08) {
        throw new Error("Duo жабық күйін бекіту мүмкін болмады.");
      }

      state.phase = "closed";
      state.lastError = "";
      try { sessionStorage.removeItem("qamqorPhoneFormOpen"); } catch (_) {}
      placeLockButton();

      if (state.pendingOpen) {
        state.pendingOpen = false;
        await openDuoFromPhysicalButton();
      }
      return true;
    })().catch(error => {
      state.phase = "error";
      state.lastError = error?.message || "3D телефон қатесі";
      console.error("QAMQOR Duo initialization:", error);
      placeLockButton();
      return false;
    });

    return state.initPromise;
  }

  async function playDuoAnimation(direction) {
    if (!await selectAnimation()) return false;

    const duration = Number(viewer.duration) || 2;
    const closedTime = getClosedTime();
    const from = direction < 0 ? closedTime : 0.001;
    const destination = direction < 0 ? 0 : closedTime;

    // Do not use a negative model-viewer timeScale here. Reverse playback is
    // unreliable in model-viewer 4.1+ on some browsers. Scrub the real GLB
    // animation timeline with positive-time requestAnimationFrame updates.
    viewer.pause();
    viewer.animationName = ANIMATION;
    if (viewer.updateComplete?.then) await viewer.updateComplete;
    await nextFrame();

    viewer.timeScale = 1;
    viewer.currentTime = from;
    await nextFrame();
    viewer.pause();

    return new Promise(resolve => {
      let startAt = 0;
      let frame = 0;
      let settled = false;
      const travelMs = Math.max(450, duration * 1000);

      const finish = success => {
        if (settled) return;
        settled = true;
        if (frame) cancelAnimationFrame(frame);
        viewer.pause();
        viewer.timeScale = 1;
        viewer.currentTime = destination;
        requestAnimationFrame(() => {
          viewer.pause();
          const actual = Number(viewer.currentTime);
          resolve(success && Number.isFinite(actual) &&
            Math.abs(actual - destination) < 0.12);
        });
      };

      const easeInOut = t => t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;

      const animateFrame = now => {
        if (!startAt) startAt = now;
        const progress = Math.min(1, (now - startAt) / travelMs);
        const eased = easeInOut(progress);
        viewer.currentTime = from + (destination - from) * eased;

        if (progress < 1) {
          frame = requestAnimationFrame(animateFrame);
        } else {
          finish(true);
        }
      };

      frame = requestAnimationFrame(animateFrame);
    });
  }

  async function showRepairForm() {
    if (state.opened || state.phase !== "open") return false;

    if (typeof window.qamqorShowPage === "function") {
      window.qamqorShowPage("top", {
        updateHistory: false,
        scroll: false
      });
    }
    await nextFrame();

    const rect = getInnerScreenRect();
    if (!rect) {
      alert("Duo ішкі экраны камераға көрінбей тұр. Телефонды алдыңғы бетіне бұрыңыз.");
      return false;
    }

    if (!state.placeholder && repair.parentNode) {
      state.placeholder = document.createComment(
        "QAMQOR form returns here after closing Duo"
      );
      repair.parentNode.insertBefore(state.placeholder, repair);
    }

    content.appendChild(repair);
    repair.hidden = false;
    repair.setAttribute("aria-hidden", "false");
    repair.classList.add("qamqor-phone-form-card");
    state.opened = true;
    state.phase = "form";
    viewer.classList.add("qamqor-request-open");

    if (!placeFormOverlay()) {
      state.opened = false;
      state.phase = "open";
      if (state.placeholder?.parentNode) {
        state.placeholder.parentNode.insertBefore(repair, state.placeholder);
        state.placeholder.remove();
      }
      state.placeholder = null;
      repair.hidden = true;
      repair.setAttribute("aria-hidden", "true");
      repair.classList.remove("qamqor-phone-form-card");
      viewer.classList.remove("qamqor-request-open");
      alert("Өтінім формасын 3D экранға орналастыру мүмкін болмады. Экранды тура қаратыңыз.");
      return false;
    }

    repair.scrollTo({top: 0, behavior: "auto"});
    try { sessionStorage.setItem("qamqorPhoneFormOpen", "yes"); } catch (_) {}

    requestAnimationFrame(() => {
      placeFormOverlay();
      if (typeof serviceMap !== "undefined" && serviceMap) {
        serviceMap.invalidateSize(true);
      }
    });
    return true;
  }

  async function openDuoFromPhysicalButton() {
    if (state.opened || state.phase === "form") return true;
    if (state.busy) return false;

    if (!viewer.loaded ||
        state.phase === "loading" ||
        state.phase === "initializing") {
      state.pendingOpen = true;
      viewer.scrollIntoView({behavior: "smooth", block: "center"});
      initializeClosedDuo();
      return true;
    }

    if (state.phase === "error") {
      alert(state.lastError || "3D телефон әлі дайын емес. Бетті жаңартып көріңіз.");
      return false;
    }

    state.busy = true;
    clearRetry();
    lockPlane.hidden = true;
    viewer.removeAttribute("camera-controls");

    try {
      if (state.phase === "closed") {
        state.phase = "opening";
        const animated = await playDuoAnimation(-1);
        if (!animated) {
          state.phase = "closed";
          alert("Duo ашылу анимациясын орындау мүмкін болмады. Қайта басып көріңіз.");
          return false;
        }
        state.phase = "open";
      }

      const formVisible = await showRepairForm();
      if (!formVisible && state.phase !== "form") {
        if (state.phase === "open") state.phase = "open";
        return false;
      }
      return formVisible;
    } finally {
      state.busy = false;
      if (hadCameraControls && !state.opened) {
        viewer.setAttribute("camera-controls", "");
      } else if (hadCameraControls && state.opened) {
        viewer.setAttribute("camera-controls", "");
      }
      if (!state.opened) placeLockButton();
    }
  }

  function activateButton(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    const now = performance.now();
    if (state.lastActivationAt && now - state.lastActivationAt < 550) return;
    state.lastActivationAt = now;
    openDuoFromPhysicalButton();
  }

  // Second route for touch devices: ray-cast the exact printed CTA on the
  // GLB's outer display. This works even if a browser misses the CSS hit plane.
  function isRayOnPhysicalButton(event) {
    if (!viewer.loaded ||
        typeof viewer.positionAndNormalFromPoint !== "function") return false;

    try {
      const hit = viewer.positionAndNormalFromPoint(event.clientX, event.clientY);
      const p = hit?.position;
      if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) {
        state.rayMisses++;
        return false;
      }

      const material = typeof viewer.materialFromPoint === "function"
        ? viewer.materialFromPoint(event.clientX, event.clientY)
        : null;

      const inside =
        p.x >= CTA_HIT.minX && p.x <= CTA_HIT.maxX &&
        p.y >= CTA_HIT.minY && p.y <= CTA_HIT.maxY &&
        p.z >= CTA_HIT.minZ && p.z <= CTA_HIT.maxZ;

      const correctMaterial =
        !material || material.name === "QAMQOR_Duo_Closed_Display";

      state.lastRayHit = {
        position: {x: p.x, y: p.y, z: p.z},
        normal: hit.normal ? {
          x: hit.normal.x, y: hit.normal.y, z: hit.normal.z
        } : null,
        material: material?.name || null,
        inside,
        correctMaterial
      };
      if (!inside || !correctMaterial) {
        state.rayMisses++;
        return false;
      }
      state.rayHits++;
      return true;
    } catch (error) {
      state.lastError = error?.message || "Ray hit error";
      state.rayMisses++;
      return false;
    }
  }

  function tryDirectModelActivation(event) {
    if (!state.homeVisible || state.opened || state.busy) return;
    if (!isRayOnPhysicalButton(event)) return;

    if (state.phase === "loading" || state.phase === "initializing") {
      state.pendingOpen = true;
      initializeClosedDuo();
      return;
    }
    if (state.phase !== "closed") return;
    activateButton(event);
  }

  lockButton.addEventListener("click", activateButton);
  lockButton.addEventListener("pointerup", event => {
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      activateButton(event);
    }
  });

  function eventBelongsToViewer(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.includes(viewer) ||
      (event.target instanceof Node && viewer.contains(event.target));
  }

  // Capture at document level so the fallback also works through model-viewer's
  // shadow canvas on browsers that retarget pointer events.
  document.addEventListener("pointerup", event => {
    if (!eventBelongsToViewer(event)) return;
    if (event.pointerType === "touch" || event.pointerType === "pen") {
      tryDirectModelActivation(event);
    }
  }, true);
  document.addEventListener("click", event => {
    if (!eventBelongsToViewer(event)) return;
    // detail===0 covers keyboard activation; pointer clicks are also checked.
    if (event.detail === 0 || event.pointerType === "mouse") {
      tryDirectModelActivation(event);
    }
  }, true);

  closeButton.addEventListener("click", closePhoneForm);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.opened) closePhoneForm();
  });

  // Dragging the attached form rotates the actual 3D phone; controls and fields
  // remain interactive and are excluded from rotation.
  const rotationInteractiveSelector =
    "button,a,input,select,textarea,label,.leaflet-container,.leaflet-control,[contenteditable='true']";

  const rotationDebug = {
    pointerDown: 0, started: 0, ignored: "",
    pointerMove: 0, animationFrames: 0,
    lastTarget: "", beforeTheta: null, afterTheta: null
  };

  function startRotationDrag(event) {
    rotationDebug.pointerDown++;
    rotationDebug.lastTarget = event.target?.tagName || String(event.target);
    if (!state.opened) { rotationDebug.ignored = "form-not-open"; return; }
    if (state.busy) { rotationDebug.ignored = "busy"; return; }
    if (!overlay.contains(event.target)) {
      rotationDebug.ignored = "target-outside-overlay";
      return;
    }
    if (!event.isPrimary || event.button > 0) {
      rotationDebug.ignored = "not-primary";
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const interactive = target?.closest(rotationInteractiveSelector);
    if (interactive) {
      rotationDebug.ignored = "interactive-target:" + interactive.tagName;
      return;
    }
    if (typeof viewer.getCameraOrbit !== "function") {
      rotationDebug.ignored = "camera-orbit-unavailable";
      return;
    }

    const orbit = viewer.getCameraOrbit();
    state.rotationDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      theta: orbit.theta,
      phi: orbit.phi,
      radius: orbit.radius
    };
    rotationDebug.started++;
    rotationDebug.ignored = "";
    rotationDebug.beforeTheta = orbit.theta;
    viewer.shadowIntensity = 0;
    if (event.cancelable) event.preventDefault();
  }

  function applyRotationFrame() {
    state.rotationFrame = 0;
    const point = state.pendingRotationPoint;
    state.pendingRotationPoint = null;
    if (!state.rotationDrag || !point) return;

    const drag = state.rotationDrag;
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    const theta = drag.theta - dx * 0.008;
    const phi = Math.max(0.18, Math.min(Math.PI - 0.18, drag.phi + dy * 0.004));
    rotationDebug.animationFrames++;

    viewer.cameraOrbit = theta + "rad " + phi + "rad " + drag.radius + "m";
    if (typeof viewer.jumpCameraToGoal === "function") viewer.jumpCameraToGoal();
  }

  function trackRotationPointer(event) {
    const drag = state.rotationDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    rotationDebug.pointerMove++;
    state.pendingRotationPoint = {x: event.clientX, y: event.clientY};
    if (!state.rotationFrame) {
      state.rotationFrame = requestAnimationFrame(applyRotationFrame);
    }
    if (event.cancelable) event.preventDefault();
  }

  function stopRotationDrag(event) {
    const drag = state.rotationDrag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    state.rotationDrag = null;
    state.pendingRotationPoint = null;
    if (state.rotationFrame) cancelAnimationFrame(state.rotationFrame);
    state.rotationFrame = 0;
    viewer.shadowIntensity = normalShadowIntensity;
  }

  document.addEventListener("pointerdown", startRotationDrag, true);
  document.addEventListener("pointermove", trackRotationPointer, {
    capture: true, passive: false
  });
  document.addEventListener("pointerup", stopRotationDrag, true);
  document.addEventListener("pointercancel", stopRotationDrag, true);
  overlay.addEventListener("lostpointercapture", stopRotationDrag);

  async function closePhoneForm() {
    if (!state.opened || state.busy || state.phase !== "form") return;

    state.busy = true;
    state.phase = "closing";
    state.opened = false;
    if (state.overlayFrame) cancelAnimationFrame(state.overlayFrame);
    state.overlayFrame = 0;
    if (state.rotationFrame) cancelAnimationFrame(state.rotationFrame);
    state.rotationFrame = 0;
    state.rotationDrag = null;
    state.pendingRotationPoint = null;
    viewer.shadowIntensity = normalShadowIntensity;
    overlay.hidden = true;
    viewer.removeAttribute("camera-controls");

    if (state.placeholder?.parentNode) {
      state.placeholder.parentNode.insertBefore(repair, state.placeholder);
      state.placeholder.remove();
    }
    state.placeholder = null;
    repair.hidden = true;
    repair.setAttribute("aria-hidden", "true");
    repair.classList.remove("qamqor-phone-form-card");
    viewer.classList.remove("qamqor-request-open");
    try { sessionStorage.removeItem("qamqorPhoneFormOpen"); } catch (_) {}

    const folded = await playDuoAnimation(1);
    state.phase = folded ? "closed" : "error";
    state.busy = false;
    if (hadCameraControls) viewer.setAttribute("camera-controls", "");
    if (folded) placeLockButton();
    else {
      state.lastError = "Duo жабылу анимациясы аяқталмады.";
      alert(state.lastError);
    }
  }

  async function requestOpenDuoForm() {
    if (state.opened || state.phase === "form") return true;
    if (typeof window.qamqorShowPage === "function") {
      window.qamqorShowPage("top", {
        updateHistory: false,
        scroll: false
      });
    }
    state.homeVisible = true;

    if (["loading", "initializing", "closed"].includes(state.phase)) {
      viewer.scrollIntoView({behavior: "smooth", block: "center"});
      placeLockButton();
      return true;
    }
    if (state.phase === "open") return showRepairForm();
    if (state.phase === "error") {
      alert(state.lastError || "3D телефон дайын емес.");
      return false;
    }
    return false;
  }

  window.qamqorPhoneForm = {
    open: requestOpenDuoForm,
    setHomeVisible: visible => {
      state.homeVisible = !!visible;
      if (!state.homeVisible) {
        lockPlane.hidden = true;
        clearRetry();
      } else {
        placeLockButton();
      }
    },
    close: closePhoneForm,
    isOpen: () => state.opened,
    getScreenRect: () => state.lastScreenRect,
    getState: () => state.phase,
    getRotationDebug: () => ({
      ...rotationDebug,
      rotationActive: !!state.rotationDrag
    }),
    isLockButtonVisible: () => !lockPlane.hidden,
    getDiagnostics: () => ({
      phase: state.phase,
      homeVisible: state.homeVisible,
      busy: state.busy,
      viewerLoaded: !!viewer.loaded,
      animations: viewer.availableAnimations || [],
      buttonTargetVisible: !lockPlane.hidden,
      rayHits: state.rayHits,
      rayMisses: state.rayMisses,
      lastRayHit: state.lastRayHit,
      lastError: state.lastError
    })
  };

  viewer.addEventListener("load", () => {
    initializeClosedDuo();
    scheduleProjectionUpdate();
  }, {once: true});
  viewer.addEventListener("error", event => {
    state.phase = "error";
    state.lastError = event?.detail?.sourceEvent?.message ||
      "3D модель жүктелмеді.";
    placeLockButton();
  });

  viewer.addEventListener("camera-change", scheduleProjectionUpdate);
  viewer.addEventListener("camera-orbit-change", scheduleProjectionUpdate);
  window.addEventListener("resize", scheduleProjectionUpdate);
  window.addEventListener("scroll", scheduleProjectionUpdate, {passive: true});
  window.addEventListener("pageshow", scheduleProjectionUpdate);

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(scheduleProjectionUpdate);
    resizeObserver.observe(viewer);
  }

  // Also initialize if the browser completed the GLB load before this script ran.
  if (viewer.loaded) initializeClosedDuo();
  else scheduleLockRetry();

  // The page router runs before this file. Restore the intended 3D entry
  // when the browser returns from Telegram authorization or a deep link.
  if (window.qamqorOpenRequestWhenReady) {
    window.qamqorOpenRequestWhenReady = false;
    requestOpenDuoForm();
  }
})();