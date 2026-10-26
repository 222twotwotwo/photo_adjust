/* ==========================================================================
   证件照裁剪 · 295 × 413
   纯前端实现：File → 裁剪构图 → Canvas 重采样 → 导出
   ========================================================================== */

(function () {
  "use strict";

  /* ---------------- 规格表 ---------------- */

  var PRESETS = {
    one:      { label: "一寸",   w: 295, h: 413, mm: "25 × 35 mm" },
    smallTwo: { label: "小二寸", w: 413, h: 531, mm: "35 × 45 mm" },
    two:      { label: "二寸",   w: 413, h: 579, mm: "35 × 49 mm" },
    bigOne:   { label: "大一寸", w: 390, h: 567, mm: "33 × 48 mm" }
  };

  var MIN_ZOOM = 1;
  var MAX_ZOOM = 8;

  /* ---------------- DOM ---------------- */

  function $(id) { return document.getElementById(id); }

  var dropzone   = $("dropzone");
  var editor     = $("editor");
  var cropper    = $("cropper");
  var preview    = $("preview");
  var fileInput  = $("fileInput");
  var pickBtn    = $("pickBtn");
  var zoomRange  = $("zoomRange");
  var zoomInBtn  = $("zoomIn");
  var zoomOutBtn = $("zoomOut");
  var rotateBtn  = $("rotateBtn");
  var resetBtn   = $("resetBtn");
  var changeBtn  = $("changeBtn");
  var stageMeta  = $("stageMeta");
  var presetsEl  = $("presets");
  var formatsEl  = $("formats");
  var qualityRow = $("qualityRow");
  var qualityRange = $("qualityRange");
  var qualityOut = $("qualityOut");
  var swatchesEl = $("swatches");
  var outSizeEl  = $("outSize");
  var outWeightEl = $("outWeight");
  var srcSizeEl  = $("srcSize");
  var downloadBtn = $("downloadBtn");
  var badgeEl    = $("badge");
  var toastEl    = $("toast");

  /* ---------------- 状态 ---------------- */

  var state = {
    base: null,          // 原始图像（Image 或 canvas）
    baseW: 0,
    baseH: 0,
    source: null,        // 应用旋转后的绘制源
    srcW: 0,
    srcH: 0,
    rotation: 0,         // 0 / 90 / 180 / 270
    scale: 1,            // 相对「铺满裁剪框」的放大倍率
    offsetX: 0,
    offsetY: 0,
    preset: "one",
    format: "image/jpeg",
    quality: 0.92,
    bg: "#ffffff",
    stem: "证件照",
    objectUrl: ""
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function outSpec() { return PRESETS[state.preset]; }

  /* ---------------- 几何计算 ----------------
     裁剪框固定，图片以 cover 方式铺满后，用 offset + scale 构图。
     total = 显示像素 / 源像素
     --------------------------------------------------------- */

  var lastSizeKey = "";

  function measure() {
    var rect = cropper.getBoundingClientRect();
    var cw = rect.width || 1;
    var ch = rect.height || 1;

    var baseScale = Math.max(cw / state.srcW, ch / state.srcH);
    var baseW = state.srcW * baseScale;
    var baseH = state.srcH * baseScale;

    var dispW = baseW * state.scale;
    var dispH = baseH * state.scale;

    var maxX = Math.max(0, (dispW - cw) / 2);
    var maxY = Math.max(0, (dispH - ch) / 2);
    state.offsetX = clamp(state.offsetX, -maxX, maxX);
    state.offsetY = clamp(state.offsetY, -maxY, maxY);

    var left = (cw - dispW) / 2 + state.offsetX;
    var top = (ch - dispH) / 2 + state.offsetY;

    return {
      cw: cw, ch: ch,
      baseScale: baseScale,
      baseW: baseW, baseH: baseH,
      total: baseScale * state.scale,
      left: left, top: top
    };
  }

  function render() {
    if (!state.source) return;

    var m = measure();

    var key = m.baseW.toFixed(2) + "x" + m.baseH.toFixed(2);
    if (key !== lastSizeKey) {
      preview.style.width = m.baseW + "px";
      preview.style.height = m.baseH + "px";
      lastSizeKey = key;
    }
    preview.style.transform =
      "translate3d(" + m.left + "px," + m.top + "px,0) scale(" + state.scale + ")";

    zoomRange.value = String(state.scale);

    var spec = outSpec();
    var warn = state.srcW < spec.w || state.srcH < spec.h ? " · 源图偏小，导出会放大" : "";
    stageMeta.textContent =
      "源图 " + state.srcW + " × " + state.srcH + " · 显示比例 " +
      Math.round(m.total * 100) + "%" + warn;

    scheduleEstimate();
  }

  /* ---------------- 缩放 / 平移 ---------------- */

  function setScale(next) {
    var clamped = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (clamped === state.scale) return;
    // 以裁剪框中心为锚点
    var k = clamped / state.scale;
    state.scale = clamped;
    state.offsetX *= k;
    state.offsetY *= k;
    render();
  }

  var pointers = new Map();
  var dragStart = null;
  var pinchStart = null;

  function pointerDistance() {
    var list = Array.from(pointers.values());
    if (list.length < 2) return 0;
    var dx = list[0].x - list[1].x;
    var dy = list[0].y - list[1].y;
    return Math.hypot(dx, dy);
  }

  cropper.addEventListener("pointerdown", function (e) {
    if (!state.source) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    cropper.focus({ preventScroll: true });
    try { cropper.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, ox: state.offsetX, oy: state.offsetY };
      cropper.classList.add("dragging");
    } else if (pointers.size === 2) {
      dragStart = null;
      pinchStart = { dist: pointerDistance(), scale: state.scale };
    }
  });

  cropper.addEventListener("pointermove", function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2 && pinchStart) {
      var d = pointerDistance();
      if (pinchStart.dist > 4 && d > 4) {
        setScale(pinchStart.scale * (d / pinchStart.dist));
      }
      return;
    }

    if (dragStart) {
      state.offsetX = dragStart.ox + (e.clientX - dragStart.x);
      state.offsetY = dragStart.oy + (e.clientY - dragStart.y);
      render();
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);

    if (pointers.size < 2) pinchStart = null;

    if (pointers.size === 1) {
      var rest = Array.from(pointers.values())[0];
      dragStart = { x: rest.x, y: rest.y, ox: state.offsetX, oy: state.offsetY };
    } else if (pointers.size === 0) {
      dragStart = null;
      cropper.classList.remove("dragging");
    }
  }

  cropper.addEventListener("pointerup", endPointer);
  cropper.addEventListener("pointercancel", endPointer);

  cropper.addEventListener("wheel", function (e) {
    if (!state.source) return;
    e.preventDefault();
    setScale(state.scale * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  cropper.addEventListener("keydown", function (e) {
    if (!state.source) return;
    var step = e.shiftKey ? 20 : 6;
    var handled = true;
    if (e.key === "ArrowLeft") state.offsetX -= step;
    else if (e.key === "ArrowRight") state.offsetX += step;
    else if (e.key === "ArrowUp") state.offsetY -= step;
    else if (e.key === "ArrowDown") state.offsetY += step;
    else if (e.key === "+" || e.key === "=") setScale(state.scale * 1.1);
    else if (e.key === "-" || e.key === "_") setScale(state.scale / 1.1);
    else handled = false;
    if (handled) { e.preventDefault(); render(); }
  });

  zoomRange.addEventListener("input", function () {
    setScale(parseFloat(zoomRange.value));
  });

  zoomInBtn.addEventListener("click", function () { setScale(state.scale * 1.15); });
  zoomOutBtn.addEventListener("click", function () { setScale(state.scale / 1.15); });

  /* ---------------- 旋转 ---------------- */

  function applyRotation() {
    var deg = ((state.rotation % 360) + 360) % 360;

    if (deg === 0) {
      state.source = state.base;
      state.srcW = state.baseW;
      state.srcH = state.baseH;
      return;
    }

    var swap = deg === 90 || deg === 270;
    var c = document.createElement("canvas");
    c.width = swap ? state.baseH : state.baseW;
    c.height = swap ? state.baseW : state.baseH;
    var ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(state.base, -state.baseW / 2, -state.baseH / 2);

    state.source = c;
    state.srcW = c.width;
    state.srcH = c.height;
  }

  rotateBtn.addEventListener("click", function () {
    if (!state.source) return;
    state.rotation = (state.rotation + 90) % 360;
    applyRotation();
    state.offsetX = 0;
    state.offsetY = 0;
    state.scale = Math.max(MIN_ZOOM, state.scale);
    lastSizeKey = "";
    render();
  });

  resetBtn.addEventListener("click", function () {
    if (!state.source) return;
    state.rotation = 0;
    applyRotation();
    state.scale = 1;
    state.offsetX = 0;
    state.offsetY = 0;
    lastSizeKey = "";
    render();
    toast("已复位");
  });

  /* ---------------- 载入文件 ---------------- */

  function loadFile(file) {
    if (!file) return;

    var looksImage = (file.type && file.type.indexOf("image/") === 0) ||
      /\.(jpe?g|png|webp|avif|bmp|gif|tiff?|heic|heif|svg)$/i.test(file.name || "");
    if (!looksImage) {
      toast("这不是图片文件，换一张试试");
      return;
    }

    var url = URL.createObjectURL(file);
    var img = new Image();
    img.decoding = "async";

    img.onload = function () {
      if (!img.naturalWidth || !img.naturalHeight) {
        URL.revokeObjectURL(url);
        toast("图片尺寸异常，无法读取");
        return;
      }

      var previousUrl = state.objectUrl;

      state.base = img;
      state.baseW = img.naturalWidth;
      state.baseH = img.naturalHeight;
      state.rotation = 0;
      state.scale = 1;
      state.offsetX = 0;
      state.offsetY = 0;
      state.stem = (file.name || "").replace(/\.[^.]+$/, "").trim().slice(0, 40) || "证件照";
      state.objectUrl = url;
      applyRotation();

      preview.src = url;
      lastSizeKey = "";

      if (previousUrl) URL.revokeObjectURL(previousUrl);

      dropzone.hidden = true;
      editor.hidden = false;
      downloadBtn.disabled = false;
      srcSizeEl.textContent = state.srcW + " × " + state.srcH;

      requestAnimationFrame(function () {
        requestAnimationFrame(render);
      });
    };

    img.onerror = function () {
      URL.revokeObjectURL(url);
      if (/\.(heic|heif)$/i.test(file.name || "")) {
        toast("当前浏览器不支持 HEIC，请先转成 JPG 再试");
      } else {
        toast("浏览器无法解码这张照片，试试 JPG / PNG / WebP");
      }
    };

    img.src = url;
  }

  function openPicker() { fileInput.click(); }

  dropzone.addEventListener("click", openPicker);
  pickBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    openPicker();
  });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });
  changeBtn.addEventListener("click", openPicker);

  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    loadFile(file);
  });

  /* ---------------- 拖放 / 粘贴 ---------------- */

  var dragDepth = 0;

  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types && Array.prototype.indexOf.call(dt.types, "Files") !== -1) return true;
    return !!(dt.files && dt.files.length);
  }

  window.addEventListener("dragenter", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add("dropping");
  });

  window.addEventListener("dragover", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("dropping");
  });

  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dropping");
    var file = e.dataTransfer.files && e.dataTransfer.files[0];
    loadFile(file);
  });

  window.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf("image/") === 0) {
        var file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          loadFile(file);
          return;
        }
      }
    }
  });

  /* ---------------- 规格切换 ---------------- */

  function renderPresets() {
    presetsEl.innerHTML = "";
    Object.keys(PRESETS).forEach(function (key) {
      var p = PRESETS[key];
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset" + (key === state.preset ? " active" : "");
      btn.dataset.preset = key;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", key === state.preset ? "true" : "false");
      btn.innerHTML =
        '<span class="preset-name">' + p.label + "</span>" +
        '<span class="preset-size">' + p.w + " × " + p.h + "</span>";
      presetsEl.appendChild(btn);
    });
  }

  function setPreset(key) {
    if (!PRESETS[key] || key === state.preset) return;
    state.preset = key;
    var p = PRESETS[key];
    cropper.style.setProperty("--ar", String(p.w / p.h));
    state.scale = 1;
    state.offsetX = 0;
    state.offsetY = 0;
    lastSizeKey = "";
    renderPresets();
    syncOutputMeta();
    if (state.source) requestAnimationFrame(render);
  }

  presetsEl.addEventListener("click", function (e) {
    var btn = e.target.closest(".preset");
    if (btn) setPreset(btn.dataset.preset);
  });

  function syncOutputMeta() {
    var p = outSpec();
    outSizeEl.textContent = p.w + " × " + p.h + " px";
    badgeEl.textContent = p.w + " × " + p.h + " px";
  }

  /* ---------------- 格式 / 画质 / 底色 ---------------- */

  function setFormat(fmt) {
    state.format = fmt;
    Array.prototype.forEach.call(formatsEl.children, function (btn) {
      var on = btn.dataset.format === fmt;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
    var lossy = fmt !== "image/png";
    qualityRow.classList.toggle("is-disabled", !lossy);
    qualityRange.disabled = !lossy;

    var transparent = swatchesEl.querySelector('[data-bg="none"]');
    var allowAlpha = fmt === "image/png";
    transparent.classList.toggle("is-locked", !allowAlpha);
    transparent.disabled = !allowAlpha;
    if (!allowAlpha && state.bg === "none") setBg("#ffffff");

    scheduleEstimate();
  }

  function setBg(bg) {
    state.bg = bg;
    Array.prototype.forEach.call(swatchesEl.children, function (btn) {
      btn.setAttribute("aria-checked", btn.dataset.bg === bg ? "true" : "false");
    });
    scheduleEstimate();
  }

  formatsEl.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-format]");
    if (btn) setFormat(btn.dataset.format);
  });

  qualityRange.addEventListener("input", function () {
    state.quality = parseFloat(qualityRange.value);
    qualityOut.textContent = Math.round(state.quality * 100) + "%";
    scheduleEstimate();
  });

  swatchesEl.addEventListener("click", function (e) {
    var btn = e.target.closest(".swatch");
    if (btn && !btn.disabled) setBg(btn.dataset.bg);
  });

  /* ---------------- 渲染输出 ---------------- */

  /**
   * 逐级减半重采样，避免大比例缩小产生的锯齿 / 摩尔纹。
   */
  function drawHighQuality(ctx, img, sx, sy, sw, sh, dw, dh) {
    var LIMIT = 2048;
    var k = Math.min(1, LIMIT / Math.max(sw, sh));

    var cur = document.createElement("canvas");
    cur.width = Math.max(1, Math.round(sw * k));
    cur.height = Math.max(1, Math.round(sh * k));
    var c0 = cur.getContext("2d");
    c0.imageSmoothingEnabled = true;
    c0.imageSmoothingQuality = "high";
    c0.drawImage(img, sx, sy, sw, sh, 0, 0, cur.width, cur.height);

    while (cur.width >= dw * 2 && cur.height >= dh * 2) {
      var next = document.createElement("canvas");
      next.width = Math.max(dw, Math.floor(cur.width / 2));
      next.height = Math.max(dh, Math.floor(cur.height / 2));
      var nc = next.getContext("2d");
      nc.imageSmoothingEnabled = true;
      nc.imageSmoothingQuality = "high";
      nc.drawImage(cur, 0, 0, next.width, next.height);
      cur = next;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, dw, dh);
  }

  function composeCanvas() {
    var spec = outSpec();
    var canvas = document.createElement("canvas");
    canvas.width = spec.w;
    canvas.height = spec.h;
    var ctx = canvas.getContext("2d");

    if (state.bg !== "none") {
      ctx.fillStyle = state.bg;
      ctx.fillRect(0, 0, spec.w, spec.h);
    }

    if (!state.source) return canvas;

    var m = measure();
    var sx = clamp(-m.left / m.total, 0, state.srcW);
    var sy = clamp(-m.top / m.total, 0, state.srcH);
    var sw = clamp(m.cw / m.total, 0.0001, state.srcW - sx);
    var sh = clamp(m.ch / m.total, 0.0001, state.srcH - sy);

    drawHighQuality(ctx, state.source, sx, sy, sw, sh, spec.w, spec.h);
    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) { resolve(blob); }, state.format, state.quality);
    });
  }

  var estimateTimer = 0;
  var estimateToken = 0;

  function scheduleEstimate() {
    if (!state.source) return;
    clearTimeout(estimateTimer);
    var token = ++estimateToken;
    estimateTimer = setTimeout(function () {
      canvasToBlob(composeCanvas()).then(function (blob) {
        if (token !== estimateToken) return;
        outWeightEl.textContent = blob ? formatBytes(blob.size) : "—";
      });
    }, 150);
  }

  function formatBytes(n) {
    if (typeof n !== "number") return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function extensionFor(mime) {
    if (mime === "image/png") return "png";
    if (mime === "image/webp") return "webp";
    return "jpg";
  }

  downloadBtn.addEventListener("click", function () {
    if (!state.source) return;

    var spec = outSpec();
    canvasToBlob(composeCanvas()).then(function (blob) {
      if (!blob) {
        toast("导出失败，试试换个格式");
        return;
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = state.stem + "-" + spec.w + "x" + spec.h + "." + extensionFor(state.format);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      toast("已导出 " + spec.w + " × " + spec.h + " · " + formatBytes(blob.size));
    });
  });

  /* ---------------- Toast ---------------- */

  var toastTimer = 0;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
    }, 2600);
  }

  /* ---------------- 自适应 ---------------- */

  if (typeof ResizeObserver !== "undefined") {
    var ro = new ResizeObserver(function () {
      if (state.source) render();
    });
    ro.observe(cropper);
  } else {
    window.addEventListener("resize", function () {
      if (state.source) render();
    });
  }

  /* ---------------- 启动 ---------------- */

  cropper.style.setProperty("--ar", String(PRESETS[state.preset].w / PRESETS[state.preset].h));
  renderPresets();
  syncOutputMeta();
  setFormat("image/jpeg");
  setBg("#ffffff");
  qualityOut.textContent = Math.round(state.quality * 100) + "%";
})();
