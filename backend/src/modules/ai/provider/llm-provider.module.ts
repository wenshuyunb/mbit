/**
 * LLM Provider 的**独立出口模块**
 *
 * ## 为什么要单独成模块
 *
 * `LlmProviderFactory` 之前只由 `AiModule` 提供与导出。星盘解读也需要调用模型，
 * 但它属于 `ZodiacModule`，而 ZodiacModule 有一条明确的纪律：
 * **imports 列表要窄**（ADR-038：星座模块与三个测评模块完全隔离，
 * 只允许依赖 Prisma / SystemConfig / Membership 这类基础设施）。
 *
 * 直接 `import { AiModule }` 会把报告、AI 助手、分享卡等一整套业务服务
 * 拉进星座模块的模块图里 —— 功能上不会报错，但那份"窄 imports"清单就失去意义了
 * （而那份清单正是 review 时的第一道警报）。
 *
 * 因此把 Provider 抽成一个只含基础设施的模块：
 *   · `AiModule` 导入它（保持**同一个实例**，不会出现两套退避状态）；
 *   · `ZodiacModule` 只导入它，拿到的也是同一个实例。
 *
 * ⚠ 不要把本模块做成 `@Global()`：Provider 的可用性取决于配置，
 * 隐式全局会让"某处悄悄调用了模型"变得难以排查。
 */

import { Module } from '@nestjs/common';

import { LlmProviderFactory } from './llm-provider.factory';

@Module({
  providers: [LlmProviderFactory],
  exports: [LlmProviderFactory],
})
export class LlmProviderModule {}
