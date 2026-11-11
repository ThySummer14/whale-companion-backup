import { MotionEngine } from './engine.mjs'

async function readProfile(basePath) {
  const response = await fetch(`${basePath}/data/model-profile.json`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`模型配置读取失败：${response.status}`)
  return response.json()
}

function boostClippingMask(model) {
  let retries = 0
  let frame
  const check = () => {
    const manager = model.internalModel.renderer?._clippingManager
    if (manager && typeof manager.setClippingMaskBufferSize === 'function') {
      if (manager.getClippingMaskBufferSize() < 2048) {
        manager.setClippingMaskBufferSize(2048)
        manager._maskTexture = null
        manager._colorBuffer = null
        manager._currentFrameNo = 0
      }
    } else if (retries++ < 180) frame = requestAnimationFrame(check)
  }
  check()
  return () => { if (frame !== undefined) cancelAnimationFrame(frame) }
}

export async function createAvatarRenderer(canvas, {
  basePath = '', beforeTick, onAction = () => {}, onMouth, scale = () => 1, maxFps,
} = {}) {
  const profile = await readProfile(basePath)
  const { PIXI } = globalThis
  const app = new PIXI.Application({
    view: canvas, backgroundAlpha: 0, antialias: true, autoDensity: true,
    resolution: Math.min(devicePixelRatio || 1, maxFps ? 1 : 1.5), powerPreference: maxFps ? 'low-power' : 'high-performance',
    ...(maxFps && { autoStart: false }),
  })
  let observer, stopMaskCheck
  const destroy = () => {
    observer?.disconnect()
    stopMaskCheck?.()
    app.destroy(false, { children: true, texture: true, baseTexture: true })
  }
  try {
    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker)
    const model = await PIXI.live2d.Live2DModel.from(`${basePath}/model/大肥鱼.model3.json`, {
      autoInteract: false, autoUpdate: !maxFps, motionPreload: 'NONE',
    })
    if (maxFps) {
      // Use the capped application ticker for both Cubism updates and drawing.
      app.ticker.maxFPS = maxFps
      app.ticker.add(() => model.update(app.ticker.deltaMS))
    }
    app.stage.addChild(model)
    stopMaskCheck = boostClippingMask(model)
    const internal = model.internalModel
    const engine = new MotionEngine(internal.coreModel, profile, onAction)
    internal.eyeBlink = undefined
    internal.breath = undefined
    internal.updateFocus = () => {}
    let lastTick = performance.now()
    internal.updateNaturalMovements = () => {
      const now = performance.now()
      beforeTick?.(engine, now)
      engine.tick(now - lastTick)
      lastTick = now
    }
    // Cubism restores saved parameters after rendering.
    if (onMouth) internal.on('beforeModelUpdate', () => onMouth(internal.coreModel.getParameterValueById('ParamMouthOpenY')))
    const gl = app.renderer.gl
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = String(gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).slice(0, 160)
    const parameterCount = typeof internal.coreModel.getParameterCount === 'function' ? internal.coreModel.getParameterCount() : undefined
    const resize = () => {
      const { clientWidth: width, clientHeight: height } = canvas.parentElement
      if (!width || !height) return
      app.renderer.resize(width, height)
      const zoom = scale()
      const fit = Math.min(width * 0.92 / internal.originalWidth, height * 0.94 / internal.originalHeight) * zoom
      model.scale.set(fit)
      model.anchor.set(0.5, 0)
      model.position.set(width / 2, height * (0.03 + (1 - zoom) / 2))
    }
    observer = new ResizeObserver(resize)
    observer.observe(canvas.parentElement)
    resize()
    app.renderer.render(app.stage)
    const setRunning = running => {
      if (running && !app.ticker.started) {
        lastTick = performance.now()
        app.start()
      } else if (!running && app.ticker.started) app.stop()
    }
    return { model, engine, profile, renderer, parameterCount, resize, setRunning, destroy }
  } catch (error) {
    destroy()
    throw error
  }
}
