/**
 * LUX Video OS - Studio Live Preview Player
 * Interactive in-browser player rendering live canvas composition:
 * - Avatar / Presenter layer with natural idle micro-motion
 * - Remotion-matching animated lower-third badge (between t=1s and t=7s, sky-blue accent #38bdf8, brand strip #12219c)
 * - Real-time live script subtitles & captions synchronized to playback time
 * - 16:9 Landscape vs 9:16 Portrait aspect ratio switching
 * - Play/pause, time scrubbing, and full-screen preview modal
 */

import {
  getCompositionDimensions,
  getLowerThirdGeometry,
  getLowerThirdAnimation,
  computeCaptionSegments,
  estimateScriptDuration,
} from './remotion/preview-composition.js';

const $ = (selector, root = document) => root?.querySelector(selector);
const $$ = (selector, root = document) => [...(root?.querySelectorAll(selector) || [])];

export function createStudioPreviewController(options = {}) {
  const {
    getScript = () => '',
    getTitle = () => '',
    getPresenter = () => null,
    onFormatChange = () => {},
  } = options;

  // DOM Elements
  const els = {
    card: $('#studio-preview-card'),
    canvas: $('#studio-preview-canvas'),
    stageContainer: $('#studio-preview-stage-container'),
    stage: $('#studio-preview-stage'),
    lowerThird: $('#preview-lower-third'),
    badgeName: $('#preview-badge-name'),
    badgeTitle: $('#preview-badge-title'),
    subtitles: $('#preview-subtitles'),
    subtitleText: $('#preview-subtitle-text'),
    playBtn: $('#preview-play-btn'),
    iconPlay: $('#preview-icon-play'),
    iconPause: $('#preview-icon-pause'),
    timeDisplay: $('#preview-time-display'),
    timeSlider: $('#preview-time-slider'),
    restartBtn: $('#preview-restart-btn'),
    aspect169: $('#preview-aspect-16-9'),
    aspect916: $('#preview-aspect-9-16'),
    fullscreenBtn: $('#preview-fullscreen-btn'),

    // Fullscreen Modal Elements
    modal: $('#studio-preview-modal'),
    modalCanvas: $('#modal-preview-canvas'),
    modalStageContainer: $('#modal-preview-stage-container'),
    modalStage: $('#modal-preview-stage'),
    modalLowerThird: $('#modal-lower-third'),
    modalBadgeName: $('#modal-badge-name'),
    modalBadgeTitle: $('#modal-badge-title'),
    modalSubtitles: $('#modal-subtitles'),
    modalSubtitleText: $('#modal-subtitle-text'),
    modalPlayBtn: $('#modal-play-btn'),
    modalIconPlay: $('#modal-icon-play'),
    modalIconPause: $('#modal-icon-pause'),
    modalTimeDisplay: $('#modal-time-display'),
    modalTimeSlider: $('#modal-time-slider'),
    modalAspect169: $('#modal-aspect-16-9'),
    modalAspect916: $('#modal-aspect-9-16'),
    modalCloseBtn: $('#preview-modal-close'),
    modalCloseBottom: $('#modal-close-bottom'),
  };

  // State
  const state = {
    aspect: 'landscape', // 'landscape' (16:9) | 'portrait' (9:16)
    isPlaying: false,
    currentTime: 0,
    duration: 10,
    script: '',
    title: '',
    presenter: null,
    captionSegments: [],
    avatarImage: null,
    avatarImageLoaded: false,
    avatarImageUrl: '',
    lastTimestamp: 0,
    rafId: null,
  };

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem.toString().padStart(2, '0')}`;
  }

  function setAspect(aspect, syncForm = true) {
    state.aspect = aspect === 'portrait' ? 'portrait' : 'landscape';
    const isPortrait = state.aspect === 'portrait';

    // Update container classes / data attributes
    if (els.stageContainer) els.stageContainer.dataset.aspect = state.aspect;
    if (els.modalStageContainer) els.modalStageContainer.dataset.aspect = state.aspect;

    // Toggle button active states
    [els.aspect169, els.modalAspect169].forEach((btn) => {
      btn?.classList.toggle('active', !isPortrait);
      btn?.setAttribute('aria-pressed', String(!isPortrait));
    });
    [els.aspect916, els.modalAspect916].forEach((btn) => {
      btn?.classList.toggle('active', isPortrait);
      btn?.setAttribute('aria-pressed', String(isPortrait));
    });

    // Update canvas internal pixel buffer size
    const [w, h] = getCompositionDimensions(state.aspect);
    if (els.canvas) {
      els.canvas.width = w;
      els.canvas.height = h;
    }
    if (els.modalCanvas) {
      els.modalCanvas.width = w;
      els.modalCanvas.height = h;
    }

    if (syncForm) {
      onFormatChange(isPortrait ? 'vertical' : 'landscape');
    }

    renderCurrentFrame();
  }

  function updateScriptAndCaptions(newScript) {
    state.script = String(newScript || '').trim();
    state.duration = estimateScriptDuration(state.script);
    state.captionSegments = computeCaptionSegments(state.script, state.duration);

    if (els.timeSlider) {
      els.timeSlider.max = state.duration.toString();
    }
    if (els.modalTimeSlider) {
      els.modalTimeSlider.max = state.duration.toString();
    }

    if (state.currentTime > state.duration) {
      state.currentTime = 0;
    }

    syncTimeDisplay();
    renderCurrentFrame();
  }

  function updatePresenter(presenter) {
    state.presenter = presenter;
    const url = presenter?.previewUrl || presenter?.portraitUrl || '';
    if (url && url !== state.avatarImageUrl) {
      state.avatarImageUrl = url;
      state.avatarImageLoaded = false;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        state.avatarImage = img;
        state.avatarImageLoaded = true;
        renderCurrentFrame();
      };
      img.onerror = () => {
        state.avatarImage = null;
        state.avatarImageLoaded = false;
        renderCurrentFrame();
      };
      img.src = url;
    } else if (!url) {
      state.avatarImage = null;
      state.avatarImageLoaded = false;
      state.avatarImageUrl = '';
    }
    renderCurrentFrame();
  }

  function updateTitle(title) {
    state.title = String(title || '').trim();
    renderCurrentFrame();
  }

  function syncTimeDisplay() {
    const text = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
    if (els.timeDisplay) els.timeDisplay.textContent = text;
    if (els.modalTimeDisplay) els.modalTimeDisplay.textContent = text;
    if (els.timeSlider) els.timeSlider.value = state.currentTime.toFixed(2);
    if (els.modalTimeSlider) els.modalTimeSlider.value = state.currentTime.toFixed(2);
  }

  function getActiveCaption(t) {
    if (state.captionSegments.length === 0) {
      if (state.script) {
        return state.script.slice(0, 70);
      }
      return 'Type your script to see real-time captions';
    }
    const found = state.captionSegments.find((seg) => t >= seg.startTime && t <= seg.endTime);
    if (found) return found.text;
    // If between segments or near beginning/end
    if (t < state.captionSegments[0].startTime) {
      return state.captionSegments[0].text;
    }
    return state.captionSegments[state.captionSegments.length - 1].text;
  }

  function drawFrameOnCanvas(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const isPortrait = height > width;
    const t = state.currentTime;

    ctx.clearRect(0, 0, width, height);

    // 1. Studio background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#0a101f');
    bgGrad.addColorStop(0.5, '#070b14');
    bgGrad.addColorStop(1, '#05070c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // Subtle studio spotlight glow
    const spotX = width * 0.5;
    const spotY = height * 0.45;
    const spotRad = Math.max(width, height) * 0.55;
    const spotGrad = ctx.createRadialGradient(spotX, spotY, 20, spotX, spotY, spotRad);
    spotGrad.addColorStop(0, 'rgba(36, 88, 211, 0.22)');
    spotGrad.addColorStop(0.6, 'rgba(18, 33, 156, 0.08)');
    spotGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = spotGrad;
    ctx.fillRect(0, 0, width, height);

    // 2. Avatar / Presenter rendering with subtle idle breathing
    const idleScale = 1.0 + 0.006 * Math.sin(t * 1.8);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(idleScale, idleScale);
    ctx.translate(-width / 2, -height / 2);

    if (state.avatarImage && state.avatarImageLoaded) {
      // Draw cover-fitted image
      const img = state.avatarImage;
      const imgAspect = img.width / img.height;
      const canvasAspect = width / height;
      let drawW, drawH, drawX, drawY;
      if (imgAspect > canvasAspect) {
        drawH = height;
        drawW = height * imgAspect;
        drawX = (width - drawW) / 2;
        drawY = 0;
      } else {
        drawW = width;
        drawH = width / imgAspect;
        drawX = 0;
        drawY = (height - drawH) / 2;
      }
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
    } else {
      // Silhouette Presenter Placeholder with LUX styling
      const cx = width / 2;
      const cy = height * (isPortrait ? 0.45 : 0.48);
      const headR = isPortrait ? 130 : 110;

      // Head
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(cx, cy - headR * 0.7, headR, 0, Math.PI * 2);
      ctx.fill();

      // Shoulders / Torso
      ctx.beginPath();
      ctx.moveTo(cx - headR * 2.2, cy + headR * 2.8);
      ctx.quadraticCurveTo(cx - headR * 1.8, cy + headR * 0.8, cx, cy + headR * 0.7);
      ctx.quadraticCurveTo(cx + headR * 1.8, cy + headR * 0.8, cx + headR * 2.2, cy + headR * 2.8);
      ctx.closePath();
      ctx.fillStyle = '#162032';
      ctx.fill();

      // Brand badge on silhouette
      ctx.fillStyle = '#38bdf8';
      ctx.font = `800 ${isPortrait ? '48px' : '36px'} "Geist LUX", Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('LUX', cx, cy - headR * 0.7);

      ctx.fillStyle = '#94a3b8';
      ctx.font = `600 ${isPortrait ? '24px' : '18px'} "Geist LUX", Inter, sans-serif`;
      const presenterLabel = state.presenter?.name || 'Choose Presenter';
      ctx.fillText(presenterLabel, cx, cy + headR * 1.6);
    }
    ctx.restore();

    // 3. Remotion Brand Strip (drawbox=x=0:y=0:w=12:h=ih:color=0x12219c@0.85:t=fill)
    ctx.fillStyle = 'rgba(18, 33, 156, 0.85)';
    ctx.fillRect(0, 0, 12, height);

    // 4. Remotion Animated Lower-Third Badge
    const geom = getLowerThirdGeometry(width, height);
    const anim = getLowerThirdAnimation(t, 1.0, 7.0, 0.45);

    if (anim.visible && anim.opacity > 0) {
      ctx.save();
      ctx.globalAlpha = anim.opacity;

      const bx = geom.boxX + anim.slideOffset;
      const by = geom.boxY;
      const bw = geom.boxWidth;
      const bh = geom.boxHeight;

      // Card backdrop with subtle rounding
      ctx.fillStyle = 'rgba(7, 16, 24, 0.86)';
      const radius = 6;
      ctx.beginPath();
      ctx.moveTo(bx + radius, by);
      ctx.lineTo(bx + bw - radius, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + radius);
      ctx.lineTo(bx + bw, by + bh - radius);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - radius, by + bh);
      ctx.lineTo(bx + radius, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - radius);
      ctx.lineTo(bx, by + radius);
      ctx.quadraticCurveTo(bx, by, bx + radius, by);
      ctx.closePath();
      ctx.fill();

      // Sky-blue vertical accent strip (drawbox=x=boxX:y=boxY:w=6:h=boxHeight:color=0x38bdf8@0.95)
      ctx.fillStyle = 'rgba(56, 189, 248, 0.95)';
      ctx.fillRect(bx, by, geom.accentWidth, bh);

      // Text in lower-third
      const textX = bx + geom.accentWidth + (isPortrait ? 22 : 18);
      const name = state.presenter?.name || state.title || 'Executive Presenter';
      const role = state.title || 'LUX Video OS';

      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${isPortrait ? '34px' : '26px'} "Geist LUX", Inter, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(name, textX, by + bh * 0.48, bw - 40);

      ctx.fillStyle = '#94a3b8';
      ctx.font = `500 ${isPortrait ? '22px' : '16px'} "Geist LUX", Inter, sans-serif`;
      ctx.fillText(role, textX, by + bh * 0.82, bw - 40);

      ctx.restore();
    }

    // 5. Real-Time Live Script Subtitles / Captions
    const activeCaption = getActiveCaption(t);
    if (activeCaption) {
      ctx.save();
      const capFontSize = isPortrait ? 36 : 28;
      ctx.font = `600 ${capFontSize}px "Geist LUX", Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const metrics = ctx.measureText(activeCaption);
      const textW = metrics.width;
      const padX = isPortrait ? 30 : 24;
      const padY = isPortrait ? 18 : 12;
      const pillW = Math.min(width * 0.88, textW + padX * 2);
      const pillH = capFontSize + padY * 2;
      const pillX = (width - pillW) / 2;
      // In landscape, place above lower third; in portrait, place in lower safe area
      const pillY = isPortrait ? height - 340 : height - 210;

      // Dark translucent pill
      ctx.fillStyle = 'rgba(7, 16, 24, 0.80)';
      ctx.beginPath();
      const pr = 8;
      ctx.moveTo(pillX + pr, pillY);
      ctx.lineTo(pillX + pillW - pr, pillY);
      ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + pr);
      ctx.lineTo(pillX + pillW, pillY + pillH - pr);
      ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - pr, pillY + pillH);
      ctx.lineTo(pillX + pr, pillY + pillH);
      ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - pr);
      ctx.lineTo(pillX, pillY + pr);
      ctx.quadraticCurveTo(pillX, pillY, pillX + pr, pillY);
      ctx.closePath();
      ctx.fill();

      // Pill border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Subtitle text
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 4;
      ctx.fillText(activeCaption, width / 2, pillY + pillH / 2, pillW - 24);

      ctx.restore();
    }
  }

  function syncDomOverlays() {
    const t = state.currentTime;
    const name = state.presenter?.name || state.title || 'Executive Presenter';
    const role = state.title || 'LUX Video OS';
    const activeCaption = getActiveCaption(t);

    const anim = getLowerThirdAnimation(t, 1.0, 7.0, 0.45);

    // Lower third overlay
    [els.lowerThird, els.modalLowerThird].forEach((overlay) => {
      if (!overlay) return;
      overlay.style.opacity = anim.visible ? String(anim.opacity) : '0';
      overlay.style.transform = `translateX(${anim.slideOffset}px)`;
      overlay.style.pointerEvents = anim.visible ? 'auto' : 'none';
    });

    [els.badgeName, els.modalBadgeName].forEach((el) => {
      if (el) el.textContent = name;
    });
    [els.badgeTitle, els.modalBadgeTitle].forEach((el) => {
      if (el) el.textContent = role;
    });

    // Subtitle text
    [els.subtitleText, els.modalSubtitleText].forEach((el) => {
      if (el) el.textContent = activeCaption;
    });
  }

  function renderCurrentFrame() {
    drawFrameOnCanvas(els.canvas);
    if (els.modal && els.modal.open) {
      drawFrameOnCanvas(els.modalCanvas);
    }
    syncDomOverlays();
  }

  function tick(timestamp) {
    if (!state.isPlaying) return;

    if (!state.lastTimestamp) state.lastTimestamp = timestamp;
    const delta = (timestamp - state.lastTimestamp) / 1000;
    state.lastTimestamp = timestamp;

    state.currentTime += delta;
    if (state.currentTime >= state.duration) {
      // Loop playback
      state.currentTime = 0;
    }

    syncTimeDisplay();
    renderCurrentFrame();

    state.rafId = requestAnimationFrame(tick);
  }

  function play() {
    if (state.isPlaying) return;
    state.isPlaying = true;
    state.lastTimestamp = performance.now();

    updatePlayPauseIcons(true);
    state.rafId = requestAnimationFrame(tick);
  }

  function pause() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    updatePlayPauseIcons(false);
  }

  function togglePlay() {
    if (state.isPlaying) pause();
    else play();
  }

  function updatePlayPauseIcons(playing) {
    [els.iconPlay, els.modalIconPlay].forEach((el) => {
      if (el) el.hidden = playing;
    });
    [els.iconPause, els.modalIconPause].forEach((el) => {
      if (el) el.hidden = !playing;
    });
    [els.playBtn, els.modalPlayBtn].forEach((btn) => {
      if (btn) btn.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
    });
  }

  function seek(targetSeconds) {
    state.currentTime = Math.max(0, Math.min(state.duration, Number(targetSeconds) || 0));
    syncTimeDisplay();
    renderCurrentFrame();
  }

  function openFullscreenModal() {
    if (!els.modal) return;
    // Sync modal canvas dimensions to match active aspect
    const [w, h] = getCompositionDimensions(state.aspect);
    if (els.modalCanvas) {
      els.modalCanvas.width = w;
      els.modalCanvas.height = h;
    }
    if (els.modalStageContainer) {
      els.modalStageContainer.dataset.aspect = state.aspect;
    }

    try {
      els.modal.showModal();
    } catch {
      els.modal.setAttribute('open', '');
    }

    renderCurrentFrame();
  }

  function closeFullscreenModal() {
    if (!els.modal) return;
    try {
      els.modal.close();
    } catch {
      els.modal.removeAttribute('open');
    }
    renderCurrentFrame();
  }

  // Bind Event Listeners
  function attachListeners() {
    // Play/Pause buttons
    els.playBtn?.addEventListener('click', togglePlay);
    els.modalPlayBtn?.addEventListener('click', togglePlay);

    // Restart button
    els.restartBtn?.addEventListener('click', () => {
      seek(0);
      play();
    });

    // Time Scrubber
    const onScrub = (e) => {
      const val = parseFloat(e.target.value);
      seek(val);
    };
    els.timeSlider?.addEventListener('input', onScrub);
    els.modalTimeSlider?.addEventListener('input', onScrub);

    // Aspect Ratio Toggles
    els.aspect169?.addEventListener('click', () => setAspect('landscape'));
    els.aspect916?.addEventListener('click', () => setAspect('portrait'));
    els.modalAspect169?.addEventListener('click', () => setAspect('landscape'));
    els.modalAspect916?.addEventListener('click', () => setAspect('portrait'));

    // Fullscreen buttons
    els.fullscreenBtn?.addEventListener('click', openFullscreenModal);
    els.modalCloseBtn?.addEventListener('click', closeFullscreenModal);
    els.modalCloseBottom?.addEventListener('click', closeFullscreenModal);

    // Keyboard shortcuts in modal
    els.modal?.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(state.currentTime - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(state.currentTime + 1);
      }
    });

    // Reactive input listeners for script and title
    const scriptInput = $('#script-input');
    if (scriptInput) {
      scriptInput.addEventListener('input', (e) => {
        updateScriptAndCaptions(e.target.value);
      });
    }

    const premiumTitle = $('#premium-title');
    if (premiumTitle) {
      premiumTitle.addEventListener('input', (e) => {
        updateTitle(e.target.value);
      });
    }

    const formatSelect = $('#export-format');
    if (formatSelect) {
      formatSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        const targetAspect = val === 'vertical' ? 'portrait' : 'landscape';
        if (state.aspect !== targetAspect) {
          setAspect(targetAspect, false);
        }
      });
    }
  }

  // Initialize
  function init() {
    attachListeners();

    // Pull initial values
    const initialScript = getScript() || $('#script-input')?.value || '';
    const initialTitle = getTitle() || $('#premium-title')?.value || '';
    const initialPresenter = getPresenter();
    const initialFormat = $('#export-format')?.value;
    const initialAspect = initialFormat === 'vertical' ? 'portrait' : 'landscape';

    updateTitle(initialTitle);
    updatePresenter(initialPresenter);
    updateScriptAndCaptions(initialScript);
    setAspect(initialAspect, false);

    renderCurrentFrame();
  }

  init();

  return {
    play,
    pause,
    togglePlay,
    seek,
    setAspect,
    updateScriptAndCaptions,
    updatePresenter,
    updateTitle,
    openFullscreenModal,
    closeFullscreenModal,
    renderCurrentFrame,
    getState: () => ({ ...state }),
  };
}
