import { spawnSync } from 'node:child_process';

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture
      ? `\n${result.stdout ?? ''}${result.stderr ?? ''}`
      : '';
    throw new Error(`${command} exited with ${result.status}.${detail}`);
  }
  return result;
}

export function runPnpm(args, options = {}) {
  const pnpmPath = process.env.npm_execpath;
  if (pnpmPath) {
    return run(process.execPath, [pnpmPath, ...args], options);
  }
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, options);
}
