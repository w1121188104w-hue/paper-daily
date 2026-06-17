import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function appleString(value) {
  return JSON.stringify(String(value || ''));
}

export async function sendDesktopNotification(title, message) {
  if (process.env.ENABLE_DESKTOP_NOTIFICATIONS === 'false') return false;
  if (process.platform !== 'darwin') return false;

  try {
    await execFileAsync('/usr/bin/osascript', [
      '-e',
      `display notification ${appleString(message)} with title ${appleString(title)}`
    ]);
    return true;
  } catch (error) {
    console.warn('[notify] desktop notification skipped:', String(error?.message || error));
    return false;
  }
}
