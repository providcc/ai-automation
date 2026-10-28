/**
 * 结果集脱敏：列名命中即打码。
 *
 * 为什么要放在通用层：`dw query` 与 `rc sql query` 都是"把真实业务数据打到终端"，
 * 都要防止 Agent 顺手把结果贴进工单/仓库/提交信息。提示语拦不住输出本身，
 * 所以默认就该打码。
 *
 * 与 dw 侧原实现一致（`packages/core/src/dw/query.ts` 的 maskRows），
 * 抽到这里给 rc 复用，避免两套规则漂移。
 */

/** 列名命中即打码：凭据类 + 常见个人信息列。 */
export const SENSITIVE_COLUMN =
  /pass(word|wd)?|secret|token|authorization|cookie|credential|private_key|access_key|phone|mobile|email|id_card|idcard|身份证|手机|邮箱/i;

export interface MaskOptions {
  /** 额外要打码的列（不区分大小写），来自 RC_MASK_COLS / DW_MASK_COLS */
  extraColumns?: string[];
  placeholder?: string;
}

export function isSensitiveColumn(name: string, opts: MaskOptions = {}): boolean {
  const n = String(name);
  if (SENSITIVE_COLUMN.test(n)) return true;
  return (opts.extraColumns ?? []).some((c) => c.toLowerCase() === n.toLowerCase());
}

/**
 * 行级脱敏：只改命中列的值，列顺序与行数不变（便于对拍）。
 * 返回打码过的列名，供调用方告诉用户"哪些列被打了码"。
 */
export function maskRows(
  rows: Record<string, unknown>[],
  opts: MaskOptions = {},
): { rows: Record<string, unknown>[]; maskedColumns: string[] } {
  const ph = opts.placeholder ?? '***';
  const masked = new Set<string>();
  const out = rows.map((row) => {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== undefined && isSensitiveColumn(k, opts)) {
        copy[k] = ph;
        masked.add(k);
      } else {
        copy[k] = v;
      }
    }
    return copy;
  });
  return { rows: out, maskedColumns: [...masked] };
}
