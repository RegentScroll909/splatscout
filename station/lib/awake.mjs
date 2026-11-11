// Keeps the PC awake while SplatStation works. Windows goes to sleep on its idle timer whatever the PC is doing:
// a PC left to process a scan went to sleep 12 minutes in, and the job stood still until someone woke it.
//
// Windows only lets a running thread ask to stay awake (SetThreadExecutionState), so a small PowerShell helper
// holds the request while there's work, and is ended when the queue is empty. The helper also ends by itself
// when SplatStation does, so the PC is never kept awake by a station that has gone. The screen may still turn
// off; only sleep is held back. On other systems this does nothing.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held until the helper's thread ends. It prints "awake" once it's in force,
// then waits for SplatStation's own process to end.
const script = (pid) => [
  "$k = Add-Type -PassThru -Namespace SplatStation -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
  'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }',
  "Write-Output 'awake'",
  `try { Wait-Process -Id ${pid} -ErrorAction Stop } catch {}`,
].join('\n');

let helper = null; // {child, ready: Promise<boolean>}

/**
 * Hold the PC awake (on) or let it sleep again (off). Asking twice for the same thing does nothing.
 * @param {boolean} on
 * @param {{pid?: number}} [o] the process whose end releases the PC (this one)
 * @returns {Promise<boolean>} whether the PC is now being held awake
 */
export function keepAwake(on, { pid = process.pid } = {}) {
  if (!on) {
    if (helper) {
      try {
        helper.child.kill();
      } catch {}
      helper = null;
    }
    return Promise.resolve(false);
  }
  if (helper) return helper.ready;
  if (process.platform !== 'win32') return Promise.resolve(false);
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(exe)) return Promise.resolve(false);
  let child;
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script(pid), 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return Promise.resolve(false);
  }
  const mine = { child, ready: null };
  mine.ready = new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (/awake/.test(out)) resolve(true);
    });
    const gone = () => {
      if (helper === mine) helper = null;
      resolve(false);
    };
    child.on('error', gone);
    child.on('exit', gone);
  });
  helper = mine;
  return mine.ready;
}

/** Whether a request to stay awake is being held right now. */
export const heldAwake = () => !!helper;
