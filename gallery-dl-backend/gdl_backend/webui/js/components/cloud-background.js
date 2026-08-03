const VERTEX_SOURCE = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SOURCE = `
  precision mediump float;

  uniform vec2 u_resolution;
  uniform float u_time;
  uniform vec3 u_accent;
  uniform vec3 u_surface;

  float hash(vec2 p) {
    p = fract(p * vec2(233.14, 113.23));
    p += dot(p, p.yx + 19.19);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 st = gl_FragCoord.xy / u_resolution.xy;
    st.x *= u_resolution.x / u_resolution.y;
    float cloud = fbm(st * 3.0 + vec2(u_time * 0.05, u_time * 0.02));
    cloud = smoothstep(0.3, 0.7, cloud);

    int x = int(mod(gl_FragCoord.x, 4.0));
    int y = int(mod(gl_FragCoord.y, 4.0));
    float limit = 0.0;
    if (x == 0 && y == 0) limit = 0.0000;
    if (x == 1 && y == 0) limit = 0.5000;
    if (x == 2 && y == 0) limit = 0.1250;
    if (x == 3 && y == 0) limit = 0.6250;
    if (x == 0 && y == 1) limit = 0.7500;
    if (x == 1 && y == 1) limit = 0.2500;
    if (x == 2 && y == 1) limit = 0.8750;
    if (x == 3 && y == 1) limit = 0.3750;
    if (x == 0 && y == 2) limit = 0.1875;
    if (x == 1 && y == 2) limit = 0.6875;
    if (x == 2 && y == 2) limit = 0.0625;
    if (x == 3 && y == 2) limit = 0.5625;
    if (x == 0 && y == 3) limit = 0.9375;
    if (x == 1 && y == 3) limit = 0.4375;
    if (x == 2 && y == 3) limit = 0.8125;
    if (x == 3 && y == 3) limit = 0.3125;

    float step_value = step(limit, cloud);
    gl_FragColor = vec4(mix(u_accent, u_surface, step_value), 1.0);
  }
`;

function oklchToRgb(hueDegrees) {
  const lightness = 0.55;
  const chroma = 0.12;
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((value) => {
    const channel = Math.max(0, Math.min(1, value));
    return channel <= 0.0031308
      ? 12.92 * channel
      : 1.055 * channel ** (1 / 2.4) - 0.055;
  });
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建云背景着色器");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error("云背景着色器编译失败");
  }
  return shader;
}

export function initializeCloudBackground(root = document) {
  const wrapper = root.querySelector("[data-cloud-background]");
  const canvas = root.querySelector("[data-cloud-canvas]");
  if (!(wrapper instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
    return () => {};
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const disposers = [];
  let animationFrame;
  let failed = false;
  let contextLost = false;
  let gl;
  let program;
  let buffer;

  const cancelFrame = () => {
    if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
  };

  const releaseResources = () => {
    if (!gl || contextLost) return;
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    buffer = undefined;
    program = undefined;
  };

  const useFallback = () => {
    if (failed) return;
    failed = true;
    cancelFrame();
    for (const dispose of disposers.splice(0)) dispose();
    releaseResources();
    canvas.removeAttribute("data-ready");
    wrapper.dataset.cloudState = "fallback";
    wrapper.dataset.cloudMotion = "static";
  };

  try {
    gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: reducedMotion.matches,
    });
    if (!gl) throw new Error("浏览器不支持 WebGL");

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    program = gl.createProgram();
    if (!program) throw new Error("无法创建云背景程序");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("云背景程序链接失败");
    }
    gl.useProgram(program);

    buffer = gl.createBuffer();
    if (!buffer) throw new Error("无法创建云背景缓冲区");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const position = gl.getAttribLocation(program, "a_position");
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const time = gl.getUniformLocation(program, "u_time");
    const accent = gl.getUniformLocation(program, "u_accent");
    const surface = gl.getUniformLocation(program, "u_surface");
    if (position < 0 || !resolution || !time || !accent || !surface) {
      throw new Error("云背景着色器接口不完整");
    }
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const configuredHue = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--imageweave-hue"),
    );
    gl.uniform3fv(accent, oklchToRgb(Number.isFinite(configuredHue) ? configuredHue : 345));
    gl.uniform3fv(surface, [1, 1, 1]);

    const startedAt = performance.now();
    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.floor(window.innerWidth * scale));
      const height = Math.max(1, Math.floor(window.innerHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const renderFrame = (now) => {
      animationFrame = undefined;
      if (failed || document.hidden) return;
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, reducedMotion.matches ? 0 : (now - startedAt) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      wrapper.dataset.cloudMotion = reducedMotion.matches ? "static" : "running";
      if (!reducedMotion.matches) {
        animationFrame = window.requestAnimationFrame(renderFrame);
      }
    };

    const restart = () => {
      cancelFrame();
      if (failed) return;
      if (document.hidden) {
        wrapper.dataset.cloudMotion = "paused";
        return;
      }
      resize();
      renderFrame(performance.now());
    };

    const onResize = () => restart();
    const onVisibilityChange = () => restart();
    const onMotionChange = () => restart();
    const onContextLost = (event) => {
      event.preventDefault();
      contextLost = true;
      useFallback();
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener("change", onMotionChange);
    canvas.addEventListener("webglcontextlost", onContextLost, { once: true });
    disposers.push(
      () => window.removeEventListener("resize", onResize),
      () => document.removeEventListener("visibilitychange", onVisibilityChange),
      () => reducedMotion.removeEventListener("change", onMotionChange),
      () => canvas.removeEventListener("webglcontextlost", onContextLost),
    );

    restart();
    canvas.setAttribute("data-ready", "");
    wrapper.dataset.cloudState = "ready";
  } catch {
    useFallback();
  }

  return () => {
    if (!failed) {
      cancelFrame();
      for (const dispose of disposers.splice(0)) dispose();
      releaseResources();
      wrapper.dataset.cloudState = "fallback";
      wrapper.dataset.cloudMotion = "static";
      canvas.removeAttribute("data-ready");
    }
  };
}
