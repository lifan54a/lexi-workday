(() => {
  "use strict";

  const hero = document.querySelector(".hero-editorial");
  if (!hero || hero.querySelector(".pixelblast-static")) return;

  const canvas = document.createElement("canvas");
  canvas.className = "pixelblast-static";
  canvas.setAttribute("aria-hidden", "true");
  hero.prepend(canvas);

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  if (!gl) {
    canvas.remove();
    return;
  }

  const vertexSource = `#version 300 es
    precision highp float;
    void main() {
      vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
    }
  `;

  const fragmentSource = `#version 300 es
    precision highp float;

    uniform vec3 uColor;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uPixelSize;
    uniform float uScale;
    uniform float uDensity;
    uniform float uPixelJitter;
    uniform float uRippleSpeed;
    uniform float uRippleThickness;
    uniform float uRippleIntensity;
    uniform float uEdgeFade;
    uniform vec2 uClickPos[10];
    uniform float uClickTimes[10];

    out vec4 fragColor;

    float Bayer2(vec2 a) {
      a = floor(a);
      return fract(a.x / 2.0 + a.y * a.y * 0.75);
    }
    #define Bayer4(a) (Bayer2(0.5 * (a)) * 0.25 + Bayer2(a))
    #define Bayer8(a) (Bayer4(0.5 * (a)) * 0.25 + Bayer2(a))

    float hash11(float n) {
      return fract(sin(n) * 43758.5453);
    }

    float vnoise(vec3 p) {
      vec3 ip = floor(p);
      vec3 fp = fract(p);
      float n000 = hash11(dot(ip + vec3(0.0, 0.0, 0.0), vec3(1.0, 57.0, 113.0)));
      float n100 = hash11(dot(ip + vec3(1.0, 0.0, 0.0), vec3(1.0, 57.0, 113.0)));
      float n010 = hash11(dot(ip + vec3(0.0, 1.0, 0.0), vec3(1.0, 57.0, 113.0)));
      float n110 = hash11(dot(ip + vec3(1.0, 1.0, 0.0), vec3(1.0, 57.0, 113.0)));
      float n001 = hash11(dot(ip + vec3(0.0, 0.0, 1.0), vec3(1.0, 57.0, 113.0)));
      float n101 = hash11(dot(ip + vec3(1.0, 0.0, 1.0), vec3(1.0, 57.0, 113.0)));
      float n011 = hash11(dot(ip + vec3(0.0, 1.0, 1.0), vec3(1.0, 57.0, 113.0)));
      float n111 = hash11(dot(ip + vec3(1.0, 1.0, 1.0), vec3(1.0, 57.0, 113.0)));
      vec3 w = fp * fp * fp * (fp * (fp * 6.0 - 15.0) + 10.0);
      float x00 = mix(n000, n100, w.x);
      float x10 = mix(n010, n110, w.x);
      float x01 = mix(n001, n101, w.x);
      float x11 = mix(n011, n111, w.x);
      float y0 = mix(x00, x10, w.y);
      float y1 = mix(x01, x11, w.y);
      return mix(y0, y1, w.z) * 2.0 - 1.0;
    }

    float fbm2(vec2 uv, float time) {
      vec3 p = vec3(uv * uScale, time);
      float amplitude = 1.0;
      float frequency = 1.0;
      float sum = 1.0;
      for (int i = 0; i < 5; ++i) {
        sum += amplitude * vnoise(p * frequency);
        frequency *= 1.25;
        amplitude *= 1.0;
      }
      return sum * 0.5 + 0.5;
    }

    float circleMask(vec2 point, float coverage) {
      float radius = sqrt(coverage) * 0.25;
      float distanceToCircle = length(point - 0.5) - radius;
      float antialiasWidth = 0.5 * fwidth(distanceToCircle);
      return coverage * (1.0 - smoothstep(
        -antialiasWidth,
        antialiasWidth,
        distanceToCircle * 2.0
      ));
    }

    void main() {
      vec2 fragment = gl_FragCoord.xy - uResolution * 0.5;
      float aspect = uResolution.x / uResolution.y;
      vec2 pixelId = floor(fragment / uPixelSize);
      vec2 pixelUv = fract(fragment / uPixelSize);
      float cellSize = 8.0 * uPixelSize;
      vec2 cellId = floor(fragment / cellSize);
      vec2 uv = cellId * cellSize / uResolution * vec2(aspect, 1.0);

      float base = fbm2(uv, uTime * 0.05);
      base = base * 0.5 - 0.65;
      float feed = base + (uDensity - 0.5) * 0.3;

      for (int i = 0; i < 10; ++i) {
        vec2 clickPosition = uClickPos[i];
        if (clickPosition.x < 0.0) continue;
        vec2 clickUv = (
          (clickPosition - uResolution * 0.5 - cellSize * 0.5) / uResolution
        ) * vec2(aspect, 1.0);
        float elapsed = max(uTime - uClickTimes[i], 0.0);
        float radius = distance(uv, clickUv);
        float waveRadius = uRippleSpeed * elapsed;
        float ring = exp(-pow((radius - waveRadius) / uRippleThickness, 2.0));
        float attenuation = exp(-elapsed) * exp(-10.0 * radius);
        feed = max(feed, ring * attenuation * uRippleIntensity);
      }

      float bayer = Bayer8(fragment / uPixelSize) - 0.5;
      float visible = step(0.5, feed + bayer);
      float hash = fract(sin(dot(pixelId, vec2(127.1, 311.7))) * 43758.5453);
      float coverage = visible * (1.0 + (hash - 0.5) * uPixelJitter);
      float mask = circleMask(pixelUv, coverage);

      vec2 normalized = gl_FragCoord.xy / uResolution;
      float edge = min(
        min(normalized.x, normalized.y),
        min(1.0 - normalized.x, 1.0 - normalized.y)
      );
      mask *= smoothstep(0.0, uEdgeFade, edge);

      vec3 srgbColor = mix(
        uColor * 12.92,
        1.055 * pow(uColor, vec3(1.0 / 2.4)) - 0.055,
        step(0.0031308, uColor)
      );
      fragColor = vec4(srgbColor, mask);
    }
  `;

  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("PixelBlast shader failed:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vertexShader = createShader(gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) {
    canvas.remove();
    return;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("PixelBlast program failed:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    canvas.remove();
    return;
  }

  const uniforms = {};
  [
    "uColor",
    "uResolution",
    "uTime",
    "uPixelSize",
    "uScale",
    "uDensity",
    "uPixelJitter",
    "uRippleSpeed",
    "uRippleThickness",
    "uRippleIntensity",
    "uEdgeFade",
    "uClickPos",
    "uClickTimes",
  ].forEach((name) => {
    const lookupName = name === "uClickPos" || name === "uClickTimes"
      ? `${name}[0]`
      : name;
    uniforms[name] = gl.getUniformLocation(program, lookupName);
  });

  const clicks = Array.from({ length: 10 }, () => [-1, -1]);
  const clickTimes = new Float32Array(10);
  let clickIndex = 0;
  let pixelRatio = 1;
  let currentTime = 0;
  let visible = true;

  function linearChannel(channel) {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function resize() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(hero.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(hero.clientHeight * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function recordRipple(event) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    clicks[clickIndex] = [
      (event.clientX - rect.left) * scaleX,
      (rect.height - (event.clientY - rect.top)) * scaleY,
    ];
    clickTimes[clickIndex] = currentTime;
    clickIndex = (clickIndex + 1) % clicks.length;
  }

  const randomValues = new Uint32Array(1);
  const randomValue = window.crypto?.getRandomValues
    ? (window.crypto.getRandomValues(randomValues), randomValues[0] / 0xffffffff)
    : Math.random();
  const timeOffset = randomValue * 1000;
  const startedAt = performance.now();

  gl.useProgram(program);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform3f(
    uniforms.uColor,
    linearChannel(0x55),
    linearChannel(0x8c),
    linearChannel(0xff),
  );
  gl.uniform1f(uniforms.uScale, 2.5);
  gl.uniform1f(uniforms.uDensity, 1.25);
  gl.uniform1f(uniforms.uPixelJitter, 0.5);
  gl.uniform1f(uniforms.uRippleSpeed, 0.4);
  gl.uniform1f(uniforms.uRippleThickness, 0.12);
  gl.uniform1f(uniforms.uRippleIntensity, 1.5);
  gl.uniform1f(uniforms.uEdgeFade, 0.28);

  function render(timestamp) {
    if (visible) {
      resize();
      currentTime = timeOffset + ((timestamp - startedAt) / 1000) * 0.6;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uTime, currentTime);
      gl.uniform1f(uniforms.uPixelSize, 5 * pixelRatio);
      gl.uniform2fv(uniforms.uClickPos, clicks.flat());
      gl.uniform1fv(uniforms.uClickTimes, clickTimes);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(render);
  }

  hero.addEventListener("pointerdown", recordRipple, { passive: true });
  new ResizeObserver(resize).observe(hero);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  }).observe(hero);
  resize();
  requestAnimationFrame(render);
})();
