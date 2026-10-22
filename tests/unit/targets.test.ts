/**
 * 多目标寻址单测：RC_TARGETS / rc.targets.json / 默认解析 / 网络域提示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadTargets, resolveTarget, networkHint } from '../../packages/core/src/targets.ts';
import { tmpDir, withEnv } from './helpers.ts';

test('RC_TARGETS：JSON 数组与 {targets:[...]} 都可解析', async () => {
  await withEnv({ RC_TARGETS: JSON.stringify([{ name: 'a', baseUrl: 'https://a.test', role: 'dev' }]) }, () => {
    const t = loadTargets();
    assert.equal(Array.isArray(t), true);
    assert.equal(t.length, 1);
    assert.equal(t[0].name, 'a');
  });

  await withEnv({ RC_TARGETS: JSON.stringify({ targets: [{ name: 'b', baseUrl: 'https://b.test', role: 'uat' }] }) }, () => {
    const t = loadTargets();
    assert.equal(t.length, 1);
    assert.equal(t[0].name, 'b');
  });
});

test('RC_TARGETS：非法 JSON 明确报错', async () => {
  await withEnv({ RC_TARGETS: '{not json' }, () => {
    assert.throws(() => loadTargets(), /RC_TARGETS 不是合法 JSON/);
  });
});

test('RC_TARGETS：合法 JSON 但形状不对时明确报错', async () => {
  await withEnv({ RC_TARGETS: '42' }, () => {
    assert.throws(() => loadTargets(), /RC_TARGETS 需要是数组或 \{ targets: \[\.\.\.\] \}/);
  });
});

test('配置文件：rc.targets.json 支持数组与 {targets:[...]}', async () => {
  const dir = tmpDir('rc-targets-');
  try {
    const file = join(dir.dir, 'rc.targets.json');
    writeFileSync(file, JSON.stringify([{ name: 'dev', baseUrl: 'https://dev.test', role: 'dev' }]), 'utf8');
    const t = loadTargets({ file });
    assert.equal(t.length, 1);
    assert.equal(t[0].baseUrl, 'https://dev.test');

    const file2 = join(dir.dir, 'rc.targets2.json');
    writeFileSync(file2, JSON.stringify({ targets: [{ name: 'prod', baseUrl: 'https://prod.test', role: 'prod' }] }), 'utf8');
    const t2 = loadTargets({ file: file2 });
    assert.equal(t2.length, 1);
    assert.equal(t2[0].name, 'prod');
  } finally {
    dir.cleanup();
  }
});

test('配置文件不存在时返回空列表', async () => {
  const dir = tmpDir('rc-targets-');
  try {
    assert.deepEqual(loadTargets({ file: join(dir.dir, 'missing.json') }), []);
  } finally {
    dir.cleanup();
  }
});

test('默认配置文件：读取 cwd 下的 rc.targets.json（不存在则为空）', async () => {
  await withEnv({ RC_TARGETS: undefined }, () => {
    const t = loadTargets();
    assert.equal(Array.isArray(t), true);
    const cwdFile = resolve(process.cwd(), 'rc.targets.json');
    if (existsSync(cwdFile)) {
      assert.ok(t.length >= 1);
    } else {
      assert.deepEqual(t, []);
    }
  });
});

test('resolveTarget：默认 target 优先，其次第一个', async () => {
  const dir = tmpDir('rc-targets-');
  try {
    const file = join(dir.dir, 'rc.targets.json');
    writeFileSync(file, JSON.stringify([
      { name: 'first', baseUrl: 'https://first.test', role: 'dev' },
      { name: 'def', baseUrl: 'https://def.test', role: 'uat', default: true },
    ]), 'utf8');
    assert.equal(resolveTarget(undefined, { file }).name, 'def');
    assert.equal(resolveTarget('first', { file }).name, 'first');
  } finally {
    dir.cleanup();
  }
});

test('resolveTarget：无 default 时取第一个', async () => {
  const dir = tmpDir('rc-targets-');
  try {
    const file = join(dir.dir, 'rc.targets.json');
    writeFileSync(file, JSON.stringify([
      { name: 'first', baseUrl: 'https://first.test', role: 'dev' },
      { name: 'second', baseUrl: 'https://second.test', role: 'uat' },
    ]), 'utf8');
    assert.equal(resolveTarget(undefined, { file }).name, 'first');
  } finally {
    dir.cleanup();
  }
});

test('resolveTarget：没有可用配置时给出占位 target', async () => {
  const dir = tmpDir('rc-targets-');
  try {
    const t = resolveTarget(undefined, { file: join(dir.dir, 'missing.json') });
    assert.deepEqual(t, { name: 'default', baseUrl: '', role: 'custom' });
  } finally {
    dir.cleanup();
  }
});

test('resolveTarget：未知名称报错并列出可选值', async () => {
  const dir = tmpDir('rc-targets-');
  try {
    const file = join(dir.dir, 'rc.targets.json');
    writeFileSync(file, JSON.stringify([
      { name: 'a', baseUrl: 'https://a.test', role: 'dev' },
      { name: 'b', baseUrl: 'https://b.test', role: 'uat' },
    ]), 'utf8');
    assert.throws(() => resolveTarget('zzz', { file }), /未知 target：zzz（可选：a, b）/);
    assert.throws(
      () => resolveTarget('zzz', { file: join(dir.dir, 'missing.json') }),
      /未知 target：zzz（可选：未配置）/,
    );
  } finally {
    dir.cleanup();
  }
});

test('networkHint：内网/公网提示不同', () => {
  assert.match(networkHint({ name: 'x', baseUrl: 'https://x.test', role: 'r', network: 'intranet' }), /内网目标.*VPN/);
  assert.match(networkHint({ name: 'x', baseUrl: 'https://x.test', role: 'r', network: 'public' }), /公网目标.*域名可达/);
  assert.match(networkHint({ name: 'x', baseUrl: 'https://x.test', role: 'r' }), /公网目标/);
});

test('目标配置：支持全局位置 ~/.rc/targets.json（cwd 之外也能放）', async () => {
  const home = tmpDir('rc-home-');
  try {
    const file = join(home.dir, 'targets.json');
    writeFileSync(file, JSON.stringify([{ name: 'global', baseUrl: 'https://global.test', role: 'dev' }]), 'utf8');
    await withEnv({ RC_TARGETS: undefined, RC_HOME: home.dir }, () => {
      const t = loadTargets();
      assert.equal(t.length, 1);
      assert.equal(t[0].name, 'global');
    });
  } finally {
    home.cleanup();
  }
});
