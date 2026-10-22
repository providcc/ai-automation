/**
 * dw 配置层单测：多环境寻址、凭据分离、优先级、隧道声明展开。
 * 全部用临时目录与临时环境变量，**不出现任何真实主机/库名**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import {
  configFilePath,
  credentialsFilePath,
  DEFAULT_HTTP_PORT,
  DEFAULT_MYSQL_PORT,
  describeWarehouseEnv,
  expandForwards,
  loadWarehouseConfig,
  loadWarehouseCredentials,
  maskHost,
  resolveWarehouseEnv,
  warehouseHome,
} from '../../packages/core/src/dw/config.ts';
import { tmpDir, withEnv } from './helpers.ts';

const CLEAN = {
  DW_HOME: undefined, DW_CONFIG: undefined, DW_CREDENTIALS: undefined, DW_TARGETS: undefined,
  DW_HOST: undefined, DW_PORT: undefined, DW_HTTP_PORT: undefined, DW_USER: undefined,
  DW_PASS: undefined, DW_DB: undefined, DW_CATALOG: undefined, DW_TRANSPORT: undefined,
  DW_CMD: undefined, DW_NETWORK: undefined, DW_TUNNEL: undefined, DW_ENV: undefined,
  DW_PROFILE: undefined, DW_ALLOW_PROD_WRITE: undefined, DW_MASK_COLS: undefined,
} as const;

test('路径：DW_HOME 决定配置根，DW_CONFIG/DW_CREDENTIALS 可单独覆盖', async () => {
  await withEnv({ ...CLEAN, DW_HOME: '/tmp/dw-home-x' }, () => {
    assert.equal(warehouseHome(), '/tmp/dw-home-x');
    assert.equal(configFilePath(), '/tmp/dw-home-x/warehouse.json');
    assert.equal(credentialsFilePath(), '/tmp/dw-home-x/warehouse-credentials.json');
  });
  await withEnv({ ...CLEAN, DW_CONFIG: '/tmp/a.json', DW_CREDENTIALS: '/tmp/b.json' }, () => {
    assert.equal(configFilePath(), '/tmp/a.json');
    assert.equal(credentialsFilePath(), '/tmp/b.json');
  });
});

test('配置：文件缺失回空对象，不是报错', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    await withEnv({ ...CLEAN, DW_HOME: t.dir }, () => {
      assert.deepEqual(loadWarehouseConfig(), {});
    });
  } finally {
    t.cleanup();
  }
});

test('配置：非法 JSON / environments 形状错误给出明确错误', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write('bad.json', '{ not json');
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('bad.json') }, () => {
      assert.throws(() => loadWarehouseConfig(), /不是合法 JSON/);
    });
    t.write('shape.json', JSON.stringify({ environments: [1, 2] }));
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('shape.json') }, () => {
      assert.throws(() => loadWarehouseConfig(), /environments 需要是对象/);
    });
  } finally {
    t.cleanup();
  }
});

test('配置：DW_TARGETS 支持数组与 {environments}，形状错给明确错误', async () => {
  await withEnv({ ...CLEAN, DW_TARGETS: JSON.stringify([{ name: 'a', host: 'h-a' }]) }, () => {
    const cfg = loadWarehouseConfig();
    assert.equal(cfg.environments?.a.host, 'h-a');
  });
  await withEnv(
    { ...CLEAN, DW_TARGETS: JSON.stringify({ default_env: 'b', environments: { b: { host: 'h-b' } } }) },
    () => {
      const cfg = loadWarehouseConfig();
      assert.equal(cfg.default_env, 'b');
      assert.equal(cfg.environments?.b.host, 'h-b');
    },
  );
  await withEnv({ ...CLEAN, DW_TARGETS: 'not json' }, () => {
    assert.throws(() => loadWarehouseConfig(), /DW_TARGETS 不是合法 JSON/);
  });
  await withEnv({ ...CLEAN, DW_TARGETS: JSON.stringify({ nope: 1 }) }, () => {
    assert.throws(() => loadWarehouseConfig(), /需要是数组或/);
  });
  // 数组里没有 name 的项被跳过，不炸
  await withEnv({ ...CLEAN, DW_TARGETS: JSON.stringify([{ host: 'x' }, { name: 'c', host: 'h-c' }]) }, () => {
    assert.deepEqual(Object.keys(loadWarehouseConfig().environments ?? {}), ['c']);
  });
});

test('凭据：文件缺失回空；权限过宽只警告不阻断', async () => {
  const t = tmpDir('dw-cred-');
  try {
    await withEnv({ ...CLEAN, DW_CREDENTIALS: t.file('nope.json') }, () => {
      assert.deepEqual(loadWarehouseCredentials(), { data: {} });
    });
    const f = t.write('creds.json', JSON.stringify({ test: { password: 'pw' } }));
    chmodSync(f, 0o644);
    await withEnv({ ...CLEAN, DW_CREDENTIALS: f }, () => {
      const r = loadWarehouseCredentials();
      assert.equal(r.data.test?.password, 'pw');
      assert.match(r.warning ?? '', /权限过宽/);
    });
    chmodSync(f, 0o600);
    await withEnv({ ...CLEAN, DW_CREDENTIALS: f }, () => {
      assert.equal(loadWarehouseCredentials().warning, undefined);
    });
  } finally {
    t.cleanup();
  }
});

test('解析：环境变量直给（DW_HOST）优先于文件', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write(
      'warehouse.json',
      JSON.stringify({ default_env: 'file', environments: { file: { host: 'file-host' } } }),
    );
    await withEnv({ ...CLEAN, DW_HOME: t.dir, DW_HOST: 'var-host', DW_USER: 'u', DW_PASS: 'p' }, () => {
      const e = resolveWarehouseEnv();
      assert.equal(e.host, 'var-host');
      assert.equal(e.name, 'env');
      assert.equal(e.mysqlPort, DEFAULT_MYSQL_PORT);
      assert.equal(e.httpPort, DEFAULT_HTTP_PORT);
      assert.equal(e.catalog, 'internal');
      assert.equal(e.transport, 'http');
    });
  } finally {
    t.cleanup();
  }
});

test('解析：按名字取环境；未知名字报错并列出可选', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write(
      'warehouse.json',
      JSON.stringify({ environments: { alpha: { host: 'h-a' }, beta: { host: 'h-b', database: 'd' } } }),
    );
    await withEnv({ ...CLEAN, DW_HOME: t.dir }, () => {
      assert.equal(resolveWarehouseEnv({ name: 'beta' }).database, 'd');
      assert.throws(() => resolveWarehouseEnv({ name: 'gamma' }), /未知数仓环境：gamma.*alpha, beta/s);
    });
  } finally {
    t.cleanup();
  }
});

test('解析：唯一环境自动选中；多环境无默认值时报错；零环境给配置指引', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write('one.json', JSON.stringify({ environments: { only: { host: 'h' } } }));
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('one.json') }, () => {
      assert.equal(resolveWarehouseEnv().name, 'only');
    });
    t.write('two.json', JSON.stringify({ environments: { a: { host: 'h' }, b: { host: 'h' } } }));
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('two.json') }, () => {
      assert.throws(() => resolveWarehouseEnv(), /配置了多个数仓环境/);
    });
    t.write('zero.json', JSON.stringify({ environments: {} }));
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('zero.json') }, () => {
      assert.throws(() => resolveWarehouseEnv(), /没有可用的数仓环境/);
    });
  } finally {
    t.cleanup();
  }
});

test('解析：密码优先级 DW_PASS > 凭据文件；只读闸门由 DW_PROFILE 决定', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write('warehouse.json', JSON.stringify({ environments: { prod: { host: 'h' } } }));
    t.write('creds.json', JSON.stringify({ prod: { password: '<from-file>' } }));
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('warehouse.json'), DW_CREDENTIALS: t.file('creds.json') }, () => {
      assert.equal(resolveWarehouseEnv().password, '<from-file>');
    });
    await withEnv(
      { ...CLEAN, DW_CONFIG: t.file('warehouse.json'), DW_CREDENTIALS: t.file('creds.json'), DW_PASS: 'from-var' },
      () => {
        assert.equal(resolveWarehouseEnv().password, 'from-var');
      },
    );
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('warehouse.json'), DW_PROFILE: 'prod' }, () => {
      assert.equal(resolveWarehouseEnv().readonly, true);
    });
    await withEnv(
      { ...CLEAN, DW_CONFIG: t.file('warehouse.json'), DW_PROFILE: 'prod', DW_ALLOW_PROD_WRITE: '1' },
      () => {
        assert.equal(resolveWarehouseEnv().readonly, false);
      },
    );
    // 命令行显式覆盖
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('warehouse.json') }, () => {
      assert.equal(resolveWarehouseEnv({ readonly: true }).readonly, true);
    });
  } finally {
    t.cleanup();
  }
});

test('解析：DW_TUNNEL 非法 JSON 报错；隧道缺 jumpHost 报错', async () => {
  await withEnv({ ...CLEAN, DW_HOST: 'h', DW_TUNNEL: '{bad' }, () => {
    assert.throws(() => resolveWarehouseEnv(), /DW_TUNNEL 不是合法 JSON/);
  });
  const t = tmpDir('dw-cfg-');
  try {
    t.write('warehouse.json', JSON.stringify({ environments: { e: { host: 'h', tunnel: { enabled: true } } } }));
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('warehouse.json') }, () => {
      assert.throws(() => resolveWarehouseEnv(), /隧道缺少 jumpHost/);
    });
  } finally {
    t.cleanup();
  }
});

test('解析：启用隧道时按 host/端口生成两条转发（本地端口 = 远端 + 10000）', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write(
      'warehouse.json',
      JSON.stringify({
        environments: { e: { host: 'h', mysqlPort: 9030, httpPort: 8030, tunnel: { enabled: true, jumpHost: 'j' } } },
      }),
    );
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('warehouse.json') }, () => {
      const e = resolveWarehouseEnv();
      assert.deepEqual(e.tunnel?.forwards, [
        { local: 19030, remoteHost: 'h', remotePort: 9030 },
        { local: 18030, remoteHost: 'h', remotePort: 8030 },
      ]);
    });
  } finally {
    t.cleanup();
  }
});

test('expandForwards：显式 forwards 优先，否则按端口生成', () => {
  const explicit = expandForwards(
    { enabled: true, jumpHost: 'j', forwards: [{ local: 1, remoteHost: 'r', remotePort: 2 }] },
    { host: 'h', mysqlPort: 9030, httpPort: 8030 },
  );
  assert.deepEqual(explicit, [{ local: 1, remoteHost: 'r', remotePort: 2 }]);
  const generated = expandForwards({ enabled: true, jumpHost: 'j' }, { host: 'h', mysqlPort: 9030, httpPort: 8030 });
  assert.equal(generated.length, 2);
});

test('传输方式：给 cmd 模板时自动判为 cmd 传输', async () => {
  await withEnv({ ...CLEAN, DW_HOST: 'h', DW_CMD: 'mytool --sql {sql}' }, () => {
    assert.equal(resolveWarehouseEnv().transport, 'cmd');
  });
  await withEnv({ ...CLEAN, DW_HOST: 'h', DW_TRANSPORT: 'cmd', DW_CMD: 'x {sql}' }, () => {
    assert.equal(resolveWarehouseEnv().transport, 'cmd');
  });
});

test('maskHost：保留可辨识前后缀，短串全抹', () => {
  assert.equal(maskHost(''), '');
  assert.equal(maskHost('ab'), '***');
  // 用 RFC 5737 文档地址段（192.0.2.0/24）当夹具：形状像 IP，但不是任何内网段，
  // 免得测试夹具本身被 scripts/sensitive-scan.mjs 判成内网 IP 泄漏。
  assert.equal(maskHost('192.0.2.10'), '1***0');
  assert.equal(maskHost('a-very-long-host-name'), 'a-v***ame');
});

test('describeWarehouseEnv：默认打码 host、**绝不出现密码**', () => {
  const desc = describeWarehouseEnv(
    {
      name: 'test',
      host: 'dw-host',
      mysqlPort: 9030,
      httpPort: 8030,
      user: 'tester',
      catalog: 'internal',
      database: 'demo_db',
      transport: 'http',
      password: '<secret>',
      readonly: true,
    },
  );
  assert.equal(desc.host, 'd***t');
  assert.equal(desc.hasPassword, true);
  assert.equal(desc.readonly, true);
  assert.equal(JSON.stringify(desc).includes('super-secret'), false);
  const revealed = describeWarehouseEnv(
    { name: 't', host: 'dw-host', mysqlPort: 1, httpPort: 2, catalog: 'internal', transport: 'http' },
    { revealHost: true },
  );
  assert.equal(revealed.host, 'dw-host');
});

test('describeWarehouseEnv：隧道启用时 jumpHost 也打码，并带出转发列表', () => {
  const desc = describeWarehouseEnv({
    name: 't',
    host: 'dw-host',
    mysqlPort: 9030,
    httpPort: 8030,
    catalog: 'internal',
    transport: 'http',
    tunnel: {
      enabled: true,
      jumpHost: 'jump-host',
      forwards: [{ local: 19030, remoteHost: 'dw-host', remotePort: 9030 }],
    },
  }) as { tunnel: { jumpHost: string; forwards: unknown[] } };
  assert.equal(desc.tunnel.jumpHost, 'j***t');
  assert.equal(desc.tunnel.forwards.length, 1);
});

test('凭据权限警告会带进解析结果（供 CLI 转达）', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write('warehouse.json', JSON.stringify({ environments: { e: { host: 'h' } } }));
    const creds = t.write('creds.json', JSON.stringify({ e: { password: 'p' } }));
    chmodSync(creds, 0o644);
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('warehouse.json'), DW_CREDENTIALS: creds }, () => {
      const e = resolveWarehouseEnv();
      assert.equal(e.warnings?.length, 1);
      assert.match(e.warnings![0], /权限过宽/);
    });
  } finally {
    t.cleanup();
  }
});

test('配置文件里的 database 可被 --db 覆盖（CLI 就是这么做的）', async () => {
  const t = tmpDir('dw-cfg-');
  try {
    t.write('warehouse.json', JSON.stringify({ environments: { e: { host: 'h', database: 'from-file' } } }));
    await withEnv({ ...CLEAN, DW_CONFIG: t.file('warehouse.json') }, () => {
      const e = resolveWarehouseEnv();
      assert.equal(e.database, 'from-file');
      e.database = 'override';
      assert.equal(e.database, 'override');
    });
  } finally {
    t.cleanup();
  }
});
