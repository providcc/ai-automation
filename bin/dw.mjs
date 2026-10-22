#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../packages/dw-cli/src/index.ts', import.meta.url));
const child = spawn(process.execPath, ['--experimental-strip-types', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
// 没有 error 处理的话，spawn 失败（入口文件缺失、node 起不来）只会发 'error' 不发 'exit'，
// 进程会**静默挂住**而不是报错退出——CI 里表现为卡死，比报错难查得多。
child.on('error', (err) => {
  console.error(`✖ 启动失败：${err.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
