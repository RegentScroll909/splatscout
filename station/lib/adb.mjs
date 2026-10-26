// Android phone over USB: lists the SplatScout ZIPs in the phone's Download folder and pulls the
// ones you choose into the inbox (or every new one, when automatic import is switched on).

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { capture } from './run.mjs';
import { listZip } from './zipread.mjs';

const EXPORT_NAME = /^[\w.-]+_\d{8}(?: ?\(\d+\))?\.zip$/; // Building_Room_YYYYMMDD.zip (Chrome adds " (1)" for duplicates)

export class PhoneImporter {
  /**
   * @param cfg station config (tools.adb, adbAutoImport = watch for a phone, phoneAutoImport = pull new exports by itself)
   * @param onImported (file) a ZIP arrived in the inbox
   * @param say (text) activity log
   * @param onChange () the phone or its file list changed
   */
  constructor(cfg, onImported, say, onChange = () => {}) {
    this.cfg = cfg;
    this.onImported = onImported;
    this.say = say;
    this.onChange = onChange;
    this.stateFile = join(cfg.workDir, 'phone-imports.json');
    this.seen = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {};
    this.status = { connected: false, device: null, serial: null, lastCheck: null, error: null, files: [], pulling: null };
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
    const before = JSON.stringify([this.status.connected, this.status.files]);
    try {
      const { stdout } = await capture(adb, ['devices', '-l']);
      const line = stdout.split('\n').find((l) => /\sdevice\s/.test(l) || /\sdevice$/.test(l.trim()));
      this.status.lastCheck = Date.now();
      if (!line) {
        Object.assign(this.status, { connected: false, device: null, serial: null, files: [] });
        return;
      }
      const serial = line.trim().split(/\s+/)[0];
      const model = (/model:(\S+)/.exec(line) || [])[1] || serial;
      Object.assign(this.status, { connected: true, serial, device: model.replace(/_/g, ' ') });
      const { stdout: ls } = await capture(adb, ['-s', serial, 'shell', 'ls', '-l', '/sdcard/Download/']);
      const files = [];
      for (const row of ls.split('\n')) {
        const m = /\s(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+\.zip)\s*$/.exec(row);
        if (!m) continue;
        const size = +m[1], name = m[4].trim();
        if (!EXPORT_NAME.test(name)) continue;
        const key = `${serial}:${name}:${size}`;
        const seen = this.seen[key];
        files.push({ name, size, date: `${m[2]} ${m[3]}`, key, imported: !!(seen && seen.imported), importedAt: seen ? seen.at : null });
      }
      files.sort((a, b) => (a.date < b.date ? 1 : -1));
      this.status.files = files;
      this.status.error = null;
      if (this.cfg.phoneAutoImport) {
        for (const f of files) if (!this.seen[f.key]) await this._pull(serial, f);
      }
    } catch (e) {
      this.status.error = (e.stderr || e.message || String(e)).toString().split('\n')[0];
    } finally {
      this.busy = false;
      if (JSON.stringify([this.status.connected, this.status.files]) !== before) this.onChange();
    }
  }

  /** Pull the chosen exports (by file name) into the inbox. */
  async importFiles(names) {
    const serial = this.status.serial;
    if (!serial) throw new Error('No phone connected');
    for (let tries = 0; this.busy && tries < 100; tries++) await new Promise((r) => setTimeout(r, 200));
    this.busy = true;
    let n = 0;
    try {
      for (const name of names) {
        const f = this.status.files.find((x) => x.name === name);
        if (f && (await this._pull(serial, f))) n++;
      }
    } finally {
      this.busy = false;
      this.onChange();
    }
    return n;
  }

  async _pull(serial, f) {
    const adb = this.cfg.tools.adb;
    const tmp = join(this.cfg.dirs.inbox, '.pulling-' + f.name);
    this.status.pulling = f.name;
    this.onChange();
    this.say(`Copying ${f.name} from ${this.status.device}…`);
    try {
      await capture(adb, ['-s', serial, 'pull', `/sdcard/Download/${f.name}`, tmp]);
    } finally {
      this.status.pulling = null;
    }
    let ok = false;
    try {
      ok = (await listZip(tmp)).some((e) => e.name.endsWith('splatscout.json'));
    } catch {}
    this.seen[f.key] = { at: Date.now(), imported: ok };
    writeFileSync(this.stateFile, JSON.stringify(this.seen, null, 1));
    f.imported = ok;
    f.importedAt = Date.now();
    if (!ok) {
      rmSync(tmp, { force: true });
      this.say(`${f.name} is not a SplatScout export; skipped.`);
      return false;
    }
    const dest = join(this.cfg.dirs.inbox, f.name.replace(/ \((\d+)\)\.zip$/, '_$1.zip'));
    renameSync(tmp, dest);
    this.say(`Imported ${f.name} from the phone.`);
    if (this.onImported) this.onImported(dest);
    return true;
  }
}
