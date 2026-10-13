/**
 * 订阅消息的「权威模板 ID」与配置目录的一致性（契约 §3.11.3 规则 3）
 *
 * ## 为什么需要这条守卫
 *
 * 服务端按 `notify.template.{scene}` 读权威模板 ID，**读不到就回落到客户端上报值**
 * （`notification.service.ts` 的 `resolveAuthoritativeTemplateId`）。回落本身有告警日志，
 * 但后果是实打实的：任何人伪造一个模板 ID 就能把用户授权的额度"存"到一个
 * 永远不会被发送的场景上。
 *
 * 这个键是**拼出来的**（`sceneTemplateConfigKey`），所以"目录里有没有这一条"
 * 不会被类型系统发现 —— 新增一个订阅场景却忘了在目录里登记，表现就是该场景
 * 永远静默回落，而且后台连这一行都列不出来、运营无从修复。
 * 实测缺陷正是如此：6 个场景全部不在目录里，`system_configs` 也一行没有，
 * 于是"服务端以 `scene` 映射权威模板"这条契约规则**从未生效过**。
 *
 * ## 依赖方向
 *
 * 这里由 notification 模块 import system 模块的目录，是**单向**的
 * （notification 本来就依赖 system 读配置）。反过来在目录里 import 场景枚举
 * 会构成双向依赖，那正是交接文档 §6.3 第 15 条记录过的「整个后端起不来」的故障形态，
 * 因此目录侧宁可逐条写死 6 个键。
 */

import { CONFIG_DEFINITION_MAP } from '../system/system-config.catalog';
import { SUBSCRIPTION_SCENES, sceneTemplateConfigKey } from './notification.util';

describe('订阅消息模板 ID 的配置目录一致性', () => {
  it('【关键】每个订阅场景都在配置目录里有对应的权威模板键', () => {
    const missing = SUBSCRIPTION_SCENES.filter((scene) => !CONFIG_DEFINITION_MAP.has(sceneTemplateConfigKey(scene)));

    expect(missing).toEqual([]);
  });

  it('这些键必须存在，且是「后台可改但不公开」的形态', () => {
    for (const scene of SUBSCRIPTION_SCENES) {
      const definition = CONFIG_DEFINITION_MAP.get(sceneTemplateConfigKey(scene));

      // 模板 ID 属环境相关的运营配置：不是给用户看的文案，不得出现在公开配置接口里
      expect({ scene, isPublic: definition?.isPublic }).toEqual({ scene, isPublic: false });

      // 【关键】默认值必须是空串。模板 ID 每套小程序账号各不相同；目录里预置一个假值
      // 会让库中出现的该行**覆盖**客户端送来的真值，线上通知全部发不出去。
      // 空串在 `readConfiguredTemplateId` 里被判为"未配置"，维持现状直到运营填真值。
      expect({ scene, defaultValue: definition?.defaultValue }).toEqual({ scene, defaultValue: '' });
    }
  });

  it('键名格式固定为 notify.template.{scene}（与 Service 的读取键同一来源）', () => {
    expect(sceneTemplateConfigKey('REPORT_READY')).toBe('notify.template.REPORT_READY');
  });
});
