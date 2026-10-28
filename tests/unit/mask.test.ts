import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskRows, isSensitiveColumn } from '../../packages/core/src/mask.ts';

test('maskRows：凭据类与个人信息列默认打码', () => {
  const rows = [
    { id: 1, password: 'p1', access_token: 't1', phone: '13800000000', name: '张三' },
  ];
  const { rows: out, maskedColumns } = maskRows(rows);
  assert.equal(out[0].password, '***');
  assert.equal(out[0].access_token, '***');
  assert.equal(out[0].phone, '***');
  assert.equal(out[0].name, '张三', '普通列不该被打码');
  assert.equal(out[0].id, 1);
  assert.deepEqual(maskedColumns.sort(), ['access_token', 'password', 'phone']);
});

test('maskRows：列顺序与行数不变（便于对拍）', () => {
  const rows = [{ a: 1, token: 'x', b: 2 }, { a: 3, token: 'y', b: 4 }];
  const { rows: out } = maskRows(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(Object.keys(out[0]), Object.keys(rows[0]));
  assert.deepEqual(Object.keys(out[1]), Object.keys(rows[1]));
});

test('maskRows：RC_MASK_COLS 追加的列也要打码（不区分大小写）', () => {
  const { rows: out, maskedColumns } = maskRows(
    [{ user_name: 'bob', remark: 'ok' }],
    { extraColumns: ['USER_NAME'] },
  );
  assert.equal(out[0].user_name, '***');
  assert.equal(out[0].remark, 'ok');
  assert.deepEqual(maskedColumns, ['user_name']);
});

test('maskRows：null / undefined 的值不打码（避免把"没这个值"变成 ***）', () => {
  const { rows: out } = maskRows([{ token: null, password: undefined }]);
  assert.equal(out[0].token, null);
  assert.equal(out[0].password, undefined);
});

test('isSensitiveColumn：中文列名（手机/邮箱/身份证）也要命中', () => {
  assert.equal(isSensitiveColumn('手机号'), true);
  assert.equal(isSensitiveColumn('邮箱'), true);
  assert.equal(isSensitiveColumn('身份证'), true);
  assert.equal(isSensitiveColumn('款号'), false);
});
