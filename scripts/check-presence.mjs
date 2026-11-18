import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

function loadSourceCjs(relativePath, bindings, names) {
  const source = stripTypeScriptTypes(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
    .replace(/^import\s[\s\S]*?\sfrom\s['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export /gm, '')
  return new Function(...Object.keys(bindings), `${source}\nreturn {${names.join(',')}}`)(
    ...Object.values(bindings)
  )
}

async function loadSource(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  const typeOnly = source.replace(/import type \{[^}]*\} from '[^']*'/g, '')
  return import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(typeOnly)).toString('base64')}`
  )
}

const presence = await loadSource('../src/shared/presence.ts')
const foreground = await loadSource('../src/main/foreground.ts')

test('fresh install defaults launchAtLogin to true and preserves explicit opt-out', async () => {
  const sections = loadSourceCjs('../src/shared/sections.ts', {}, ['normalizeSectionPrefs', 'sectionsEqual'])
  const constants = loadSourceCjs('../src/shared/types.ts', {}, ['WATER_GLASS_ML', 'WATER_GOAL_MAX', 'WATER_GOAL_MIN'])
  const makeStore = (savedJson) => {
    const file = path.join('fixture', 'notch-state.json')
    const files = new Map()
    if (savedJson !== undefined) files.set(file, savedJson)
    const fsStub = {
      readFile: async (name) => {
        if (!files.has(name)) throw new Error('ENOENT')
        return files.get(name)
      },
      mkdir: async () => {},
      writeFile: async (name, value) => {
        files.set(name, value)
      },
      rename: async (from, to) => {
        files.set(to, files.get(from))
        files.delete(from)
      },
      unlink: async (name) => {
        files.delete(name)
      }
    }
    return loadSourceCjs(
      '../src/main/state.ts',
      {
        ...sections,
        ...constants,
        EventEmitter,
        path,
        fs: fsStub,
        app: { getPath: () => 'fixture' },
        process: { env: {} },
        setTimeout: () => 1,
        clearTimeout: () => {},
        mkdirSync: () => {},
        writeFileSync: (name, value) => {
          files.set(name, value)
        }
      },
      ['initState']
    )
  }

  const fresh = await makeStore().initState()
  assert.equal(fresh.settings.launchAtLogin, true)

  const optedOut = await makeStore(JSON.stringify({ settings: { launchAtLogin: false } })).initState()
  assert.equal(optedOut.settings.launchAtLogin, false)
})

test('shouldAutoHide respects hardening settings and explicitOpen override', () => {
  const fsSample = { process: 'vlc', fullscreen: true, own: false, browserOpen: false }
  const normalSample = { process: 'Code', fullscreen: false, own: false, browserOpen: false }
  const ownFsSample = { process: 'electron', fullscreen: true, own: true, browserOpen: false }

  assert.equal(presence.shouldAutoHide(fsSample, { autoHideFullscreen: true }), true)
  assert.equal(presence.shouldAutoHide(fsSample, { autoHideFullscreen: true }, true), false)
  assert.equal(presence.shouldAutoHide(fsSample, { autoHideFullscreen: false }), false)
  assert.equal(presence.shouldAutoHide(ownFsSample, { autoHideFullscreen: true }), false)

  assert.equal(presence.shouldAutoHide(normalSample, { browserOnly: true, autoHideFullscreen: true }), true)
  assert.equal(presence.shouldAutoHide(normalSample, { browserOnly: true, autoHideFullscreen: true }, true), false)

  assert.equal(
    presence.shouldAutoHide(normalSample, { neverOver: ['code.exe'], autoHideFullscreen: false }),
    true
  )
})

test('Windows foreground watcher ignores full-screen-sized desktop windows and catches true fullscreen', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notch-fore-'))
  try {
    const rawScript = foreground.buildScript({ width: 1920, height: 1080 }, false)
    const setupOnly = rawScript.replace(/\[NotchFore\]::Configure[\s\S]*/, '')
    const harnessPs1 = path.join(dir, 'sample-stdin.ps1')
    writeFileSync(
      harnessPs1,
      setupOnly +
        '\n$cfg = [Console]::In.ReadLine()\n$parts = $cfg.Split(",")\n[NotchFore]::Configure([int]$parts[0], [int]$parts[1], $true, [int]$parts[2], [int]$parts[3], 999999)\n[NotchFore]::SetBrowsers(@())\n[Console]::Out.WriteLine("READY")\n[Console]::Out.Flush()\nwhile ($null -ne ($cmd = [Console]::In.ReadLine())) { [Console]::Out.WriteLine([NotchFore]::SampleWindow([IntPtr]::new([long]$cmd))); [Console]::Out.Flush() }\n',
      'utf8'
    )

    const resultFile = path.join(dir, 'results.json')
    const electronEntry = path.join(dir, 'driver.cjs')
    writeFileSync(
      electronEntry,
      `
const { app, BrowserWindow, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  const scale = display.scaleFactor || 1;
  const cx = Math.round((x + width / 2) * scale);
  const cy = Math.round((y + height / 2) * scale);

  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${JSON.stringify(harnessPs1)}], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buf = '';
  const waiters = [];
  let psErr = '';
  ps.stderr.on('data', d => { psErr += d.toString(); });
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', chunk => {
    buf += chunk;
    let idx = buf.indexOf('\\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (waiters.length) waiters.shift()(line);
      idx = buf.indexOf('\\n');
    }
  });
  const nextLine = () => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('PS timeout: ' + psErr)), 8000);
    waiters.push(l => { clearTimeout(t); res(l); });
  });
  ps.stdin.write(Math.round(width * scale) + ',' + Math.round(height * scale) + ',' + cx + ',' + cy + '\\n');
  const ready = await nextLine();
  if (ready !== 'READY') throw new Error('Expected READY, got ' + ready + ' err=' + psErr);

  const hwndOf = (win) => {
    const buf = win.getNativeWindowHandle();
    return (buf.readBigUInt64LE ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString();
  };

  const sampleNow = async (win) => {
    ps.stdin.write(hwndOf(win) + '\\n');
    return JSON.parse(await nextLine());
  };

  const w1 = new BrowserWindow({ x, y, width, height, frame: true, show: true });
  await new Promise(r => setTimeout(r, 350));
  const framedRestored = await sampleNow(w1);

  w1.maximize();
  await new Promise(r => setTimeout(r, 300));
  const framedMaximized = await sampleNow(w1);

  w1.unmaximize();
  await new Promise(r => setTimeout(r, 200));
  w1.setFullScreen(true);
  await new Promise(r => setTimeout(r, 400));
  const framedFullscreen = await sampleNow(w1);

  const w2 = new BrowserWindow({ x, y, width, height, frame: false, show: true });
  await new Promise(r => setTimeout(r, 350));
  const framelessRestored = await sampleNow(w2);

  w2.setFullScreen(true);
  await new Promise(r => setTimeout(r, 400));
  const framelessFullscreen = await sampleNow(w2);

  w2.minimize();
  await new Promise(r => setTimeout(r, 300));
  const minimized = await sampleNow(w2);

  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
    bounds: display.bounds,
    scale,
    cx,
    cy,
    framedRestored,
    framedMaximized,
    framedFullscreen,
    framelessRestored,
    framelessFullscreen,
    minimized
  }, null, 2));

  ps.kill();
  w1.destroy();
  w2.destroy();
  app.quit();
}).catch(err => {
  fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ error: String(err && err.stack || err) }));
  app.quit();
});
`,
      'utf8'
    )

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electronExe = path.resolve('node_modules/electron/dist/electron.exe')
    const ud = path.join(dir, 'ud')
    execFileSync(electronExe, [electronEntry, `--user-data-dir=${ud}`], { env, timeout: 25000 })

    const out = JSON.parse(readFileSync(resultFile, 'utf8'))
    const detail = JSON.stringify(out)
    assert.equal(out.error, undefined, out.error)
    assert.equal(out.framedRestored.fullscreen, false, 'framed window filling screen without maximize must NOT be treated as fullscreen: ' + detail)
    assert.equal(out.framedMaximized.fullscreen, false, 'maximized framed window must NOT be fullscreen: ' + detail)
    assert.equal(out.framelessRestored.fullscreen, false, 'custom-chrome frameless window filling screen without maximize must NOT be fullscreen: ' + detail)
    assert.equal(out.framedFullscreen.fullscreen, true, 'real framed fullscreen window MUST trigger auto-hide: ' + detail)
    assert.equal(out.framelessFullscreen.fullscreen, true, 'real frameless fullscreen window MUST trigger auto-hide: ' + detail)
    assert.equal(out.minimized.fullscreen, false, 'minimized window must NOT be fullscreen: ' + detail)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
