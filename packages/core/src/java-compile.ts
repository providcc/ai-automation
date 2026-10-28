/**
 * Java 代码节点（javaCodeNode）的编译。
 *
 * 平台实测（2026-10）：
 *   - 节点属性里的 `code` 只是**源码副本**（存在属性表里）；真正被运行时装载的是
 *     **编译产物**。属性改了、库里的 code 也对了，运行起来可能仍是旧逻辑——
 *     因为编译产物落在**服务器本地磁盘**，不在这张表里。
 *   - 所以「保存」和「编译」是两件事，前端把两者做成一个复合动作：
 *     `core/components/EditJavaCode.jsx` 的 `saveCompile()` 先 POST 编译检查，
 *     **通过之后**才调 `saveEditCode` 落属性；编译失败就只弹错误、不保存。
 *   - 编译需要三步，缺一不可：
 *       ① `POST /rest/core/coderepository/srcfile/overcode/classpath`
 *          —— 把源码写到服务器磁盘
 *          `<tomcat>/WEB-INF/src/main/java/<package path>/<Class>.java`
 *       ② `POST /rest/esb/coderepository/compile/check`
 *          —— 真实 javac 编译（ESB 侧专用端点，core 侧的
 *          `/rest/core/coderepository/compile/check` 同样可用）
 *       ③ 节点属性保存（`flow props save`）
 *     只做 ② 会编译服务器上**旧**的源文件；只做 ①③ 不编译则永远不生效。
 *   - `classPath` 不是平台生成的，而是从源码文本解析出来的：
 *     `package a.b;` + `public class C` → `a.b.C`。
 *     前端算法见 `EditJavaCode.jsx` 的 `getClassPath()`，这里照搬同一套规则。
 *   - 编译失败时平台返回的 `msg` 是 **URL 编码的 javac 报错**（含行号列号），
 *     前端要 `decodeURIComponent` 之后才给人看；不解码的话全是 `%E4%BB%A3...`。
 *   - 多实例部署下各实例的编译产物可能不一致：源码写到了实例 A，
 *     请求却落到实例 B 时就会命中旧类。工具只能保证"写 + 编译"都发出去了，
 *     跨实例一致性要人工确认。
 */

import type { RestCloudClient, ApiResult } from './client.ts';
import { RcError } from './errors.ts';

/** 从源码解析 classPath：`package a.b;` + `public class C` → `a.b.C`。 */
export function parseJavaClassPath(code: string): string | undefined {
  const src = String(code ?? '');
  const pkgMatch = /package\s+([\w.]+)\s*;/.exec(src);
  // class 前可能有修饰符（final / abstract / static …），要能跳过
  const clsMatch = /\bclass\s+(\w+)/.exec(src);
  if (!pkgMatch || !clsMatch) return undefined;
  return `${pkgMatch[1]}.${clsMatch[1]}`;
}

/**
 * javac 报错在平台返回里是 URL 编码的 HTML 片段。
 * 解码后仍有 `<br>` 这类标签，替成换行，Agent 才读得懂。
 */
export function decodeCompilerMessage(msg: string | undefined): string {
  const raw = String(msg ?? '').trim();
  if (!raw) return '';
  let text = raw;
  try {
    text = decodeURIComponent(text);
  } catch {
    // 不是合法百分号编码就按原文用（平台偶尔直接给中文）
  }
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface JavaCompileResult {
  ok: boolean;
  /** 解析出的 classPath */
  classPath?: string;
  /** 源码是否已写到服务器磁盘 */
  written: boolean;
  /** 编译是否通过 */
  compiled: boolean;
  /** 编译失败时的 javac 报错（已解码） */
  compileError?: string;
  /** 平台原始消息 */
  msg?: string;
  traceId?: string;
}

/**
 * 一个流程里所有 javaCodeNode 的编译状态。
 */
export interface JavaNodeCompileReport {
  /** 每个待编译节点的节点号 */
  nodeIds: string[];
  /** 逐个节点的编译结果 */
  results: Array<{ nodeId: string } & JavaCompileResult>;
  /** 全部成功才为 true */
  ok: boolean;
}

/** 从节点属性里挑出"带 code 的 javaCodeNode"。 */
export function javaNodesWithCode(
  nodeProps: Array<{ nodeId: string; nodeType?: string; props?: Record<string, unknown> }>,
): Array<{ nodeId: string; code: string }> {
  return (nodeProps ?? [])
    .filter((n) => (n.nodeType ?? '') === 'javaCodeNode')
    .map((n) => ({ nodeId: n.nodeId, code: String((n.props ?? {}).code ?? '') }))
    .filter((n) => n.code.trim().length > 0);
}

/**
 * 批量编译流程里的 Java 节点。
 *
 * 逐个编译、**不中断**：一个节点编译失败不影响其它节点，
 * 但整体 `ok` 为 false，调用方据此决定要不要中断后续保存。
 */
export async function compileJavaNodes(
  c: RestCloudClient,
  input: { nodeProps: Array<{ nodeId: string; nodeType?: string; props?: Record<string, unknown> }>; dryRun?: boolean },
): Promise<JavaNodeCompileReport> {
  const targets = javaNodesWithCode(input.nodeProps ?? []);
  const results: Array<{ nodeId: string } & JavaCompileResult> = [];
  for (const t of targets) {
    const r = await compileJavaCode(c, { code: t.code, dryRun: input.dryRun });
    results.push({ nodeId: t.nodeId, ...r });
  }
  return {
    nodeIds: targets.map((t) => t.nodeId),
    results,
    ok: results.every((r) => r.ok),
  };
}

/**
 * 编译一个 Java 节点。
 *
 * 顺序固定为 **写源文件 → 编译**：顺序反了会编译服务器上的旧源码。
 * 编译失败时**不再往下走**（不返回"保存"动作），由调用方决定要不要把
 * 坏代码写进属性——默认不写。
 */
export async function compileJavaCode(
  c: RestCloudClient,
  input: { code: string; dryRun?: boolean },
): Promise<JavaCompileResult> {
  const code = String(input.code ?? '');
  const classPath = parseJavaClassPath(code);
  if (!classPath) {
    throw new RcError(
      'E_VALIDATION',
      '无法从源码解析 classPath：需要同时包含 `package <包名>;` 和 `public class <类名>`。',
      { hint: '平台上编译依赖 classPath 定位源文件；先确认源码头部这两行写全了。' },
    );
  }
  const dry = input.dryRun ?? false;
  const body = { classPath, code };

  // ① 写源文件到服务器磁盘
  const written = await c.request('/rest/core/coderepository/srcfile/overcode/classpath', {
    method: 'POST', body, dryRun: dry,
  });
  if (!written.ok) {
    return {
      ok: false, classPath, written: false, compiled: false,
      msg: written.msg, traceId: written.traceId,
    };
  }

  // ② 编译（ESB 侧端点）
  const compiled = await c.request('/rest/esb/coderepository/compile/check', {
    method: 'POST', body, dryRun: dry,
  });
  if (!compiled.ok) {
    return {
      ok: false, classPath, written: true, compiled: false,
      compileError: decodeCompilerMessage(compiled.msg),
      msg: compiled.msg, traceId: compiled.traceId,
    };
  }
  return {
    ok: true, classPath, written: true, compiled: true,
    msg: compiled.msg, traceId: compiled.traceId,
  };
}
