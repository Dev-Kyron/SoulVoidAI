/**
 * System telemetry for the HUD. The fast counters (CPU / RAM / uptime) are
 * read from the `os` module on every call. The slower hardware probes (disk,
 * GPU, temperature, battery) are gathered by `systeminformation` on a
 * background timer and cached, so the IPC call never blocks on a process spawn.
 */
import os from 'node:os'
import si from 'systeminformation'
import type { SystemStats } from '@shared/types'

interface CpuSample {
  idle: number
  total: number
}

function sampleCpu(): CpuSample {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value
    idle += cpu.times.idle
  }
  return { idle, total }
}

let previous = sampleCpu()

type SlowStats = Pick<SystemStats, 'disk' | 'gpu' | 'cpuTemp' | 'battery'>

let slow: SlowStats = { disk: null, gpu: null, cpuTemp: null, battery: null }
let started = false

async function refreshSlow(): Promise<void> {
  const [fsRes, gfxRes, tempRes, batRes] = await Promise.allSettled([
    si.fsSize(),
    si.graphics(),
    si.cpuTemperature(),
    si.battery()
  ])

  if (fsRes.status === 'fulfilled') {
    const homeDrive = process.platform === 'win32' ? os.homedir().slice(0, 2).toUpperCase() : '/'
    const mounts = fsRes.value
    const target =
      mounts.find((m) => m.mount.toUpperCase() === homeDrive) ??
      mounts.find((m) => m.mount === '/') ??
      mounts[0]
    slow.disk =
      target && target.size > 0
        ? {
            used: target.used,
            total: target.size,
            percent: Math.round((target.used / target.size) * 100)
          }
        : null
  }

  if (gfxRes.status === 'fulfilled') {
    const controllers = gfxRes.value.controllers ?? []
    if (controllers.length === 0) {
      slow.gpu = null
    } else {
      // The discrete GPU is the controller with the most dedicated VRAM.
      const best = controllers.reduce((a, b) => ((b.vram ?? 0) > (a.vram ?? 0) ? b : a))
      const load = typeof best.utilizationGpu === 'number' ? Math.round(best.utilizationGpu) : null
      const temp =
        typeof best.temperatureGpu === 'number' && best.temperatureGpu > 0
          ? Math.round(best.temperatureGpu)
          : null
      slow.gpu = { model: best.model || 'GPU', load, temp }
    }
  }

  if (tempRes.status === 'fulfilled') {
    const main = tempRes.value.main
    slow.cpuTemp = typeof main === 'number' && main > 0 ? Math.round(main) : null
  }

  if (batRes.status === 'fulfilled') {
    const bat = batRes.value
    slow.battery = bat.hasBattery
      ? { percent: Math.round(bat.percent), charging: bat.isCharging }
      : null
  }
}

function ensureStarted(): void {
  if (started) return
  started = true
  void refreshSlow()
  const timer = setInterval(() => void refreshSlow(), 6000)
  timer.unref()
}

export function getSystemStats(): SystemStats {
  ensureStarted()

  const current = sampleCpu()
  const idleDelta = current.idle - previous.idle
  const totalDelta = current.total - previous.total
  previous = current

  const cpu = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0

  const memTotal = os.totalmem()
  const memFree = os.freemem()
  const memUsed = memTotal - memFree

  return {
    cpu: Math.min(100, Math.max(0, cpu)),
    memUsed,
    memTotal,
    memPercent: Math.round((memUsed / memTotal) * 100),
    uptime: Math.round(os.uptime()),
    hostname: os.hostname(),
    ...slow
  }
}
