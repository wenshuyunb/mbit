<script setup lang="ts">
/**
 * 用户协议（分包 pkgWebview）
 *
 * ⚠ 上线前必须完成：本页文案需经法务审核，并同步到微信公众平台
 *   「小程序用户隐私保护指引」。当前内容为结构化初稿，覆盖必备条款骨架。
 */

import { ref } from 'vue';

const updatedAt = ref('2026-02-14');
</script>

<template>
  <view class="legal page-container">
    <text class="legal__title">SoulMap AI 用户协议</text>
    <text class="legal__updated">更新日期：{{ updatedAt }}</text>

    <view class="legal__section">
      <text class="legal__heading">一、服务说明</text>
      <text class="legal__paragraph">
        SoulMap AI（以下简称「本服务」）是一款基于人格测评理论（MBTI、大五人格）与人工智能技术的情感成长工具，
        通过微信小程序为你提供人格测评、AI 解读报告、关系匹配分析与 AI 情感陪伴对话。
      </text>
      <text class="legal__paragraph">
        本服务定位为自我探索与情感成长的辅助工具，<text class="legal__strong"
          >不构成心理诊断、医疗建议、 心理咨询或任何形式的专业意见</text
        >。如你正在经历持续的情绪困扰，请及时寻求专业心理服务机构或医疗机构的帮助。
      </text>
    </view>

    <view class="legal__section">
      <text class="legal__heading">二、账号与登录</text>
      <text class="legal__paragraph">
        你通过微信授权登录本服务。我们仅获取用于识别账号所必需的信息（微信用户唯一标识），
        不会保存你的微信密码或支付密码。
      </text>
    </view>

    <view class="legal__section">
      <text class="legal__heading">三、用户行为规范</text>
      <text class="legal__paragraph">你承诺不会利用本服务从事以下行为：</text>
      <text class="legal__paragraph">1. 发布违法违规、侵犯他人合法权益的内容；</text>
      <text class="legal__paragraph">2. 未经他人同意，将他人的人格测评结果用于公开传播或商业用途；</text>
      <text class="legal__paragraph">3. 使用自动化脚本批量注册、刷取 AI 服务次数或干扰服务正常运行；</text>
      <text class="legal__paragraph">4. 对本服务进行反向工程、爬取数据或尝试获取未授权的接口权限。</text>
    </view>

    <view class="legal__section">
      <text class="legal__heading">四、AI 生成内容</text>
      <text class="legal__paragraph">
        AI 生成的分析报告与对话内容由大语言模型基于你提供的信息生成，可能存在不准确或不适用于你的情况，
        请结合自身实际理性看待，不要将其作为重大人生决策的唯一依据。
      </text>
      <text class="legal__paragraph">
        当你表达自伤、他伤或医疗相关诉求时，本服务将停止常规生成流程并提供关怀提示与求助资源信息。
      </text>
    </view>

    <view class="legal__section">
      <text class="legal__heading">五、付费服务</text>
      <text class="legal__paragraph">
        本服务的付费项目（深度报告、会员服务、AI 对话次数包）价格以小程序内展示为准。
        虚拟内容一经解锁或权益一经发放，除法律法规另有规定外不支持退款。
      </text>
    </view>

    <view class="legal__section">
      <text class="legal__heading">六、协议变更与终止</text>
      <text class="legal__paragraph">
        我们可能根据法律法规或业务调整更新本协议。协议更新后，我们会在小程序内以显著方式提示；
        若你继续使用本服务，视为接受更新后的协议。你可以随时通过「我的 - 注销账号」终止本协议并删除账号数据。
      </text>
    </view>

    <view class="legal__section">
      <text class="legal__heading">七、联系我们</text>
      <text class="legal__paragraph"> 如对本协议有任何疑问，可通过小程序内「我的」页面提供的客服渠道与我们联系。 </text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.legal {
  padding-bottom: $space-xxl;

  &__title {
    display: block;
    font-size: $font-size-xl;
    font-weight: $font-weight-bold;
  }

  &__updated {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__section {
    margin-top: $space-lg;
  }

  &__heading {
    display: block;
    margin-bottom: $space-sm;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__paragraph {
    display: block;
    margin-bottom: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__strong {
    font-weight: $font-weight-semibold;
    color: $color-text-primary;
  }
}
</style>
