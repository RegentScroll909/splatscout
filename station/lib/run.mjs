// Run external tools with live line output, log files and cancellation.

import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname } from 'node:path';

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

/**
 * Run a command. Resolves with {code, tail} or rejects on non-zero exit.
 * @param {string} cmd executable path
 * @param {string[]} args
 * @param {object} o
 * @param {string} [o.log] log file path (appended)
 * @param {(line:string)=>void} [o.onLine]
 * @param {{cancelled:boolean, child?:any}} [o.token] cancellation token
 * @param {object} [o.env] extra environment
 * @param {string} [o.cwd]
 */
export function run(cmd, args, { log, onLine, token, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (token && token.cancelled) return reject(new Cancelled());
    const extraEnv = { ...process.env, ...env };
    // COLMAP's Qt plugins live next to its bin folder.
    if (/colmap/i.test(cmd)) extraEnv.QT_PLUGIN_PATH = dirname(dirname(cmd)) + '\\plugins';
    const child = spawn(cmd, args, { cwd, env: extraEnv, windowsHide: true });
    if (token) token.child = child;
    const out = log ? createWriteStream(log, { flags: 'a' }) : null;
    if (out) out.write(`\n$ ${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`);
    const tail = [];
    let buf = '';
    const feed = (chunk) => {
      const s = chunk.toString();
      if (out) out.write(s);
      buf += s;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 60) tail.shift();
        if (onLine) {
          try {
            onLine(line);
          } catch {}
        }
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => {
      if (out) out.end();
      reject(e);
    });
    child.on('close', (code) => {
      if (buf.trim()) feed('\n');
      if (out) out.end();
      if (token) token.child = null;
      if (token && token.cancelled) return reject(new Cancelled());
      if (code === 0) resolve({ code, tail });
      else {
        const err = new Error(`${cmd.split(/[\\/]/).pop()} exited with code ${code}:\n${tail.slice(-12).join('\n')}`);
        err.tail = tail;
        reject(err);
      }
    });
  });
}

/** Run and capture stdout (small outputs). */
export function capture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout, stderr });
    });
  });
}

/** Kill a running child and everything it started. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
    execFile(taskkill, ['/pid', String(child.pid), '/T', '/F'], () => {});
  } else {
    child.kill('SIGKILL');
  }
}
