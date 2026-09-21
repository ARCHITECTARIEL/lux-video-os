// Landing/marketing page only. Two independent, best-effort enhancements:
// a procedural "silk" shader background (progressive enhancement -- the
// hero's CSS background already looks correct with no canvas at all) and
// the CEO-video play button. Neither has any dependency on the app shell.

function initSilkBackground() {
  const canvas = document.getElementById('lp-silk-canvas');
  if (!canvas) return;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false }) || canvas.getContext('experimental-webgl');
  if (!gl) return; // dark CSS background is the fallback -- no error state needed

  const vertexSource = `
    attribute vec2 aPosition;
    void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
  `;

  // Domain-warped fBm for the flow, a ridged transform for creases, and a
  // finite-difference normal for a simple directional sheen -- the classic
  // "procedural cloth" recipe (Inigo Quilez's domain-warping technique),
  // implemented from scratch here rather than borrowed.
  const fragmentSource = `
    precision highp float;
    uniform vec2 uResolution;
    uniform float uTime;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }

    float fbm(vec2 p) {
      float value = 0.0;
      float amplitude = 0.5;
      for (int i = 0; i < 5; i++) {
        value += amplitude * noise(p);
        p *= 2.02;
        amplitude *= 0.5;
      }
      return value;
    }

    float warpedFbm(vec2 p) {
      vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
      vec2 r = vec2(
        fbm(p + 3.5 * q + vec2(1.7, 9.2) + 0.12 * uTime),
        fbm(p + 3.5 * q + vec2(8.3, 2.8) + 0.09 * uTime)
      );
      return fbm(p + 3.5 * r);
    }

    // Volumetric density, not a surface height -- no normal map, no specular
    // glint. That lighting model is what read as "liquid/wavy" before; a
    // mist is diffuse, so it's built from two soft, differently-scaled fbm
    // layers blended together (a large slow bank plus finer drifting
    // detail) instead of one ridge-sharpened surface.
    float mistDensity(vec2 p) {
      float bank = fbm(p * 0.6);
      float detail = warpedFbm(p * 1.4);
      return mix(bank, detail, 0.55);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uResolution.xy;
      vec2 p = uv;
      p.x *= uResolution.x / uResolution.y;
      // Slow upward drift (mist rising) instead of the old anisotropic
      // stretch that produced directional silk-like folds.
      vec2 drifting = p + vec2(0.0, -uTime * 0.015);

      float density = mistDensity(drifting);
      float glow = smoothstep(0.22, 0.88, density);

      // LUX brand palette: deep cobalt through the brand's own royal blue,
      // with a brushed-silver sheen (not icy blue-white) to match the
      // wordmark's chrome bevel highlight.
      vec3 deep = vec3(0.035, 0.067, 0.243);
      vec3 mid = vec3(0.071, 0.129, 0.580);
      vec3 sheen = vec3(0.769, 0.804, 0.863);

      vec3 color = mix(deep, mid, glow);
      color = mix(color, sheen, glow * glow * 0.22);

      // A soft ring of light expanding from a fixed point, repeating on a
      // 7-second cycle (within the requested 5-10s cadence) and fading out
      // both spatially (a thin ring, not a hard edge) and over its own
      // lifetime, so it reads as an occasional pulse through the mist
      // rather than a constant, distracting loop.
      float rippleCycle = 7.0;
      float ripplePhase = mod(uTime, rippleCycle) / rippleCycle;
      vec2 center = vec2(0.5 * uResolution.x / uResolution.y, 0.42);
      float distFromCenter = distance(p, center);
      float ringRadius = ripplePhase * 1.1;
      float ring = smoothstep(0.18, 0.0, abs(distFromCenter - ringRadius)) * (1.0 - ripplePhase);
      color += sheen * ring * 0.45;

      gl_FragColor = vec4(color, 1.0);
    }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) return;

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLocation = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const resolutionLocation = gl.getUniformLocation(program, 'uResolution');
  const timeLocation = gl.getUniformLocation(program, 'uTime');

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function renderFrame(timeSeconds) {
    resize();
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(timeLocation, timeSeconds);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  if (reduceMotion) {
    renderFrame(0);
    window.addEventListener('resize', () => renderFrame(0));
    return;
  }

  let start = null;
  function tick(now) {
    if (start === null) start = now;
    renderFrame((now - start) / 1000);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.addEventListener('resize', () => resize());
}

function initCeoVideo() {
  const video = document.getElementById('lp-ceo-video');
  const playButton = document.querySelector('.lp-video-play');
  if (!video || !playButton) return;
  playButton.addEventListener('click', () => {
    if (!video.currentSrc) return; // no real source uploaded yet -- the placeholder note already explains this
    video.play();
    playButton.hidden = true;
  });
}

initSilkBackground();
initCeoVideo();
