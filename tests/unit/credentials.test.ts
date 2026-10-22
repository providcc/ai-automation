/**
 * 凭据解析单测：用 PATH 上的假 `security` / `secret-tool` 脚本模拟系统钥匙串，不触网、不读真实钥匙串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  keychainEnabled,
  readKeychainSecret,
  resolveCredentials,
} from '../../packages/core/src/credentials.ts';
import { tmpDir, withEnv } from './helpers.ts';

const FAKE_SCRIPT = `#!/bin/sh
prev=""
acct=""
for a in "$@"; do
  if [ "$prev" = "-a" ] || [ "$prev" = "account" ]; then acct="$a"; fi
  prev="$a"
done
if [ -n "$RC_FAKE_KEYCHAIN_LOG" ]; then
  printf '%s\\n' "$*" >> "$RC_FAKE_KEYCHAIN_LOG"
fi
if [ -n "$RC_FAKE_KEYCHAIN_FAIL_ACCOUNT" ] && [ "$acct" = "$RC_FAKE_KEYCHAIN_FAIL_ACCOUNT" ]; then
  exit 1
fi
printf '%s' "$RC_FAKE_KEYCHAIN_OUT"
`;

/** 造一套假钥匙串命令，返回 { dir, log, path } */
function fakeKeychain() {
  const dir = tmpDir('rc-kc-');
  const log = join(dir.dir, 'calls.log');
  for (const name of ['security', 'secret-tool']) {
    const p = join(dir.dir, name);
    writeFileSync(p, FAKE_SCRIPT, 'utf8');
    chmodSync(p, 0o755);
  }
  return { dir, log, path: `${dir.dir}:${process.env.PATH ?? ''}` };
}

function readLog(log: string): string[] {
  try {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test('钥匙串开关：仅 1/true 启用', async () => {
  assert.equal(keychainEnabled({ RC_KEYCHAIN: '1' }), true);
  assert.equal(keychainEnabled({ RC_KEYCHAIN: 'true' }), true);
  assert.equal(keychainEnabled({ RC_KEYCHAIN: '0' }), false);
  assert.equal(keychainEnabled({ RC_KEYCHAIN: 'yes' }), false);
  assert.equal(keychainEnabled({}), false);
  await withEnv({ RC_KEYCHAIN: '1' }, () => {
    assert.equal(keychainEnabled(), true);
  });
  await withEnv({ RC_KEYCHAIN: undefined }, () => {
    assert.equal(keychainEnabled(), false);
  });
});

test('读取钥匙串（darwin）：security 命中返回明文', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'sekret',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const r = readKeychainSecret('ci-bot', 'rc-ipaas', 'darwin');
      assert.equal(r.value, 'sekret');
      assert.equal(r.warning, undefined);
      const calls = readLog(kc.log);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /find-generic-password -s rc-ipaas -a ci-bot -w/);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('读取钥匙串（darwin）：空值与读取失败给出不同告警', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: '',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const empty = readKeychainSecret('ci-bot', 'rc-ipaas', 'darwin');
      assert.equal(empty.warning, '钥匙串 rc-ipaas/ci-bot 为空');
      assert.equal(empty.value, undefined);
    });

    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'x',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: 'ci-bot',
    }, () => {
      const failed = readKeychainSecret('ci-bot', 'rc-ipaas', 'darwin');
      assert.equal(failed.warning, '未从系统钥匙串读取到 rc-ipaas/ci-bot');
      assert.equal(failed.value, undefined);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('读取钥匙串（linux）：secret-tool 命中/空值/失败', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'linux-secret',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const r = readKeychainSecret('ci-bot', 'rc-ipaas', 'linux');
      assert.equal(r.value, 'linux-secret');
      assert.equal(r.warning, undefined);
      assert.match(readLog(kc.log)[0], /lookup service rc-ipaas account ci-bot/);
    });

    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: '',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const emptyLinux = readKeychainSecret('ci-bot', 'rc-ipaas', 'linux');
      assert.equal(emptyLinux.warning, 'secret-tool rc-ipaas/ci-bot 为空');
      assert.equal(emptyLinux.value, undefined);
    });

    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'x',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: 'ci-bot',
    }, () => {
      const failedLinux = readKeychainSecret('ci-bot', 'rc-ipaas', 'linux');
      assert.equal(failedLinux.warning, '未从系统钥匙串读取到 rc-ipaas/ci-bot');
      assert.equal(failedLinux.value, undefined);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('读取钥匙串：不支持的平台直接告警', () => {
  const r = readKeychainSecret('ci-bot', 'rc-ipaas', 'win32');
  assert.equal(r.warning, '当前平台 win32 不支持系统钥匙串');
  assert.equal(r.value, undefined);
});

test('解析凭据：仅环境变量时 source=env 且不访问钥匙串', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'should-not-be-used',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
    }, () => {
      const r = resolveCredentials({ RC_USER: 'u1', RC_PASS: 'p1' });
      assert.equal(r.user, 'u1');
      assert.equal(r.pass, 'p1');
      assert.equal(r.token, undefined);
      assert.equal(r.source, 'env');
      assert.deepEqual(r.warnings, []);
      assert.equal(readLog(kc.log).length, 0, '未开启 RC_KEYCHAIN 时不应访问钥匙串');
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：环境变量齐全时也不访问钥匙串', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'kc',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
    }, () => {
      const r = resolveCredentials({
        RC_USER: 'u1', RC_PASS: 'p1', RC_TOKEN: 't1', RC_KEYCHAIN: '1',
      });
      assert.equal(r.source, 'env');
      assert.equal(r.token, 't1');
      assert.equal(readLog(kc.log).length, 0);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：钥匙串补齐缺项时 source=keychain', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'from-kc',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const r = resolveCredentials({ RC_KEYCHAIN: '1' });
      assert.equal(r.user, 'from-kc');
      assert.equal(r.pass, 'from-kc');
      assert.equal(r.token, 'from-kc');
      assert.equal(r.source, 'keychain');
      assert.deepEqual(r.warnings, []);
      const calls = readLog(kc.log);
      assert.equal(calls.length, 3);
      // macOS: security find-generic-password -s <svc> -a <account> -w
      // Linux: secret-tool lookup service <svc> account <account>
      const mac = process.platform === 'darwin';
      assert.match(calls[0], mac ? /-a user -w$/ : /account user$/);
      assert.match(calls[1], mac ? /-a from-kc -w$/ : /account from-kc$/, '密码账号缺省取 user 值');
      assert.match(calls[2], mac ? /-a token -w$/ : /account token$/);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：环境变量与钥匙串混用时 source=mixed', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'from-kc',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const r = resolveCredentials({ RC_KEYCHAIN: '1', RC_USER: 'env-user' });
      assert.equal(r.user, 'env-user');
      assert.equal(r.pass, 'from-kc');
      assert.equal(r.token, 'from-kc');
      assert.equal(r.source, 'mixed');
      const calls = readLog(kc.log);
      assert.equal(calls.length, 2, 'user 已在环境变量中，不应再查钥匙串');
      const mac = process.platform === 'darwin';
      assert.match(calls[0], mac ? /-a env-user -w$/ : /account env-user$/, '密码账号缺省取 user 值');
      assert.match(calls[1], mac ? /-a token -w$/ : /account token$/);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：自定义 service/account 生效', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'from-kc',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const r = resolveCredentials({
        RC_KEYCHAIN: '1',
        RC_KEYCHAIN_SERVICE: 'my-svc',
        RC_KEYCHAIN_ACCOUNT: 'my-account',
        RC_KEYCHAIN_TOKEN_ACCOUNT: 'my-token-account',
      });
      assert.equal(r.source, 'keychain');
      const calls = readLog(kc.log);
      assert.equal(calls.length, 3);
      const mac = process.platform === 'darwin';
      assert.match(calls[0], mac ? /-s my-svc -a user -w$/ : /lookup service my-svc account user$/);
      assert.match(calls[1], mac ? /-s my-svc -a my-account -w$/ : /lookup service my-svc account my-account$/);
      assert.match(calls[2], mac ? /-s my-svc -a my-token-account -w$/ : /lookup service my-svc account my-token-account$/);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：钥匙串全空时 source=none 且只提示必需项', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: '',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const r = resolveCredentials({ RC_KEYCHAIN: '1' });
      assert.equal(r.user, undefined);
      assert.equal(r.pass, undefined);
      assert.equal(r.token, undefined);
      assert.equal(r.source, 'none');
      assert.equal(r.warnings.length, 2, 'token 缺失不产生噪声');
      assert.match(r.warnings[0], /rc-ipaas\/user 为空/);
      assert.match(r.warnings[1], /rc-ipaas\/default 为空/);
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：token 读取失败不产生告警', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'from-kc',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: 'token',
    }, () => {
      const r = resolveCredentials({ RC_KEYCHAIN: '1' });
      assert.equal(r.token, undefined);
      assert.equal(r.user, 'from-kc');
      assert.deepEqual(r.warnings, []);
      assert.equal(r.source, 'keychain');
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：RC_KEYCHAIN=true 同样启用钥匙串', async () => {
  const kc = fakeKeychain();
  try {
    await withEnv({
      PATH: kc.path,
      RC_FAKE_KEYCHAIN_OUT: 'from-kc',
      RC_FAKE_KEYCHAIN_LOG: kc.log,
      RC_FAKE_KEYCHAIN_FAIL_ACCOUNT: undefined,
    }, () => {
      const r = resolveCredentials({ RC_KEYCHAIN: 'true' });
      assert.equal(r.source, 'keychain');
      assert.equal(r.user, 'from-kc');
    });
  } finally {
    kc.dir.cleanup();
  }
});

test('解析凭据：默认从 process.env 读取', async () => {
  await withEnv({ RC_USER: 'env-u', RC_PASS: 'env-p', RC_TOKEN: 'env-t', RC_KEYCHAIN: undefined }, () => {
    const r = resolveCredentials();
    assert.equal(r.user, 'env-u');
    assert.equal(r.pass, 'env-p');
    assert.equal(r.token, 'env-t');
    assert.equal(r.source, 'env');
  });
});
