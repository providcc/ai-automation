/**
 * nl-flow：自然语言 → 流程草案（离线规则路径）
 *
 * 全部用例都不触网：RC_LLM_URL 未设置 → 走离线规则；
 * 需要覆盖 LLM 分支时用本地 fetch 桩替换 globalThis.fetch。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowFromNl, formatNlFlow } from '../../packages/core/src/nl-flow.ts';
import { Catalog } from '../../packages/core/src/catalog.ts';
import { withEnv } from './helpers.ts';

const catalog = new Catalog();

/** 强制离线：不设置 RC_LLM_URL */
function offline<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ RC_LLM_URL: undefined, RC_LLM_KEY: undefined, RC_LLM_MODEL: undefined }, fn);
}

/** 用本地桩替换 fetch（不触网），结束后还原 */
async function withFetch<T>(impl: (url: string, init: any) => any, fn: () => Promise<T>): Promise<T> {
  const orig = (globalThis as any).fetch;
  (globalThis as any).fetch = impl;
  try {
    return await fn();
  } finally {
    (globalThis as any).fetch = orig;
  }
}

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('nl-flow：同步 API 模式识别 URL/方法/接口名', async () => {
  const r = await offline(() => flowFromNl('调用订单接口 https://api.example.com/order', { catalog }));
  assert.equal(r.pattern, 'sync-api');
  assert.equal(r.kind, 'esb');
  assert.equal(r.usedLlm, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.input.nodes.map((n) => n.nodeType), ['start', 'apiNode', 'end']);
  assert.equal(r.input.edges.length, 2);
  const api = r.input.nodes.find((n) => n.nodeType === 'apiNode')!;
  assert.equal((api.props as any).apiUrl, 'https://api.example.com/order');
  assert.equal((api.props as any).methodType, 'POST');
  assert.equal((api.props as any).pNodeName, '订单');
  assert.equal((api.props as any).retryNum, 2);
  assert.ok(r.props.some((p) => p.nodeType === 'apiNode'));
  assert.equal(r.rawText, '调用订单接口 https://api.example.com/order');
});

test('nl-flow：未识别到地址时给出补齐告警', async () => {
  const r = await offline(() => flowFromNl('做点事情', { catalog }));
  assert.equal(r.pattern, 'sync-api');
  assert.ok(r.warnings.some((w) => w.includes('未识别到接口地址')));
  const api = r.input.nodes.find((n) => n.nodeType === 'apiNode')!;
  assert.equal((api.props as any).apiUrl, '');
});

test('nl-flow：路径形式（接口/路径/path 前缀）与 /rest 兜底都能识别', async () => {
  const a = await offline(() => flowFromNl('接口路径：/rest/core/services', { catalog }));
  assert.equal((a.input.nodes.find((n) => n.nodeType === 'apiNode')!.props as any).apiUrl, '/rest/core/services');

  const b = await offline(() => flowFromNl('调用 /rest/core/apps 接口', { catalog }));
  assert.equal((b.input.nodes.find((n) => n.nodeType === 'apiNode')!.props as any).apiUrl, '/rest/core/apps');

  const c = await offline(() => flowFromNl('path: /api/v1/users', { catalog }));
  assert.equal((c.input.nodes.find((n) => n.nodeType === 'apiNode')!.props as any).apiUrl, '/api/v1/users');
});

test('nl-flow：HTTP 方法大写识别', async () => {
  const r = await offline(() => flowFromNl('PUT https://api.example.com/u/1', { catalog }));
  assert.equal((r.input.nodes.find((n) => n.nodeType === 'apiNode')!.props as any).methodType, 'PUT');
});

test('nl-flow：条件分支（router）生成两条 assert 3/6 出边', async () => {
  const r = await offline(() => flowFromNl('如果状态为成功则调用接口，否则记录日志', { catalog }));
  assert.equal(r.pattern, 'router');
  assert.deepEqual(r.input.nodes.map((n) => n.nodeType), ['start', 'apiNode', 'returnDataNode', 'returnDataNode', 'end']);
  const api = r.input.nodes.find((n) => n.nodeType === 'apiNode')!;
  const outs = r.input.edges.filter((e) => e.from === api.key);
  assert.equal(outs.length, 2);
  assert.deepEqual(outs.map((e) => e.assertCondition).sort(), ['3', '6']);
  assert.ok(r.warnings.some((w) => w.includes('条件分支需在 router 属性中填写')));
});

test('nl-flow：并行分支（fanout）生成并行网关 + 聚合网关', async () => {
  const r = await offline(() => flowFromNl('同时调用两个接口：https://a.test/x 和 https://b.test/y', { catalog }));
  assert.equal(r.pattern, 'fanout');
  const gws = r.input.nodes.filter((n) => n.nodeType === 'gateWay');
  assert.equal(gws.length, 2);
  assert.equal((gws[0].props as any).gatewayType, '2');
  assert.equal((gws[1].props as any).joinNodeId, gws[0].key);
  const apis = r.input.nodes.filter((n) => n.nodeType === 'apiNode');
  assert.equal(apis.length, 2);
  assert.equal(r.ok, true);
});

test('nl-flow：ETL 变体（db-to-api）节点类型在 ETL 目录内', async () => {
  const r = await offline(() => flowFromNl('数据库表查询数据后调用接口', { kind: 'etl', catalog }));
  assert.equal(r.pattern, 'db-to-api');
  assert.equal(r.kind, 'etl');
  assert.deepEqual(r.input.nodes.map((n) => n.nodeType), ['start', 'sqlExecuterNode', 'apiNode', 'end']);
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
  assert.equal((r.input.nodes.find((n) => n.nodeType === 'sqlExecuterNode')!.props as any).sqlCode, '');
});

test('nl-flow：批量同步识别源表/目标表并生成读写属性', async () => {
  const r = await offline(() => flowFromNl('从 user 表 同步到 order 表', { kind: 'esb', catalog }));
  assert.equal(r.pattern, 'batch-sync');
  assert.deepEqual(r.input.nodes.map((n) => n.nodeType), ['start', 'tableReadNode', 'jdbcWriteNode', 'end']);
  const read = r.input.nodes.find((n) => n.nodeType === 'tableReadNode')!;
  const write = r.input.nodes.find((n) => n.nodeType === 'jdbcWriteNode')!;
  assert.equal((read.props as any).tableName, 'user');
  assert.equal((read.props as any).sqlCode, 'select * from user');
  assert.equal((read.props as any).pageReadDataFlag, '0');
  assert.equal((write.props as any).tableName, 'order');
  assert.equal((write.props as any).sqlCode, 'insert into order (...) values (...)');
  assert.equal((write.props as any).appendFlag, '1');
  assert.equal((write.props as any).copyData, '0');
  assert.equal(r.ok, true);
});

test('nl-flow：批量同步未识别到表名时给出两条告警', async () => {
  const r = await offline(() => flowFromNl('批量同步数据', { kind: 'esb', catalog }));
  assert.equal(r.pattern, 'batch-sync');
  assert.ok(r.warnings.some((w) => w.includes('未识别到源表名')));
  assert.ok(r.warnings.some((w) => w.includes('未识别到目标表名')));
});

test('nl-flow：批量同步在 ETL 类型下使用 sqlReadNode（ETL 目录里没有 tableReadNode）', async () => {
  const r = await offline(() => flowFromNl('从 user 表 同步到 order 表', { catalog }));
  assert.equal(r.kind, 'etl');
  // ETL 组件目录只有 sqlReadNode → 生成 ETL 可用的节点类型
  assert.ok(r.input.nodes.some((n) => n.nodeType === 'sqlReadNode'));
  assert.ok(!r.input.nodes.some((n) => n.nodeType === 'tableReadNode'));
  assert.ok(!r.warnings.some((w) => w.includes('未知节点类型')));
  assert.equal(r.ok, true);
});

test('nl-flow：普通 ESB 需求里出现"表"不会被误判成 ETL', async () => {
  const r = await offline(() => flowFromNl('调用订单表查询接口 https://api.example.com/order', { catalog }));
  assert.equal(r.kind, 'esb');
});

test('nl-flow：子流程模式识别 24 位 hex id', async () => {
  const r = await offline(() => flowFromNl('调用子流程 0123456789abcdef01234567', { catalog }));
  assert.equal(r.pattern, 'subprocess');
  assert.deepEqual(r.input.nodes.map((n) => n.nodeType), ['start', 'subProcessNode', 'end']);
  assert.equal((r.input.nodes.find((n) => n.nodeType === 'subProcessNode')!.props as any).subProcessId, '0123456789abcdef01234567');
  assert.ok(!r.warnings.some((w) => w.includes('未识别到子流程 id')));
});

test('nl-flow：子流程缺少 id 时告警', async () => {
  const r = await offline(() => flowFromNl('调用子流程完成汇总', { catalog }));
  assert.equal(r.pattern, 'subprocess');
  assert.ok(r.warnings.some((w) => w.includes('未识别到子流程 id')));
  assert.equal((r.input.nodes.find((n) => n.nodeType === 'subProcessNode')!.props as any).subProcessId, '');
});

test('nl-flow：定时模式识别每天/每小时/每 N 分钟', async () => {
  const daily = await offline(() => flowFromNl('每天 3:30 定时调用接口', { catalog }));
  assert.equal(daily.pattern, 'scheduled');
  assert.equal((daily.input.nodes.find((n) => n.nodeType === 'timeNode')!.props as any).cron, '0 30 3 * * ?');

  const hourly = await offline(() => flowFromNl('每小时同步一次数据', { catalog }));
  assert.equal(hourly.pattern, 'scheduled');
  assert.equal((hourly.input.nodes.find((n) => n.nodeType === 'timeNode')!.props as any).cron, '0 0 * * * ?');

  const every5 = await offline(() => flowFromNl('每5分钟定时同步一次数据', { catalog }));
  assert.equal(every5.pattern, 'scheduled');
  assert.equal((every5.input.nodes.find((n) => n.nodeType === 'timeNode')!.props as any).cron, '0 0/5 * * * ?');
});

test('nl-flow：定时模式未识别时间时给出默认 cron 告警', async () => {
  const r = await offline(() => flowFromNl('定时调用接口', { catalog }));
  assert.equal(r.pattern, 'scheduled');
  assert.equal((r.input.nodes.find((n) => n.nodeType === 'timeNode')!.props as any).cron, '0 0 2 * * ?');
  assert.ok(r.warnings.some((w) => w.includes('未识别到明确时间')));
});

test('nl-flow：消息模式（Kafka URL → kafkaNode，普通 → msgNode）', async () => {
  const kafka = await offline(() => flowFromNl('消费 Kafka 队列消息并调用接口 https://kafka.test/topic', { catalog }));
  assert.equal(kafka.pattern, 'message');
  assert.ok(kafka.input.nodes.some((n) => n.nodeType === 'kafkaNode'));

  const plain = await offline(() => flowFromNl('消费队列消息并调用接口', { catalog }));
  assert.equal(plain.pattern, 'message');
  assert.ok(plain.input.nodes.some((n) => n.nodeType === 'msgNode'));
});

test('nl-flow：文件入库与库出文件两种模式', async () => {
  const toDb = await offline(() => flowFromNl('从 SFTP 下载 Excel 文件并写入数据库', { catalog }));
  assert.equal(toDb.pattern, 'file-to-db');
  assert.deepEqual(toDb.input.nodes.map((n) => n.nodeType), ['start', 'sftpReadNode', 'jdbcWriteNode', 'end']);
  assert.ok(toDb.warnings.some((w) => w.includes('文件节点需要 filePath')));

  const toFile = await offline(() => flowFromNl('从表 order 查询数据并导出 CSV 文件', { catalog }));
  assert.equal(toFile.pattern, 'db-to-file');
  assert.deepEqual(toFile.input.nodes.map((n) => n.nodeType), ['start', 'sqlExecuterNode', 'sftpUploadNode', 'end']);
  assert.equal((toFile.input.nodes.find((n) => n.nodeType === 'sqlExecuterNode')!.props as any).sqlCode, 'select * from order');
});

test('nl-flow：异步回调与幂等模式', async () => {
  const asyncR = await offline(() => flowFromNl('调用异步接口并处理回调', { catalog }));
  assert.equal(asyncR.pattern, 'async');
  assert.deepEqual(asyncR.input.nodes.map((n) => n.nodeType), ['start', 'apiNode', 'asyncCallbackNode', 'end']);
  assert.equal((asyncR.input.nodes.find((n) => n.nodeType === 'apiNode')!.props as any).asyncFlag, '1');
  assert.ok(asyncR.warnings.some((w) => w.includes('异步流程需在调用方配置回调地址')));

  const idem = await offline(() => flowFromNl('调用接口做幂等去重写入', { catalog }));
  assert.equal(idem.pattern, 'idempotent');
  const api = idem.input.nodes.find((n) => n.nodeType === 'apiNode')!;
  assert.equal((api.props as any).retryNum, 3);
  assert.equal((api.props as any).idempotencyKey, '${$.data.id}');
  assert.ok(idem.warnings.some((w) => w.includes('幂等键需与目标系统约定')));
});

test('nl-flow：ESB 目录外的节点类型被判为未知类型', async () => {
  const fake = {
    nodeTypes: () => new Set(['start', 'end']),
    etlNodeTypes: () => new Set(['start', 'end']),
  } as unknown as Catalog;
  const r = await offline(() => flowFromNl('调用订单接口 https://api.example.com/order', { catalog: fake }));
  assert.ok(r.warnings.some((w) => w.includes('ESB 未知节点类型：apiNode')));
  assert.equal(r.ok, false);
});

test('nl-flow：指定名称覆盖自动命名', async () => {
  const r = await offline(() => flowFromNl('调用订单接口 https://api.example.com/order', { name: '我的流程', catalog }));
  assert.equal(r.name, '我的流程');
});

test('nl-flow：未设置 RC_LLM_URL 时完全走离线路径（不调用 fetch）', async () => {
  let called = 0;
  await withFetch(async () => { called++; return jsonResponse({}); }, async () => {
    const r = await offline(() => flowFromNl('调用订单接口 https://api.example.com/order', { catalog }));
    assert.equal(r.usedLlm, false);
  });
  assert.equal(called, 0);
});

test('nl-flow：useLlm=false 时即使配置了 LLM 也走离线路径', async () => {
  let called = 0;
  await withFetch(async () => { called++; return jsonResponse({}); }, async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { useLlm: false, catalog });
      assert.equal(r.usedLlm, false);
    });
  });
  assert.equal(called, 0);
});

test('nl-flow：LLM 返回合法结构时采用 LLM 结果并置 usedLlm', async () => {
  const payload = {
    choices: [{ message: { content: JSON.stringify({
      pattern: 'custom',
      kind: 'esb',
      nodes: [
        { key: 'T00001', nodeType: 'start', nodeName: '开始', props: {} },
        { key: 'T00002', nodeType: 'apiNode', nodeName: '调用', props: { apiUrl: 'https://llm.test/x' } },
        { key: 'T00003', nodeType: 'end', nodeName: '结束', props: {} },
      ],
      edges: [
        { from: 'T00001', to: 'T00002', assertCondition: '0' },
        { from: 'T00002', to: 'T00003' },
      ],
    }) } }],
  };
  let seen: any = null;
  await withFetch(async (url: string, init: any) => {
    seen = { url, init };
    return jsonResponse(payload);
  }, async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1', RC_LLM_KEY: 'k1', RC_LLM_MODEL: 'm1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.equal(r.usedLlm, true);
      assert.equal(r.input.nodes.length, 3);
      assert.equal(r.input.nodes[1].nodeType, 'apiNode');
      assert.equal(r.props.length, 1);
      assert.equal(r.props[0].nodeType, 'apiNode');
    });
  });
  assert.equal(seen.url, 'http://llm.local/v1');
  assert.equal(seen.init.headers.Authorization, 'Bearer k1');
  assert.equal(JSON.parse(seen.init.body).model, 'm1');
});

test('nl-flow：LLM 无 Authorization 头（未设置 RC_LLM_KEY）', async () => {
  let seen: any = null;
  await withFetch(async (_url: string, init: any) => {
    seen = init;
    return jsonResponse({ content: '{"nodes":[],"edges":[]}' });
  }, async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1', RC_LLM_KEY: undefined }, async () => {
      await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
    });
  });
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(JSON.parse(seen.body).model, 'default');
});

test('nl-flow：LLM 返回未知节点类型时回退离线规则并给出告警', async () => {
  const payload = {
    content: JSON.stringify({
      nodes: [{ key: 'T00001', nodeType: 'start' }, { key: 'T00002', nodeType: 'notARealNode' }],
      edges: [{ from: 'T00001', to: 'T00002' }],
    }),
  };
  await withFetch(async () => jsonResponse(payload), async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.equal(r.usedLlm, false);
      assert.ok(r.warnings.some((w) => w.includes('ESB 未知节点类型：notARealNode')));
      assert.ok(r.warnings.some((w) => w.includes('已回退离线规则')));
    });
  });
});

test('nl-flow：LLM HTTP 错误 / 缺 content / 结构不合法 / 网络异常均回退离线', async () => {
  await withFetch(async () => jsonResponse({}, 500), async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.ok(r.warnings.some((w) => w.includes('LLM HTTP 500')));
      assert.equal(r.usedLlm, false);
    });
  });

  await withFetch(async () => jsonResponse({ choices: [{ message: {} }] }), async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.ok(r.warnings.some((w) => w.includes('LLM 响应缺少 content')));
    });
  });

  await withFetch(async () => jsonResponse({ content: '{"nodes":123}' }), async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.ok(r.warnings.some((w) => w.includes('LLM 输出结构不合法')));
    });
  });

  await withFetch(async () => { throw new Error('network down'); }, async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.ok(r.warnings.some((w) => w.includes('LLM 调用失败（network down）')));
      assert.equal(r.usedLlm, false);
    });
  });
});

test('nl-flow：LLM content 支持 content/text 字段与带前缀 JSON', async () => {
  await withFetch(async () => jsonResponse({ text: '{"nodes":[{"key":"T1","nodeType":"start"}],"edges":[{"from":"T1","to":"T1"}]}' }), async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.equal(r.usedLlm, true);
      assert.equal(r.input.nodes[0].nodeType, 'start');
    });
  });

  await withFetch(async () => jsonResponse({ content: '好的，结果如下：{"nodes":[{"key":"T1","nodeType":"start"}],"edges":[{"from":"T1","to":"T1"}]}' }), async () => {
    await withEnv({ RC_LLM_URL: 'http://llm.local/v1' }, async () => {
      const r = await flowFromNl('调用订单接口 https://api.example.com/order', { catalog });
      assert.equal(r.usedLlm, true);
    });
  });
});

test('nl-flow：formatNlFlow 输出模式/节点/连线/告警', async () => {
  const r = await offline(() => flowFromNl('做点事情', { catalog }));
  const text = formatNlFlow(r);
  assert.ok(text.includes('模式：sync-api（esb，离线规则）'));
  assert.ok(text.includes('建议名称：'));
  assert.ok(text.includes('节点：'));
  assert.ok(text.includes('连线：2 条'));
  assert.ok(text.includes('! 未识别到接口地址'));
  assert.ok(text.includes('✔ 结构草案可用'));

  // ETL 批量同步现在能生成合法结构（sqlReadNode），不再报"未知节点类型"
  const etl = await offline(() => flowFromNl('从 user 表 同步到 order 表', { catalog }));
  const etlText = formatNlFlow(etl);
  assert.ok(etlText.includes('✔ 结构草案可用'));
  assert.ok(!etlText.includes('未知节点类型'));

  const good = await offline(() => flowFromNl('调用订单接口 https://api.example.com/order', { catalog }));
  const goodText = formatNlFlow(good);
  assert.ok(goodText.includes('✔ 结构草案可用'));
});
