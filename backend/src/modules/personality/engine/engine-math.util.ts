/**
 * 引擎数学辅助函数 —— **转发到通用实现**（`common/engine/engine-math.util.ts`）
 *
 * ## 为什么把实现搬走了
 *
 * 这些函数（`clamp` / `normalizeToUnit` / `mean` / `roundTo`）从来不是人格模块专有的：
 * 匹配引擎（本目录的 `compatibility-engine.service.ts`）早就在用，
 * 情感模块同样需要。原先它们住在 `personality/engine/` 下，导致
 * `common/engine/assessment-quality.util.ts` 必须**反向依赖** `modules/personality` ——
 * `common` 本该是依赖图的叶子，反向依赖会让"谁都可以用 common"这个前提失效。
 *
 * 因此实现迁移到 `common/engine/`，本文件只做**再导出**，既有 import 路径零改动。
 * 本目录的 `engine-math.util.spec.ts` 同样搬到了新位置（避免同一份实现有两条测试路径）。
 */

export { clamp, mean, normalizeToUnit, roundTo } from '../../../common/engine/engine-math.util';
