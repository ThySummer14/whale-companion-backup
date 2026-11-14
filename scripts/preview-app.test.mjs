import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkSpace, installPackage, installTimes, javaPropertiesPath, parseDevices, parseDnsServers, parseOptions, parseVmService, selectDevice, withPreviewLock } from './preview-app.mjs'

const gib = 1024 ** 3

test('preview defaults to the existing package without a build or download', () => {
  assert.deepEqual({ ...parseOptions([]), apk: 'existing' }, { command: 'start', rebuild: false, online: false, apk: 'existing' })
  assert.equal(parseOptions(['--', 'dev']).command, 'dev')
  assert.equal(parseOptions(['start', '--rebuild', '--online']).rebuild, true)
  assert.equal(parseOptions(['build', '--online']).online, true)
  for (const args of [['--online'], ['--apk'], ['--wipe-data'], ['stop', '--rebuild'], ['dev', 'stop']]) {
    assert.throws(() => parseOptions(args))
  }
})

test('only exact matching emulator names can be selected; physical devices are ignored', async () => {
  const devices = 'List of devices attached\nphone-serial\tdevice\nemulator-5554\tdevice\nemulator-5580\tdevice\nemulator-5582\toffline\n'
  assert.equal(parseDevices(devices).length, 3)
  const queried = []
  assert.equal(await selectDevice(devices, async serial => {
    queried.push(serial)
    return serial === 'emulator-5580' ? 'companion-android' : 'KuangyeQA'
  }), 'emulator-5580')
  assert.deepEqual(queried, ['emulator-5554', 'emulator-5580'])
  await assert.rejects(selectDevice(devices, async () => 'companion-android'), /多个/u)
  assert.equal(await selectDevice('phone-serial\tdevice', async () => 'companion-android'), undefined)
})

test('emulator DNS preserves the Mac split-DNS order instead of using public DNS alone', () => {
  const text = `DNS configuration
resolver #1
  nameserver[0] : 100.100.100.100
  nameserver[1] : fd7a:115c:a1e0::53
resolver #2
  nameserver[0] : 8.8.8.8
DNS configuration (for scoped queries)
resolver #1
  nameserver[0] : 8.8.8.8
`;
  assert.deepEqual(parseDnsServers(text), ['100.100.100.100', '8.8.8.8'])
  assert.deepEqual(parseDnsServers('resolver #1\n  nameserver[0] : 192.168.1.1'), ['192.168.1.1'])
  assert.deepEqual(parseDnsServers('No DNS configuration available'), [])
})

test('preview and explicit builds enforce separate free-space floors', () => {
  assert.throws(() => checkSpace(3.9 * gib), /至少预留 4/u)
  assert.throws(() => checkSpace(11.9 * gib, true), /至少预留 12/u)
  checkSpace(4 * gib)
  checkSpace(12 * gib, true)
})

test('Java properties keep Chinese SDK paths readable to Gradle', () => {
  assert.equal(javaPropertiesPath('/Users/example/工作流/flutter'), '/Users/example/\\u5de5\\u4f5c\\u6d41/flutter')
  assert.equal(javaPropertiesPath('/tmp/sdk'), '/tmp/sdk')
})

const before = 'firstInstallTime=2026-11-14 10:00:00\nlastUpdateTime=2026-11-14 11:00:00'
const after = 'firstInstallTime=2026-11-14 10:00:00\nlastUpdateTime=2026-11-14 12:00:00'

async function packageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'companion-preview-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const apk = join(root, 'app.apk')
  await writeFile(apk, 'bounded fixture')
  return apk
}

test('installs use replace-only and repeated unchanged packages do not reinstall', async t => {
  const apk = await packageFixture(t)
  const calls = []
  let installed = false
  const invoke = async args => {
    calls.push(args)
    if (args[0] === 'install') { installed = true; return 'Success' }
    return installed ? after : before
  }
  const saved = await installPackage({ apk, serial: 'emulator-5580', invoke })
  assert.deepEqual(calls[1], ['install', '-r', apk])
  assert.equal(saved.firstInstallTime, installTimes(before).firstInstallTime)
  calls.length = 0
  assert.equal((await installPackage({ apk, serial: 'emulator-5580', invoke, saved })).skipped, true)
  assert.equal(calls.length, 1)
})

test('failed install never uninstalls, wipes, downgrades or falls through', async t => {
  const apk = await packageFixture(t)
  const calls = []
  await assert.rejects(installPackage({ apk, serial: 'emulator-5580', invoke: async args => {
    calls.push(args)
    if (args[0] === 'install') throw new Error('INSTALL_FAILED_UPDATE_INCOMPATIBLE')
    return before
  } }), /INSTALL_FAILED_UPDATE_INCOMPATIBLE/u)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], ['install', '-r', apk])
})

test('preview operations serialize and release their lock after failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-preview-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await withPreviewLock(directory, async () => {
    await assert.rejects(withPreviewLock(directory, () => assert.fail('concurrent operation')), /另一项预览操作/u)
  })
  await assert.rejects(withPreviewLock(directory, async () => { throw new Error('failed operation') }), /failed operation/u)
  await withPreviewLock(directory, async () => {})
})

test('attach accepts only the current process loopback VM service and selects the latest announcement', () => {
  assert.deepEqual(parseVmService('The Dart VM service is listening on http://127.0.0.1:12345/abc=/'), { port: '12345', pathname: '/abc=/' })
  assert.deepEqual(parseVmService('The Dart VM service is listening on http://127.0.0.1:12345/old=/\nThe Dart VM service is listening on http://127.0.0.1:54321/new=/'), { port: '54321', pathname: '/new=/' })
  assert.equal(parseVmService('http://outside.example:12345/abc=/'), undefined)
})

test('a changed first install time stops subsequent launch', async t => {
  const apk = await packageFixture(t)
  let queried = false
  await assert.rejects(installPackage({ apk, serial: 'emulator-5580', invoke: async args => {
    if (args[0] === 'install') return 'Success'
    if (queried) return after.replace('10:00:00', '12:00:00')
    queried = true
    return before
  } }), /安装时间发生异常/u)
})
