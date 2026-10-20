// Auto-import from a USB-connected Android phone: new SplatScout ZIPs in the phone's Download
// folder are pulled into the inbox. Only files that look like SplatScout exports are copied.

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { capture } from './run.mjs';
import { listZip } from './zipread.mjs';

const EXPORT_NAME = /^[\w.-]+_\d{8}(?: ?\(\d+\))?\.zip$/; // Building_Room_YYYYMMDD.zip (Chrome adds " (1)" for duplicates)

export class PhoneImporter {
  constructor(cfg, onImported, say) {
    this.cfg = cfg;
    this.onImported = onImported;
    this.say = say;
    this.stateFile = join(cfg.workDir, 'phone-imports.json');
    this.seen = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {};
    this.status = { connected: false, device: null, lastCheck: null, error: null };
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => this.check().catch(() => {}), 8000);
    this.check().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
  }

  async check() {
    const adb = this.cfg.tools.adb;
    if (!adb || !this.cfg.adbAutoImport || this.busy) return;
    this.busy = true;
    try {
      const { stdout } = await capture(adb, ['devices', '-l']);
      const line = stdout.split('\n').find((l) => /\sdevice\s/.test(l) || /\sdevice$/.test(l.trim()));
      this.status.lastCheck = Date.now();
      if (!line) {
        this.status.connected = false;
        this.status.device = null;
        return;
      }
      const serial = line.trim().split(/\s+/)[0];
      const model = (/model:(\S+)/.exec(line) || [])[1] || serial;
      this.status.connected = true;
      this.status.device = model.replace(/_/g, ' ');
      const { stdout: ls } = await capture(adb, ['-s', serial, 'shell', 'ls', '-l', '/sdcard/Download/']);
      for (const row of ls.split('\n')) {
        const m = /\s(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+\.zip)\s*$/.exec(row);
        if (!m) continue;
        const size = +m[1], name = m[2].trim();
        if (!EXPORT_NAME.test(name)) continue;
        const key = `${serial}:${name}:${size}`;
        if (this.seen[key]) continue;
        const tmp = join(this.cfg.dirs.inbox, '.pulling-' + name);
        this.say(`Pulling ${name} from ${this.status.device}…`);
        await capture(adb, ['-s', serial, 'pull', `/sdcard/Download/${name}`, tmp]);
        let ok = false;
        try {
          ok = (await listZip(tmp)).some((e) => e.name.endsWith('splatscout.json'));
        } catch {}
        this.seen[key] = { at: Date.now(), imported: ok };
        writeFileSync(this.stateFile, JSON.stringify(this.seen, null, 1));
        if (ok) {
          const dest = join(this.cfg.dirs.inbox, name.replace(/ \((\d+)\)\.zip$/, '_$1.zip'));
          renameSync(tmp, dest);
          this.say(`Imported ${name} from the phone.`);
          if (this.onImported) this.onImported(dest);
        } else {
          rmSync(tmp, { force: true });
        }
      }
      this.status.error = null;
    } catch (e) {
      this.status.error = (e.stderr || e.message || String(e)).toString().split('\n')[0];
    } finally {
      this.busy = false;
    }
  }
}
