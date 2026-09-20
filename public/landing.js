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

    float height(vec2 p) {
      float n = warpedFbm(p);
      float ridged = 1.0 - abs(n * 2.0 - 1.0);
      return pow(ridged, 2.0);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uResolution.xy;
      vec2 p = uv;
      p.x *= uResolution.x / uResolution.y;
      vec2 stretched = vec2(p.x * 1.6, p.y * 0.6); // anisotropic stretch -> directional folds

      float e = 0.0025;
      float h = height(stretched);
      float hx = height(stretched + vec2(e, 0.0)) - h;
      float hy = height(stretched + vec2(0.0, e)) - h;
      vec3 normal = normalize(vec3(-hx, -hy, e * 5.0));

      vec3 lightDir = normalize(vec3(0.4, 0.7, 0.6));
      float diffuse = max(dot(normal, lightDir), 0.0);
      vec3 halfDir = normalize(lightDir + vec3(0.0, 0.0, 1.0));
      float spec = pow(max(dot(normal, halfDir), 0.0), 48.0);

      // LUX brand palette: deep cobalt through the brand's own royal blue,
      // with a brushed-silver sheen (not icy blue-white) to match the
      // wordmark's chrome bevel highlight.
      vec3 deep = vec3(0.035, 0.067, 0.243);
      vec3 mid = vec3(0.071, 0.129, 0.580);
      vec3 sheen = vec3(0.769, 0.804, 0.863);

      vec3 color = mix(deep, mid, h * 0.75 + diffuse * 0.22);
      color += sheen * spec * 0.75;

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
