/**
 * 命令帮助：目录 ↔ dispatch 双向核对，以及单命令帮助真的能取到。
 *
 * 两类缺陷都在这里被拦下：
 *   - **文档写了但用不了**：catalog 里有 `dw mv foo`，dispatch 里没有对应 `case`；
 *   - **能用但没文档**：dispatch 里有 `case 'dw mv foo'`，catalog 里查不到
 *     （于是 `--help` 只能回落到顶层，用户看不到它的选项与坑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandNames, findCommand, renderCommandHelp, renderTopHelp } from '../../packages/core/src/cli-help.ts';
import { RC_HELP } from '../../packages/cli/src/help.ts';
import { DW_HELP } from '../../packages/dw-cli/src/help.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 从 CLI 源码里抽出全部 `case '<name>':`（排除错误码这类非命令分支）。 */
async function dispatchCases(relPath: string): Promise<Set<string>> {
  const src = await readFile(join(ROOT, relPath), 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/^\s*case '([^']+)':/gm)) {
    const name = m[1];
    if (/^E_[A-Z_]+$/.test(name)) continue; // 错误码分支，不是命令
    out.add(name);
  }
  return out;
}

test('findCommand：取最长前缀匹配（子动作优先，多出来的位置参数是该命令的实参）', () => {
  assert.equal(findCommand(RC_HELP, ['flow', 'props', 'save'])?.name, 'flow props save');
  assert.equal(findCommand(RC_HELP, ['flow', 'props', 'list'])?.name, 'flow props list');
  assert.equal(findCommand(RC_HELP, ['flow', 'get', '12345'])?.name, 'flow get');
  assert.equal(findCommand(RC_HELP, ['sql', 'check'])?.name, 'sql check');
  assert.equal(findCommand(RC_HELP, ['call', 'form', '/a/b'])?.name, 'call form');
  assert.equal(findCommand(RC_HELP, ['api', 'list', 'old'])?.name, 'api list old');
  assert.equal(findCommand(RC_HELP, ['no', 'such', 'thing']), undefined);
  assert.equal(findCommand(RC_HELP, []), undefined);
});

test('rc：catalog 与 dispatch 双向一致（不漏文档、不漏实现）', async () => {
  const dispatched = await dispatchCases('packages/cli/src/index.ts');
  const documented = new Set(commandNames(RC_HELP));
  for (const name of documented) {
    assert.ok(dispatched.has(name), `catalog 里有 \`rc ${name}\`，但 CLI 没有对应分支`);
  }
  for (const name of dispatched) {
    assert.ok(documented.has(name), `CLI 有 \`rc ${name}\` 分支，但 catalog 里没有（--help 会回落到顶层）`);
  }
});

test('dw：catalog 与 dispatch 双向一致（不漏文档、不漏实现）', async () => {
  const dispatched = await dispatchCases('packages/dw-cli/src/index.ts');
  const documented = new Set(commandNames(DW_HELP));
  for (const name of documented) {
    assert.ok(dispatched.has(name), `catalog 里有 \`dw ${name}\`，但 CLI 没有对应分支`);
  }
  for (const name of dispatched) {
    assert.ok(documented.has(name), `CLI 有 \`dw ${name}\` 分支，但 catalog 里没有（--help 会回落到顶层）`);
  }
});

test('单命令帮助：每条命令都渲染出用法、说明与选项（不是空壳）', () => {
  for (const spec of [RC_HELP, DW_HELP]) {
    for (const c of spec.commands) {
      const text = renderCommandHelp(spec, c);
      assert.ok(text.startsWith(c.usage), `${c.name}: 首行应是用法`);
      assert.ok(text.includes(c.summary), `${c.name}: 应包含一句话说明`);
      if (c.options?.length) {
        for (const o of c.options) assert.ok(text.includes(o.flag), `${c.name}: 选项 ${o.flag} 未渲染`);
      }
      if (c.write) assert.match(text, /dry-run/, `${c.name}: 写操作必须说明 dry-run 语义`);
    }
  }
});

test('单命令帮助：任何命令都不会退化成顶层清单', () => {
  for (const spec of [RC_HELP, DW_HELP]) {
    const top = renderTopHelp(spec);
    for (const c of spec.commands) {
      // 顶层清单里有分组标题行；单命令帮助里不该出现
      assert.equal(renderCommandHelp(spec, c).includes('\n环境与连接:'), false, c.name);
      assert.notEqual(renderCommandHelp(spec, c), top, c.name);
    }
  }
});

test('顶层帮助：按分组渲染、hidden 命令不出现、但 --help 仍可查', () => {
  const rcTop = renderTopHelp(RC_HELP);
  for (const c of RC_HELP.commands) {
    if (c.hidden) {
      assert.equal(rcTop.includes(c.usage), false, `hidden 命令不该出现在顶层清单：${c.name}`);
      assert.ok(findCommand(RC_HELP, c.name.split(' ')) , `hidden 命令仍应可 --help：${c.name}`);
    } else {
      assert.ok(rcTop.includes(c.usage), `顶层清单缺 ${c.name}`);
    }
  }
  // 分组标题按首次出现顺序，且不重复
  const groups = [...new Set(RC_HELP.commands.filter((c) => !c.hidden).map((c) => c.group))];
  for (const g of groups) assert.equal(rcTop.split(`${g}:`).length - 1, 1, `分组标题重复或缺失：${g}`);
});

test('目录数据自身：name 唯一、usage 以 bin 开头、group 非空', () => {
  for (const spec of [RC_HELP, DW_HELP]) {
    const names = commandNames(spec);
    assert.equal(new Set(names).size, names.length, `${spec.bin}: 命令名重复`);
    for (const c of spec.commands) {
      assert.ok(c.usage.startsWith(`${spec.bin} `), `${c.name}: usage 应以 \`${spec.bin} \` 开头`);
      assert.ok(c.group.trim().length > 0, `${c.name}: group 不能为空`);
      assert.ok(c.summary.trim().length > 0, `${c.name}: summary 不能为空`);
    }
  }
});

// ─────────────────────── 文档里的数字不许漂移 ───────────────────────

/**
 * 文档里最容易腐烂的就是数字（节点数/规则数）——改代码时没人会回去数一遍。
 * 这里把"文档写的"和"代码里的事实"对上，漂了就红。
 */
test('文档数字：组件节点数与校验规则数与代码一致', async () => {
  const { readFileSync } = await import('node:fs');
  const components = JSON.parse(readFileSync(join(ROOT, 'catalog/components.json'), 'utf8')) as { nodes: unknown[]; categories: unknown[] };
  const doc = readFileSync(join(ROOT, 'docs/component-context.md'), 'utf8');

  assert.match(doc, new RegExp(`7 大类 / ${components.nodes.length} 个已著录节点`),
    `component-context.md 里的节点数应等于 catalog/components.json 的 ${components.nodes.length}`);
  assert.equal(components.categories.length, 7, 'components.json 的类别数变了，文档也要改');

  const src = readFileSync(join(ROOT, 'packages/core/src/flow-validate.ts'), 'utf8');
  const codes = new Set([...src.matchAll(/code: '([A-Z_]+)'/g)].map((m) => m[1]));
  assert.match(doc, new RegExp(`本地 ${codes.size} 条规则`),
    `component-context.md 里的规则数应等于 flow-validate.ts 里的 ${codes.size} 个规则码`);
});
