/**
 * 统一错误与退出码
 * 契约见 docs/COMMAND-REFERENCE.md
 */

export type RcErrorCode =
  | 'E_AUTH'
  | 'E_PROD_READONLY'
  | 'E_CONFIRM_REQUIRED'
  | 'E_FORBIDDEN'
  | 'E_VALIDATION'
  | 'E_UPSTREAM'
  | 'E_SNAPSHOT'
  | 'E_AUDIT';

const EXIT: Record<RcErrorCode, number> = {
  E_AUTH: 3,
  E_PROD_READONLY: 6,
  E_CONFIRM_REQUIRED: 6,
  E_FORBIDDEN: 6,
  E_VALIDATION: 4,
  E_UPSTREAM: 5,
  E_SNAPSHOT: 5,
  E_AUDIT: 5,
};

/** 每个错误码的**默认**"下一步"。抛错方知道更准确的下一步时，用 `hint` 覆盖。 */
const DEFAULT_NEXT: Record<RcErrorCode, string> = {
  E_AUTH: '请检查 RC_USER/RC_PASS 或 RC_TOKEN，并确认账号未被锁定',
  E_PROD_READONLY: '确认确需写入时设置 RC_ALLOW_PROD_WRITE=1',
  E_CONFIRM_REQUIRED: '请复核 dry-run 预览，确认后追加 --apply（prod 需先设置 RC_ALLOW_PROD_WRITE=1）',
  E_FORBIDDEN: '该操作在当前环境被封禁（未开通对应平台能力）；请改用只读排查手段，不要重试写入',
  E_VALIDATION: '请对照 docs/FLOW-JSON-SPEC.md 修正参数或图结构',
  E_UPSTREAM: '稍后重试；持续失败请用 traceId 查询平台日志',
  E_SNAPSHOT: '写入已中止，未产生变更；请检查快照目录权限',
  E_AUDIT: '审计写入失败，生产环境已阻断；请检查 RC_AUDIT_DIR',
};

export class RcError extends Error {
  readonly code: RcErrorCode;
  readonly detail?: unknown;
  readonly traceId?: string;
  /**
   * 覆盖默认的"下一步"提示。`''` = **不再追加提示**（消息本身已经说完了该做什么）。
   *
   * 为什么需要：默认提示按错误码一刀切，对大多数场景成立，但对**消息已经自带
   * 明确下一步**的场景是错的——`rc sql check` 的只读闸门报错会被追加
   * "请对照 docs/FLOW-JSON-SPEC.md 修正参数或图结构"，把人指向一份与 SQL 无关的文档。
   */
  readonly hint?: string;

  constructor(
    code: RcErrorCode,
    message: string,
    opts: { detail?: unknown; traceId?: string; hint?: string } = {},
  ) {
    super(message);
    this.name = 'RcError';
    this.code = code;
    this.detail = opts.detail;
    this.traceId = opts.traceId;
    this.hint = opts.hint;
  }

  /** CLI 退出码 */
  get exitCode(): number {
    return EXIT[this.code];
  }

  /** 面向用户的一行信息：发生了什么 + 下一步做什么 */
  toUserMessage(): string {
    const next = this.hint ?? DEFAULT_NEXT[this.code];
    return next ? `${this.message}（${this.code}）→ ${next}` : `${this.message}（${this.code}）`;
  }
}

/** 平台响应 → 错误码映射 */
export function classifyHttp(status: number, errcode?: number): RcErrorCode {
  if (status === 401 || status === 403) return 'E_AUTH';
  if (status >= 500 || status === 0) return 'E_UPSTREAM';
  if (errcode && errcode >= 500) return 'E_UPSTREAM';
  return 'E_VALIDATION';
}

/** 键名命中即整值打码。 */
const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|pwd|api[_-]?key|access[_-]?key/i;

/**
 * **值内**的凭据赋值：`password='x'` / `"password"="y"` / `token = abc` / `api_key: z`。
 *
 * 为什么需要这一层：`redact()` 原来只按**键名**打码，所以
 * `{ sql: "CREATE CATALOG ... PROPERTIES(\"password\"=\"s3cret\")" }` 会**原样落盘**——
 * 键名是 `sql`，不敏感，但值里带着密码。审计文件是长期留存的，这条必须堵。
 *
 * 键名后面允许跟一个引号：Doris 的 PROPERTIES 写法是 `"password"="..."`，
 * 键自己是被引号包起来的。
 */
const SENSITIVE_ASSIGN =
  /(\b(?:pass(?:word|wd)?|secret|token|pwd|api[_-]?key|access[_-]?key|private[_-]?key)\b['"]?\s*[:=]\s*)(?:(["'])([^"']*)\2|([^\s'"]+))/gi;

/** `Authorization: Bearer <token>` 这类：方案名要留着，令牌抹掉。 */
const AUTH_HEADER = /(\bauthorization\s*[:=]\s*)(?:\S+\s+)?(\S+)/gi;

/**
 * 把字符串里形如 `password='...'` 的值抹掉，保留键名与引号风格便于排查。
 *
 * 引号内的值**允许含空格**（`password='a b'`），所以带引号与不带引号要分开匹配——
 * 只写 `[^\s'"]+` 会让带空格的口令原样漏出去。
 */
export function scrubSecretsInText(text: string): string {
  return String(text ?? '')
    .replace(SENSITIVE_ASSIGN, (_m, head: string, q: string | undefined) => (q ? `${head}${q}***${q}` : `${head}***`))
    .replace(AUTH_HEADER, (_m, head: string) => `${head}***`);
}

/** 脱敏：日志、审计与错误中不得出现凭据（键名与值内赋值两条都堵） */
export function redact(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redact);
  if (typeof input === 'string') return scrubSecretsInText(input);
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : redact(v);
    }
    return out;
  }
  return input;
}
