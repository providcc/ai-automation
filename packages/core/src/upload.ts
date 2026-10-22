/**
 * WP9.4 multipart 上传通道（WSDL / Excel / 证书 / 脚本包）
 * 平台前端有 88 处 FormData 提交，REST 客户端无法覆盖，故单列
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { RestCloudClient } from './client.ts';
import { RcError } from './errors.ts';

export interface UploadOptions {
  /** 表单文件名（后端字段名），默认 file */
  field?: string;
  /** 附加表单字段 */
  fields?: Record<string, string | number>;
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface UploadResult {
  ok: boolean;
  status: number;
  msg?: string;
  traceId?: string;
  data?: unknown;
  dryRun?: boolean;
}

/** 按扩展名推断 MIME（平台附件解析用） */
export function mimeOf(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml',
    xml: 'application/xml', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
    pdf: 'application/pdf', zip: 'application/zip',
    wsdl: 'text/xml', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pem: 'application/x-pem-file', crt: 'application/x-x509-ca-cert', cer: 'application/x-x509-ca-cert',
    p12: 'application/x-pkcs12', jks: 'application/octet-stream', key: 'application/octet-stream',
  };
  return map[ext] ?? 'application/octet-stream';
}

export async function uploadFile(
  client: RestCloudClient,
  path: string,
  filePath: string,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  if (client.readOnly) {
    throw new RcError('E_PROD_READONLY', 'prod 只读：上传属于写操作，需 RC_ALLOW_PROD_WRITE=1 且 --apply');
  }
  const buf = await readFile(filePath);
  if (buf.byteLength > 20 * 1024 * 1024) {
    throw new RcError('E_VALIDATION', `文件过大（${(buf.byteLength / 1048576).toFixed(1)}MB），平台上限通常 20MB`);
  }
  const field = opts.field ?? 'file';
  if (opts.dryRun) {
    return {
      ok: true,
      status: 0,
      dryRun: true,
      msg: `dry-run：将上传 ${basename(filePath)}（${buf.byteLength}B）到 ${path}，字段 ${field}`,
      data: { fields: opts.fields },
    };
  }

  const form = new FormData();
  // 带 MIME 类型：平台按扩展名/类型解析附件（wsdl/xlsx/证书等），空类型可能被拒
  form.append(field, new Blob([buf], { type: mimeOf(filePath) }), basename(filePath));
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, String(v));

  // upload 直接走 fetch，不经过 client.request 的 401 重授权；先触发一次认证。
  if (Object.keys(client.exportCookies()).length === 0) {
    await client.request('/rest/base/users/context', { method: 'GET' });
  }

  const url = client.baseUrl + path;
  const cookie = Object.entries(client.exportCookies()).map(([k, v]) => `${k}=${v}`).join('; ');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const resp = await fetch(url, { method: 'POST', headers: { Cookie: cookie }, body: form, signal: controller.signal });
    const text = await resp.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
    return { ok: resp.ok && data?.state !== false, status: resp.status, msg: data?.msg, traceId: data?.traceId, data };
  } catch (e) {
    throw new RcError('E_UPSTREAM', `上传失败：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
