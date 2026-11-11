// SplatStation's own state files (the job list): written so a PC that stops mid-write can't spoil them.

import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync } from 'node:fs';

/**
 * Write a file so that a PC that stops part way (a crash, a power cut) leaves either the old file or the new
 * one, never half of one: the text goes into a file beside it, is flushed to the disk, and then takes the name.
 * The job list is rewritten every couple of seconds while a job runs, which is when PCs stop.
 */
export function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch {
    // (Something holding the file open, a disk that can't rename over it: the plain way still saves it.)
    writeFileSync(file, text);
  }
}

/**
 * A saved list (jobs.json), or an empty one when the file can't be read: it's then kept aside under another
 * name, and `onBad(error, keptAs)` says so, rather than SplatStation refusing to start.
 * @returns {Array}
 */
export function readList(file, onBad = () => {}) {
  if (!existsSync(file)) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('it isn’t a list');
    return list;
  } catch (e) {
    const aside = `${file}.unreadable-${Date.now()}`;
    let kept = null;
    try {
      renameSync(file, aside);
      kept = aside;
    } catch {}
    onBad(e, kept);
    return [];
  }
}
