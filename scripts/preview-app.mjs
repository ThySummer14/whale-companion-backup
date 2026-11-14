#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, open, readFile, readdir, realpath, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = join(root, 'apps/dsh-go/app')
const work = join(root, '.work/app-preview')
const packageId = 'ai.companion.whale'
const avd = 'companion-android'
const port = 5580
const defaultApk = join(app, 'build/app/outputs/flutter-apk/app-companion-debug.apk')
const gib = 1024 ** 3
const usage = `真实 Android App 本地预览（不复制工程、不自动下载镜像）

  pnpm app:preview                  打开现有安装包，不编译
  pnpm app:preview -- dev            打开并连接热重载：r 刷新，R 重启，d 断开
  pnpm app:preview -- build          重新编译同一个 debug 包，默认仅使用缓存依赖
  pnpm app:preview -- build --online 允许构建时下载缺失依赖
  pnpm app:preview -- status         查看专用模拟器、安装包和剩余空间
  pnpm app:preview -- screenshot     覆盖保存 .work/app-preview/screenshot.png
  pnpm app:preview -- stop           关闭本工具启动的模拟器，保留 App 数据

start/dev 可加 --rebuild；--apk PATH 可指定同一 App 的 debug 包。
只操作 companion-android；不会卸载、清数据、删除缓存或创建新模拟器。
构建日志最多 2 MiB；模拟器不保存内存快照；首次使用需在 App 中正常配对。`

export function parseOptions(args) {
  const options = { command: 'start', rebuild: false, online: false, apk: defaultApk }
  const commands = new Set(['start', 'dev', 'build', 'status', 'stop', 'screenshot'])
  let commandSeen = false
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value === '--') continue
    if (value === '--help' || value === '-h') options.command = 'help'
    else if (value === '--rebuild') options.rebuild = true
    else if (value === '--online') options.online = true
    else if (value === '--apk') {
      const path = args[++index]
      if (!path || path.startsWith('-')) throw new Error('--apk 需要安装包路径')
      options.apk = resolve(path)
    } else if (commands.has(value) && !commandSeen) {
      options.command = value
      commandSeen = true
    } else throw new Error(`不支持的参数：${value}\n${usage}`)
  }
  if (options.online && options.command !== 'build' && !options.rebuild) {
    throw new Error('--online 只能用于明确请求的构建')
  }
  if (options.rebuild && !['start', 'dev'].includes(options.command)) throw new Error('--rebuild 只用于 start/dev')
  return options
}

export function parseDevices(text) {
  return text.split(/\r?\n/u).flatMap(line => {
    const match = /^(emulator-\d+)\s+(\S+)/u.exec(line)
    return match ? [{ serial: match[1], state: match[2] }] : []
  })
}

export async function selectDevice(text, getName) {
  const matches = []
  for (const device of parseDevices(text)) {
    if (device.state === 'device' && await getName(device.serial) === avd) matches.push(device.serial)
  }
  if (matches.length > 1) throw new Error('发现多个 companion-android 实例，请先保留一个')
  return matches[0]
}

export function parseDnsServers(text) {
  return [...new Set([...text.matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/gmu)]
    .map(match => match[1]).filter(address => address.split('.').every(part => Number(part) <= 255)))].slice(0, 4)
}

export function javaPropertiesPath(path) {
  return path.replace(/\\/gu, '\\\\').replace(/[^\x20-\x7e]/gu, char =>
    Array.from({ length: char.length }, (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''))
}

export function checkSpace(bytes, building = false) {
  const minimum = (building ? 12 : 4) * gib
  if (bytes < minimum) throw new Error(`剩余空间 ${(bytes / gib).toFixed(1)} GiB，${building ? '构建至少预留 12' : '启动至少预留 4'} GiB；请先检查存储，不会自动清理文件`)
}

async function exists(path, executable = false) {
  try { await access(path, executable ? constants.X_OK : constants.F_OK); return true }
  catch { return false }
}

async function run(command, args, options = {}) {
  try {
    const result = await exec(command, args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options })
    return result.stdout.trim()
  } catch (error) {
    throw new Error(`${command.split('/').at(-1)} 执行失败：${String(error.stderr || error.stdout || error.message).trim().slice(-2000)}`)
  }
}

async function executable(candidates, label) {
  for (const candidate of candidates.filter(Boolean)) if (await exists(candidate, true)) return candidate
  throw new Error(`未找到${label}，请参考 docs/app-preview.md 配置本机工具链`)
}

async function toolchain({ flutter = false } = {}) {
  const sdkCandidates = [process.env.APP_PREVIEW_ANDROID_SDK, process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    '/opt/homebrew/share/android-commandlinetools', join(homedir(), 'Library/Android/sdk')]
  const adb = await executable(sdkCandidates.map(path => path && join(path, 'platform-tools/adb')), ' Android SDK')
  const sdk = dirname(dirname(adb))
  const emulator = join(sdk, 'emulator/emulator')
  if (!await exists(emulator, true)) throw new Error('Android SDK 未安装 emulator；本工具不会自动下载')
  const tools = { sdk, adb, emulator }
  if (flutter) {
    const onPath = (process.env.PATH ?? '').split(':').map(path => join(path, 'flutter'))
    tools.flutter = await executable([
      process.env.APP_PREVIEW_FLUTTER_ROOT && join(process.env.APP_PREVIEW_FLUTTER_ROOT, 'bin/flutter'),
      join(root, '.work/toolchain/flutter/bin/flutter'), ...onPath,
    ], ' Flutter SDK')
    tools.flutterRoot = dirname(dirname(await realpath(tools.flutter)))
  }
  return tools
}

async function availableBytes() {
  const data = await statfs(root)
  return data.bavail * data.bsize
}

function device(tools, serial, args, options) {
  if (!/^emulator-\d+$/u.test(serial)) throw new Error('仅允许操作已核对的安卓模拟器')
  return run(tools.adb, ['-s', serial, ...args], options)
}

async function currentDevice(tools) {
  return selectDevice(await run(tools.adb, ['devices']), async serial => {
    try { return (await device(tools, serial, ['emu', 'avd', 'name'])).split(/\r?\n/u)[0] }
    catch { return '' }
  })
}

export async function withPreviewLock(directory, action) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'operation.lock')
  let handle
  try { handle = await open(path, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const previous = Number((await readFile(path, 'utf8')).trim())
    let running = true
    if (Number.isSafeInteger(previous) && previous > 0) {
      try { process.kill(previous, 0) } catch (error) { if (error.code === 'ESRCH') running = false }
    }
    if (running) throw new Error('另一项预览操作正在运行；不会并发构建或安装')
    await unlink(path)
    handle = await open(path, 'wx', 0o600)
  }
  try {
    await handle.writeFile(`${process.pid}\n`)
    return await action()
  } finally {
    await handle.close()
    await unlink(path)
  }
}

async function readState(name) {
  try { return JSON.parse(await readFile(join(work, name), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function saveState(name, state) {
  await mkdir(work, { recursive: true })
  await writeFile(join(work, name), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

async function portFree(portNumber) {
  return new Promise(resolvePort => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen(portNumber, '127.0.0.1', () => server.close(() => resolvePort(true)))
  })
}

async function ensureEmulator(tools) {
  const running = await currentDevice(tools)
  if (running) { console.log(`复用专用模拟器 ${running}`); return running }
  const avds = (await run(tools.emulator, ['-list-avds'])).split(/\r?\n/u)
  if (!avds.includes(avd)) throw new Error('未找到 companion-android；为避免新增镜像占用，请先配置专用 AVD')
  if (!await portFree(port) || !await portFree(port + 1)) throw new Error(`预览端口 ${port}/${port + 1} 已占用；不会使用其他设备`)
  checkSpace(await availableBytes())
  const dnsServers = parseDnsServers(await run('/usr/sbin/scutil', ['--dns']))
  if (!dnsServers.length) throw new Error('未找到 Mac 的 IPv4 DNS；请先连接网络后重试')
  console.log(`启动 Android 预览窗口（复用已有 AVD，禁用自动快照，沿用 Mac DNS：${dnsServers.join(', ')}）…`)
  const child = spawn(tools.emulator, ['-avd', avd, '-port', String(port), '-no-snapshot', '-no-boot-anim', '-memory', '2048', '-scale', '0.55',
    '-dns-server', dnsServers.join(',')], {
    detached: true, stdio: 'ignore',
  })
  await new Promise((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject) })
  child.unref()
  const serial = `emulator-${port}`
  const processArgs = (await run('/bin/ps', ['-p', String(child.pid), '-o', 'command='])).trim()
  const processStart = (await run('/bin/ps', ['-p', String(child.pid), '-o', 'lstart='])).trim()
  await saveState('emulator.json', { pid: child.pid, serial, avd, processArgs, processStart })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    try {
      if (await device(tools, serial, ['shell', 'getprop', 'sys.boot_completed'], { timeout: 5000 }) === '1') {
        if (await currentDevice(tools) !== serial) throw new Error('模拟器名称核对失败')
        return serial
      }
    } catch { /* The ADB transport is not ready during boot. */ }
    try { process.kill(child.pid, 0) } catch { throw new Error('模拟器启动后退出；可手动打开 companion-android 检查图形环境') }
    await delay(1000)
  }
  throw new Error('模拟器启动超时；保留现有进程和 App 数据，请用 status 检查')
}

export function installTimes(text) {
  const value = key => new RegExp(`^\\s*${key}=(.+)$`, 'mu').exec(text)?.[1].trim()
  return { firstInstallTime: value('firstInstallTime'), lastUpdateTime: value('lastUpdateTime') }
}

export async function installPackage({ apk, serial, invoke, saved }) {
  const before = installTimes(await invoke(['shell', 'dumpsys', 'package', packageId]))
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(apk)) hash.update(chunk)
  const digest = hash.digest('hex')
  if (before.firstInstallTime && saved?.serial === serial && saved?.sha256 === digest &&
      saved.firstInstallTime === before.firstInstallTime && saved.lastUpdateTime === before.lastUpdateTime) {
    return { ...saved, skipped: true }
  }
  const result = await invoke(['install', '-r', apk], { timeout: 120_000 })
  if (!/^Success$/mu.test(result)) throw new Error(`安装未成功：${result}；已停止，不会卸载或清除数据`)
  const after = installTimes(await invoke(['shell', 'dumpsys', 'package', packageId]))
  if (!after.firstInstallTime || before.firstInstallTime && before.firstInstallTime !== after.firstInstallTime) {
    throw new Error('安装时间发生异常变化，已停止后续操作')
  }
  return { serial, sha256: digest, ...after, skipped: false }
}

async function checkApk(tools, apk) {
  if (!await exists(apk)) throw new Error('没有当前 debug 安装包。请先运行 pnpm app:preview -- build；默认启动不会自动编译')
  const versions = (await readdir(join(tools.sdk, 'build-tools'))).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  const aapt = await executable(versions.map(version => join(tools.sdk, 'build-tools', version, 'aapt')), ' APK 检查工具')
  const badging = await run(aapt, ['dump', 'badging', apk])
  if (!badging.startsWith(`package: name='${packageId}' `) || !/^application-debuggable\b/mu.test(badging)) {
    throw new Error('只接受 ai.companion.whale 的 debug 包，不会安装其他应用')
  }
}

async function build(tools, online) {
  checkSpace(await availableBytes(), true)
  let javaHome = process.env.APP_PREVIEW_JAVA_HOME || process.env.JAVA_HOME
  if (!javaHome || !await exists(join(javaHome, 'bin/java'), true)) javaHome = await run('/usr/libexec/java_home', [])
  if (!await exists(join(javaHome, 'bin/java'), true)) throw new Error('未找到可用 JDK')
  await mkdir(work, { recursive: true })
  const properties = join(app, 'android/local.properties')
  const original = await readFile(properties, 'utf8')
  const updated = original.replace(/^flutter\.sdk=.*$/mu, `flutter.sdk=${javaPropertiesPath(tools.flutterRoot)}`)
  if (!/^flutter\.sdk=/mu.test(updated)) throw new Error('local.properties 缺少 flutter.sdk')
  const init = join(work, 'mirrors.gradle')
  await writeFile(init, "gradle.beforeProject { project ->\n  project.buildscript.repositories.maven { url = uri('https://maven.aliyun.com/repository/google') }\n}\n")
  const args = [':app:assembleCompanionDebug', '--console=plain', '--max-workers=2', '--init-script', init,
    '-Ptarget=lib/whale_main.dart', '-Ptarget-platform=android-arm64', ...(online ? [] : ['--offline'])]
  console.log(`重新构建同一个 debug 包（${online ? '允许下载缺失依赖' : '离线复用依赖'}，不创建归档副本）…`)
  await writeFile(properties, updated)
  try {
    await new Promise((resolveBuild, reject) => {
      const child = spawn(join(app, 'android/gradlew'), args, {
        cwd: join(app, 'android'), env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: tools.sdk, ANDROID_SDK_ROOT: tools.sdk },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks = []
      let total = 0
      const capture = data => {
        chunks.push(data); total += data.length
        while (total > 2 * 1024 * 1024 && chunks.length > 1) total -= chunks.shift().length
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      const interrupt = () => child.kill('SIGINT')
      const terminate = () => child.kill('SIGTERM')
      process.on('SIGINT', interrupt)
      process.on('SIGTERM', terminate)
      const detachSignals = () => {
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)
      }
      child.once('error', error => { detachSignals(); reject(error) })
      child.once('close', async code => {
        detachSignals()
        try {
          const output = Buffer.concat(chunks).subarray(-2 * 1024 * 1024)
          await writeFile(join(work, 'build.log'), output)
          if (code !== 0) reject(new Error(`构建失败，见 .work/app-preview/build.log${online ? '' : '；若缺少缓存依赖，可明确使用 build --online'}`))
          else resolveBuild()
        } catch (error) { reject(error) }
      })
    })
  } finally {
    if (await readFile(properties, 'utf8') === updated) await writeFile(properties, original)
    else console.warn('local.properties 在构建期间被其他程序改动，保留其最新内容')
  }
  console.log('构建完成，已覆盖原 debug 包；运行 pnpm app:preview 打开。')
}

async function launch(tools, serial) {
  await device(tools, serial, ['shell', 'am', 'start', '-n', `${packageId}/io.github.ccch1mneyyy.dsh_app.WhaleActivity`])
}

export function parseVmService(text) {
  const matches = [...text.matchAll(/The Dart VM service is listening on (http:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s]*)/gu)]
  if (!matches.length) return undefined
  const uri = new URL(matches.at(-1)[1])
  return { port: uri.port, pathname: uri.pathname }
}

async function attach(tools, serial) {
  const installed = await device(tools, serial, ['shell', 'dumpsys', 'package', packageId])
  if (!/flags=\[.*DEBUGGABLE/u.test(installed)) throw new Error('已安装的 App 不支持热重载')
  console.log('连接热重载：r 刷新，R 热重启，d 断开并保留 App。调试模式不代表正式版流畅度。')
  await device(tools, serial, ['shell', 'am', 'force-stop', packageId])
  await launch(tools, serial)
  let vm
  const deadline = Date.now() + 30_000
  while (!vm && Date.now() < deadline) {
    const pid = await device(tools, serial, ['shell', 'pidof', '-s', packageId]).catch(() => '')
    if (/^\d+$/u.test(pid)) {
      const logs = await device(tools, serial, ['logcat', '-d', '-t', '250', `--pid=${pid}`, '-s', 'flutter:I', '*:S'])
      vm = parseVmService(logs)
    }
    if (!vm) await delay(500)
  }
  if (!vm) throw new Error('未发现当前 App 的调试服务，App 保持运行；请检查安装包是否为 debug')
  const address = `http://127.0.0.1:${vm.port}${vm.pathname}`
  await new Promise((resolveAttach, reject) => {
    const child = spawn(tools.flutter, ['attach', '-d', serial, '--app-id', packageId, '-t', 'lib/whale_main.dart', '--debug-url', address], {
      cwd: app, stdio: 'inherit', env: { ...process.env, ANDROID_HOME: tools.sdk, ANDROID_SDK_ROOT: tools.sdk },
    })
    const interrupt = () => child.kill('SIGINT')
    process.on('SIGINT', interrupt)
    child.once('error', error => { process.off('SIGINT', interrupt); reject(error) })
    child.once('close', code => {
      process.off('SIGINT', interrupt)
      code === 0 ? resolveAttach() : reject(new Error(`热重载连接退出，代码 ${code}`))
    })
  })
}

async function stop(tools) {
  const state = await readState('emulator.json')
  const serial = await currentDevice(tools)
  if (!serial) { console.log('专用预览模拟器未运行。'); return }
  if (!state || state.serial !== serial || state.avd !== avd || !Number.isSafeInteger(state.pid)) throw new Error('模拟器不是本工具启动的，不会自动关闭')
  let args, started
  try {
    args = (await run('/bin/ps', ['-p', String(state.pid), '-o', 'command='])).trim()
    started = (await run('/bin/ps', ['-p', String(state.pid), '-o', 'lstart='])).trim()
  } catch { /* No matching owner process. */ }
  const expectedExecutable = [tools.emulator, join(dirname(tools.emulator), 'qemu/darwin-aarch64/qemu-system-aarch64')]
    .some(path => args?.startsWith(`${path} -avd ${avd} -port ${port} `))
  if (!args || !expectedExecutable || !state.processStart || started !== state.processStart) {
    throw new Error('模拟器进程归属无法核对，不会关闭其他进程')
  }
  await device(tools, serial, ['emu', 'kill'])
  console.log('已关闭预览模拟器，App 数据保留。')
}

async function executeOptions(options) {
  const tools = await toolchain({ flutter: options.command === 'build' || options.command === 'dev' || options.rebuild })
  if (options.command === 'status') {
    const serial = await currentDevice(tools)
    const info = await stat(options.apk).catch(() => null)
    console.log(`模拟器：${serial || '未运行'}\n现有 APK：${info ? `${(info.size / 1024 ** 2).toFixed(0)} MiB，${info.mtime.toLocaleString()}` : '不存在'}\n剩余空间：${((await availableBytes()) / gib).toFixed(1)} GiB\n日志与单张截图：.work/app-preview/\n默认启动不编译、不下载、不创建模拟器。`)
    return
  }
  if (options.command === 'stop') return stop(tools)
  if (options.command === 'build') return build(tools, options.online)
  if (options.command === 'screenshot') {
    const serial = await currentDevice(tools)
    if (!serial) throw new Error('请先启动预览')
    await mkdir(work, { recursive: true })
    const { stdout } = await exec(tools.adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })
    await writeFile(join(work, 'screenshot.png'), stdout)
    console.log('截图已覆盖保存至 .work/app-preview/screenshot.png')
    return
  }
  checkSpace(await availableBytes())
  if (options.rebuild) await build(tools, options.online)
  await checkApk(tools, options.apk)
  const serial = await ensureEmulator(tools)
  const saved = await readState('installed.json')
  const result = await installPackage({ apk: options.apk, serial, saved, invoke: (args, config) => device(tools, serial, args, config) })
  await saveState('installed.json', result)
  console.log(result.skipped ? '已是同一安装包，跳过重复安装。' : '安装完成，保留已有 App 数据。')
  await launch(tools, serial)
  console.log('真实 Companion App 已打开。首次使用请在预览窗口配对；以后复用该模拟器内的数据。')
  if (options.command === 'dev') await attach(tools, serial)
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (options.command === 'help') { console.log(usage); return }
  if (['status', 'screenshot'].includes(options.command)) return executeOptions(options)
  return withPreviewLock(work, () => executeOptions(options))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`预览失败：${error.message}`); process.exitCode = 1 })
}
