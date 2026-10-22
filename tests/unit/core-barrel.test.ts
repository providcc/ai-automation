/**
 * core 桶文件（packages/core/src/index.ts）单测：导出面必须稳定。
 * 这是给 Agent / CLI 的公共契约面，漏导出等于功能缺失。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../packages/core/src/index.ts';
import { maskDataSource } from '../../packages/core/src/datasource.ts';
import { summary } from '../../packages/core/src/monitor.ts';
import { opsSummary } from '../../packages/core/src/operations.ts';
import { tableLineage } from '../../packages/core/src/lineage.ts';
import { doctor } from '../../packages/core/src/doctor.ts';

test('桶文件：导出核心类型与工厂函数', () => {
  assert.equal(typeof core.RestCloudClient, 'function');
  assert.equal(typeof core.createClient, 'function');
  assert.equal(typeof core.Catalog, 'function');
  assert.equal(typeof core.RcError, 'function');
  assert.equal(typeof core.classifyHttp, 'function');
  assert.equal(typeof core.redact, 'function');
});

test('桶文件：导出数据源域接口与端点常量', () => {
  assert.equal(typeof core.listDataSources, 'function');
  assert.equal(typeof core.listAllDataSources, 'function');
  assert.equal(typeof core.getDataSource, 'function');
  assert.equal(typeof core.testDataSourceConnection, 'function');
  assert.equal(typeof core.saveDataSource, 'function');
  assert.equal(typeof core.maskDataSource, 'function');
  assert.equal(core.DATASOURCE.list, '/rest/core/datasource/list');
  assert.equal(core.DATASOURCE.testConnect, '/rest/core/datasource/test/connect');
});

test('桶文件：导出监控与运营域接口', () => {
  assert.equal(typeof core.summary, 'function');
  assert.equal(typeof core.serviceLogs, 'function');
  assert.equal(core.MONITOR.apis, '/rest/core/apimonitor/apis');
  assert.equal(typeof core.assessList, 'function');
  assert.equal(typeof core.assessReport, 'function');
  assert.equal(typeof core.appReport, 'function');
  assert.equal(typeof core.opsSummary, 'function');
  assert.equal(core.OPS.assessList, '/rest/operation/assess/api/list/page');
});

test('桶文件：导出血缘与 doctor 接口', () => {
  assert.equal(typeof core.tableLineage, 'function');
  assert.equal(typeof core.datasourceLineage, 'function');
  assert.equal(typeof core.appRelationship, 'function');
  assert.equal(typeof core.apiCallRelation, 'function');
  assert.equal(typeof core.metaTableLineage, 'function');
  assert.equal(typeof core.deepImpactOfApi, 'function');
  assert.equal(typeof core.impactByApiId, 'function');
  assert.equal(core.LINEAGE.tableIn, '/rest/etl/relationship/tables/in');
  assert.equal(typeof core.doctor, 'function');
  assert.equal(typeof core.formatDoctor, 'function');
});

test('桶文件：导出流程、目录与快照相关接口', () => {
  assert.equal(typeof core.buildProcessModel, 'function');
  assert.equal(typeof core.validateFlow, 'function');
  assert.equal(typeof core.hasBlockingError, 'function');
  assert.equal(typeof core.unwrapRows, 'function');
  assert.equal(typeof core.normalizeBundle, 'function');
  assert.equal(typeof core.computeCatalogFingerprint, 'function');
  assert.equal(typeof core.writeFingerprint, 'function');
  assert.equal(typeof core.readFingerprint, 'function');
  assert.equal(typeof core.diffFingerprints, 'function');
  assert.equal(typeof core.snapshot, 'function');
  assert.equal(typeof core.restore, 'function');
  assert.equal(typeof core.explainError, 'function');
  assert.equal(typeof core.formatExplain, 'function');
});

test('桶文件：导出的是同一模块实例（不是副本）', () => {
  assert.equal(core.maskDataSource, maskDataSource);
  assert.equal(core.summary, summary);
  assert.equal(core.opsSummary, opsSummary);
  assert.equal(core.tableLineage, tableLineage);
  assert.equal(core.doctor, doctor);
});

test('桶文件：导出面没有未定义项', () => {
  for (const [name, value] of Object.entries(core)) {
    assert.notEqual(value, undefined, `导出 ${name} 为 undefined`);
  }
  assert.ok(Object.keys(core).length > 50, `导出数量异常：${Object.keys(core).length}`);
});
