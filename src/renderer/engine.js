import { program, uniforms, createFBO, loadTexture } from './gl.js'
import { hexToRgb } from './color.js'
import { build as radial } from './visualizers/radial.js'
import { build as linear } from './visualizers/linear.js'
import { build as waveform } from './visualizers/waveform.js'
import { build as ring } from './visualizers/ring.js'
import { build as dots } from './visualizers/dots.js'

const VIS = { radial, linear, waveform, ring, dots }
const WAVE_STYLES = new Set(['waveform', 'ring'])   // styles that need time-domain samples
const MODE = { TRIANGLES: 4, TRIANGLE_STRIP: 5, LINE_STRIP: 3 }

const SOLID_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
uniform vec2 u_res;
out vec4 v_color;
void main(){ vec2 c=vec2(a_pos.x/u_res.x*2.0-1.0, 1.0-a_pos.y/u_res.y*2.0); gl_Position=vec4(c,0.0,1.0); v_color=a_color; }`

const SOLID_FS = `#version 300 es
precision highp float; in vec4 v_color; out vec4 o; void main(){ o=v_color; }`

const TEX_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
uniform vec2 u_res; out vec2 v_uv;
void main(){ vec2 c=vec2(a_pos.x/u_res.x*2.0-1.0, 1.0-a_pos.y/u_res.y*2.0); gl_Position=vec4(c,0.0,1.0); v_uv=a_uv; }`

const TEX_FS = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha; out vec4 o;
void main(){ vec4 t=texture(u_tex,v_uv); o=vec4(t.rgb, t.a*u_alpha); }`

const FS_VS = `#version 300 es
precision highp float; layout(location=0) in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv=a_pos*0.5+0.5; gl_Position=vec4(a_pos,0.0,1.0); }`

const GRAD_FS = `#version 300 es
precision highp float; in vec2 v_uv; uniform vec3 c0; uniform vec3 c1; out vec4 o;
void main(){ o=vec4(mix(c0,c1,v_uv.y),1.0); }`

const BRIGHT_FS = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; uniform float u_thresh; out vec4 o;
void main(){ vec3 c=texture(u_tex,v_uv).rgb; float l=max(max(c.r,c.g),c.b); float k=max(l-u_thresh,0.0)/max(l,1e-4); o=vec4(c*k,1.0); }`

const BLUR_FS = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_dir; out vec4 o;
void main(){
  vec3 s=texture(u_tex,v_uv).rgb*0.227027;
  vec2 d1=u_dir*1.3846153846, d2=u_dir*3.2307692308;
  s+=texture(u_tex,v_uv+d1).rgb*0.3162162162; s+=texture(u_tex,v_uv-d1).rgb*0.3162162162;
  s+=texture(u_tex,v_uv+d2).rgb*0.0702702703; s+=texture(u_tex,v_uv-d2).rgb*0.0702702703;
  o=vec4(s,1.0);
}`

const COMP_FS = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_scene; uniform sampler2D u_bloom; uniform float u_glow; out vec4 o;
void main(){ vec3 c=texture(u_scene,v_uv).rgb + texture(u_bloom,v_uv).rgb*u_glow; o=vec4(c,1.0); }`

const PRESENT_FS = `#version 300 es
precision highp float; in vec2 v_uv; uniform sampler2D u_tex; uniform float u_gain; out vec4 o; void main(){ o=vec4(texture(u_tex,v_uv).rgb*u_gain,1.0); }`

export class Engine {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false })
    if (!gl) throw new Error('WebGL2 is not available.')
    this.canvas = canvas
    this.gl = gl
    this.W = 1920; this.H = 1080
    canvas.width = this.W; canvas.height = this.H
    this.tex = { bg: null, logo: null }
    this._texPath = { bg: null, logo: null }
    this.video = null; this.videoTex = null; this._videoPath = null
    this.ap = null; this.visual = null; this.style = 'radial'
    this.hasAudio = false; this.audio = null
    this._renderMode = false; this._stopped = false

    this.pSolid = program(gl, SOLID_VS, SOLID_FS); this.uSolid = uniforms(gl, this.pSolid, ['u_res'])
    this.pTex = program(gl, TEX_VS, TEX_FS); this.uTex = uniforms(gl, this.pTex, ['u_res', 'u_tex', 'u_alpha'])
    this.pGrad = program(gl, FS_VS, GRAD_FS); this.uGrad = uniforms(gl, this.pGrad, ['c0', 'c1'])
    this.pBright = program(gl, FS_VS, BRIGHT_FS); this.uBright = uniforms(gl, this.pBright, ['u_tex', 'u_thresh'])
    this.pBlur = program(gl, FS_VS, BLUR_FS); this.uBlur = uniforms(gl, this.pBlur, ['u_tex', 'u_dir'])
    this.pComp = program(gl, FS_VS, COMP_FS); this.uComp = uniforms(gl, this.pComp, ['u_scene', 'u_bloom', 'u_glow'])
    this.pPresent = program(gl, FS_VS, PRESENT_FS); this.uPresent = uniforms(gl, this.pPresent, ['u_tex', 'u_gain'])

    this._initBuffers()
    this.scene = createFBO(gl, this.W, this.H)
    this.output = createFBO(gl, this.W, this.H)
    this.bloomA = createFBO(gl, this.W >> 1, this.H >> 1)
    this.bloomB = createFBO(gl, this.W >> 1, this.H >> 1)

    this._listenPort()
  }

  _initBuffers() {
    const gl = this.gl
    this.vaoSolid = gl.createVertexArray(); this.bufSolid = gl.createBuffer()
    gl.bindVertexArray(this.vaoSolid); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSolid)
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8)

    this.vaoTex = gl.createVertexArray(); this.bufTex = gl.createBuffer()
    gl.bindVertexArray(this.vaoTex); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufTex)
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8)

    this.vaoFS = gl.createVertexArray(); this.bufFS = gl.createBuffer()
    gl.bindVertexArray(this.vaoFS); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufFS)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  setParams(p) { this.ap = p.ap; this.visual = p.visual; this.style = p.style }
  setAudio(el) { this.audio = el }
  setAudioLoaded(b) { this.hasAudio = b }

  async setTexture(kind, path) {
    if (this._texPath[kind] === path) return
    this._texPath[kind] = path
    if (!path) { this.tex[kind] = null; return }
    try { this.tex[kind] = await loadTexture(this.gl, 'file://' + path.replace(/\\/g, '/')) }
    catch { this.tex[kind] = null }
  }

  setVideoBackground(path) {
    if (this._videoPath === path) return
    this._videoPath = path
    if (!path) {
      if (this.video) { try { this.video.pause() } catch {}; this.video.removeAttribute('src'); this.video.load() }
      this.video = null
      return
    }
    if (!this.video) {
      const v = document.createElement('video')
      v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true
      this.video = v
    }
    if (!this.videoTex) {
      const gl = this.gl, t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.videoTex = t
    }
    this.video.src = 'file://' + path.replace(/\\/g, '/')
    this.video.play().catch(() => {})
  }

  start() { this._frameLoop() }

  async _frameLoop() {
    if (!this._stopped && !this._renderMode && this.visual && this.ap) {
      let frame = null
      if (this.hasAudio && this.audio) {
        try {
          const n = Math.max(0, Math.round(this.audio.currentTime * 60))
          const r = await window.api.previewBands(n, this.ap, WAVE_STYLES.has(this.style))
          if (r) frame = { bands: r.bands, bass: r.bass, time: this.audio.currentTime, waveform: r.waveform }
        } catch {}
      }
      if (!frame) { const z = new Float32Array(this.ap.barCount); frame = { bands: z, bass: 0, time: 0, waveform: null } }
      try { this._pipeline(frame, true) } catch {}
    }
    requestAnimationFrame(() => this._frameLoop())
  }

  _drawBackground() {
    const gl = this.gl, bg = this.visual.background
    if (bg.type === 'gradient') {
      const c0 = hexToRgb(bg.color2), c1 = hexToRgb(bg.color)
      gl.useProgram(this.pGrad); gl.uniform3fv(this.uGrad.c0, c0); gl.uniform3fv(this.uGrad.c1, c1)
      gl.bindVertexArray(this.vaoFS); gl.drawArrays(gl.TRIANGLES, 0, 3)
    } else if (bg.type === 'image' && this.tex.bg) {
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT)
      this._drawTexQuad(this.tex.bg.tex, 0, 0, this.W, this.H, 1)
    } else if (bg.type === 'video') {
      // Scene stays black; the video is screened in at present (preview) / by ffmpeg (render).
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      const c = hexToRgb(bg.color); gl.clearColor(c[0], c[1], c[2], 1); gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  _drawSolid(out) {
    const gl = this.gl
    gl.useProgram(this.pSolid); gl.uniform2f(this.uSolid.u_res, this.W, this.H)
    gl.bindVertexArray(this.vaoSolid); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSolid)
    gl.bufferData(gl.ARRAY_BUFFER, out.data, gl.DYNAMIC_DRAW)
    gl.drawArrays(MODE[out.mode], 0, out.count)
  }

  _drawTexQuad(tex, x0, y0, x1, y1, alpha) {
    const gl = this.gl
    const d = new Float32Array([
      x0, y0, 0, 0, x1, y0, 1, 0, x1, y1, 1, 1,
      x0, y0, 0, 0, x1, y1, 1, 1, x0, y1, 0, 1
    ])
    gl.useProgram(this.pTex); gl.uniform2f(this.uTex.u_res, this.W, this.H)
    gl.uniform1i(this.uTex.u_tex, 0); gl.uniform1f(this.uTex.u_alpha, alpha)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.bindVertexArray(this.vaoTex); gl.bindBuffer(gl.ARRAY_BUFFER, this.bufTex)
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  _drawLogo(bass) {
    const lg = this.visual.logo, t = this.tex.logo
    const minDim = Math.min(this.W, this.H)
    const scale = lg.size * minDim * (1 + lg.pulse * bass)
    const aspect = t.w / t.h
    let w = scale, h = scale
    if (aspect >= 1) h = scale / aspect; else w = scale * aspect
    const cx = this.W / 2, cy = this.H / 2
    this._drawTexQuad(t.tex, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, lg.opacity != null ? lg.opacity : 1)
  }

  _bloom() {
    const gl = this.gl, hw = this.W >> 1, hh = this.H >> 1
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo); gl.viewport(0, 0, hw, hh)
    gl.useProgram(this.pBright); gl.uniform1i(this.uBright.u_tex, 0); gl.uniform1f(this.uBright.u_thresh, 0.25)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex)
    gl.bindVertexArray(this.vaoFS); gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.useProgram(this.pBlur); gl.uniform1i(this.uBlur.u_tex, 0)
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fbo); gl.viewport(0, 0, hw, hh)
      gl.uniform2f(this.uBlur.u_dir, 1 / hw, 0)
      gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex); gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fbo); gl.viewport(0, 0, hw, hh)
      gl.uniform2f(this.uBlur.u_dir, 0, 1 / hh)
      gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex); gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
  }

  _presentTex(tex, gain) {
    const gl = this.gl
    gl.useProgram(this.pPresent); gl.uniform1i(this.uPresent.u_tex, 0); gl.uniform1f(this.uPresent.u_gain, gain == null ? 1 : gain)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.bindVertexArray(this.vaoFS); gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  _pipeline(frame, present) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo); gl.viewport(0, 0, this.W, this.H)
    gl.disable(gl.BLEND)
    this._drawBackground()
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    const out = VIS[this.style]({ bands: frame.bands, W: this.W, H: this.H, time: frame.time, bass: frame.bass, waveform: frame.waveform, v: this.visual })
    this._drawSolid(out)
    if (this.tex.logo && this.visual.logo.path) this._drawLogo(frame.bass)
    gl.disable(gl.BLEND)

    const glow = this.visual.glow || 0
    if (glow > 0) this._bloom()

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.output.fbo); gl.viewport(0, 0, this.W, this.H)
    gl.useProgram(this.pComp)
    gl.uniform1i(this.uComp.u_scene, 0); gl.uniform1i(this.uComp.u_bloom, 1); gl.uniform1f(this.uComp.u_glow, glow)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex)
    gl.bindVertexArray(this.vaoFS); gl.drawArrays(gl.TRIANGLES, 0, 3)

    if (present) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      const vid = this.visual.background.type === 'video' && this.videoTex && this.video && this.video.readyState >= 2
      if (vid) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        const op = this.visual.background.videoOpacity
        gl.disable(gl.BLEND); this._presentTex(this.videoTex, op == null ? 1 : op)
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR)   // screen blend, matches ffmpeg
        this._presentTex(this.output.tex, 1)
        gl.disable(gl.BLEND)
      } else {
        this._presentTex(this.output.tex)
      }
    }
  }

  _listenPort() {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__visiblazerPort) this._attach(e.ports[0], e.data.meta)
    })
  }

  _attach(port, meta) {
    this._renderMode = true
    this.style = meta.style
    this.visual = meta.visual
    const W = meta.width, H = meta.height
    port.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'produce') {
        try {
          this._pipeline({ bands: m.bands, bass: m.bass, time: m.time, waveform: m.waveform }, false)
          const gl = this.gl
          const buf = new Uint8Array(W * H * 4)
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.output.fbo)
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
          // Send by structured-clone copy — MessagePortMain (renderer->main) does
          // not carry a transferred ArrayBuffer, it silently drops the message.
          port.postMessage({ type: 'frame', frame: m.frame, data: buf })
        } catch (e) { console.error('Visiblazer frame error: ' + (e && e.stack || e)) }
      } else if (m.type === 'end') {
        this._renderMode = false
      }
    }
    port.postMessage({ type: 'ready' })
  }
}
