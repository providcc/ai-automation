/**
 * `sensitive-scan.mjs` 的类型声明。
 *
 * 扫描器刻意保留 `.mjs`（裸 `node` 就能跑，不依赖 `--experimental-strip-types`）——
 * 安全工具要尽量"随便怎么调都能跑"。但单测是 TS，需要一个声明文件才能拿到类型。
 * 手写声明而非把脚本改成 `.ts`，就是为了不动这个前提。
 */

export interface ScanHit {
  file: string;
  /** 命中行号；`0` 表示命中的是**文件名**本身 */
  line: number;
  kind: '通用特征' | '词表命中' | '文件名命中';
  /** 命中的片段原文 */
  what: string;
  /** 所在行（截断到 160 字符） */
  text: string;
}

export interface Matchers {
  generic: RegExp;
  word: RegExp | undefined;
}

export type ScanMode = 'publishable' | 'tracked' | 'staged';

/** 通用特征（已拆开拼，避免自指）。 */
export const FRAGMENTS: string[];
/** 路径豁免名单：只允许扫描器自身与它自己的单测。 */
export const SKIP_PATHS: string[];

export function escapeRe(s: string): string;
export function listFiles(mode: ScanMode): string[];
/** `--dir` 模式：走目录树，不走 git。 */
export function listFilesInDir(dir: string): string[];
/** 历史里的一个 blob（按 sha 去重）。 */
export interface HistoryBlob {
  path: string;
  text: string;
  sha: string;
}
export function listHistoryBlobs(opts?: { maxBytes?: number }): HistoryBlob[];
export function loadWords(env?: Record<string, string | undefined>): string[];
export function buildMatchers(words?: string[]): Matchers;
export function scanText(text: string, file: string, matchers: Matchers): ScanHit[];
export function scanFile(file: string, matchers: Matchers): ScanHit[];
export function scanFiles(files: string[], matchers: Matchers): ScanHit[];
export function parseArgs(argv: string[]): { mode: ScanMode; quiet: boolean; dir?: string; history: boolean };
export function runScan(opts?: {
  mode?: ScanMode;
  quiet?: boolean;
  env?: Record<string, string | undefined>;
  /** 走目录树而不是 git */
  dir?: string;
  /** 扫 git 历史里出现过的全部 blob（不只是当前工作树） */
  history?: boolean;
  /** 测试注入口：直接给定文件列表，跳过 git */
  files?: string[];
  /** 测试注入口：直接给定命中，跳过读盘 */
  hits?: ScanHit[];
}): { code: number; out: string[]; err: string[] };
export function main(argv?: string[], env?: Record<string, string | undefined>): number;
