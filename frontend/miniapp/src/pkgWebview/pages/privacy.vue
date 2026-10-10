<script setup lang="ts">
/**
 * 隐私政策（分包 pkgWebview）
 *
 * ⚠ 上线前必须完成：
 *   1. 本文案需与微信公众平台后台填写的《小程序用户隐私保护指引》保持一致
 *   2. 需经法务审核，并明确个人信息处理者的主体名称与联系方式
 *   3. 涉及数据出境（如启用境外模型）时必须补充单独说明并取得单独同意
 */

import { ref } from 'vue';

const updatedAt = ref('2026-02-14');
</script>

<template>
  <view class="privacy page-container">
    <text class="privacy__title">SoulMap AI 隐私政策</text>
    <text class="privacy__updated">更新日期：{{ updatedAt }}</text>

    <view class="privacy__section">
      <text class="privacy__heading">一、我们收集哪些信息</text>
      <text class="privacy__item">· 账号标识：微信用户唯一标识（openid / unionid），用于识别你的账号；</text>
      <text class="privacy__item">· 你主动填写的资料：昵称、头像、性别、年龄段；</text>
      <text class="privacy__item">· 测评与使用数据：你的答题记录、人格测评结果、生成的报告、AI 对话内容；</text>
      <text class="privacy__item">· 设备与日志信息：设备型号、操作系统版本、请求标识，用于故障排查与安全防护。</text>
      <text class="privacy__note">
        我们<text class="privacy__strong">不会</text>收集你的微信密码、支付密码、通讯录、相册内容或位置信息。
      </text>
    </view>

    <view class="privacy__section">
      <text class="privacy__heading">二、我们如何使用这些信息</text>
      <text class="privacy__item">· 完成人格测评算分并生成你的人格画像；</text>
      <text class="privacy__item">· 调用 AI 模型生成个性化解读报告与对话回复；</text>
      <text class="privacy__item">· 在你授权的关系匹配中，将双方画像用于生成关系分析；</text>
      <text class="privacy__item">· 保障服务安全，识别异常请求与滥用行为。</text>
    </view>

    <view class="privacy__section">
      <text class="privacy__heading">三、信息的存储与保护</text>
      <text class="privacy__paragraph">
        你的数据存储于中国境内的云服务器，传输过程使用 HTTPS 加密。 微信会话密钥等敏感字段采用 AES-256-GCM
        加密存储，且不会下发至客户端。 我们通过访问控制、操作审计与最小权限原则限制内部人员对数据的访问。
      </text>
    </view>

    <view class="privacy__section">
      <text class="privacy__heading">四、信息共享与第三方</text>
      <text class="privacy__paragraph">
        为实现 AI 分析能力，你的测评结果与对话内容（不含微信标识与手机号）会发送至大语言模型服务商用于生成内容，
        我们默认使用境内模型服务商。除法律法规要求外，我们不会向其他第三方出售或提供你的个人信息。
      </text>
    </view>

    <view class="privacy__section">
      <text class="privacy__heading">五、你的权利</text>
      <text class="privacy__item">· 查阅与更正：可在「我的」页面查看并修改昵称、头像等资料；</text>
      <text class="privacy__item">· 数据导出：可申请导出你的个人数据副本；</text>
      <text class="privacy__item">· 删除与注销：可申请注销账号，我们将在冷静期后删除或匿名化你的个人信息；</text>
      <text class="privacy__item">· 撤回同意：可随时停止使用本服务并注销账号。</text>
    </view>

    <view class="privacy__section">
      <text class="privacy__heading">六、未成年人保护</text>
      <text class="privacy__paragraph">
        本服务面向成年用户。未满 18 周岁的用户不应使用关系匹配与付费功能。
        若我们发现在未获得监护人同意的情况下收集了未成年人信息，将尽快删除相关数据。
      </text>
    </view>

    <view class="privacy__section">
      <text class="privacy__heading">七、联系我们</text>
      <text class="privacy__paragraph">
        如对本政策有疑问，或需要行使上述权利，可通过小程序内「我的」页面提供的客服渠道与我们联系， 我们将在 15
        个工作日内答复。
      </text>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.privacy {
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

  &__item {
    display: block;
    margin-bottom: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__paragraph {
    display: block;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
  }

  &__note {
    display: block;
    padding: $space-sm $space-md;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-regular;
    background-color: $color-bg-hover;
    border-radius: $radius-md;
  }

  &__strong {
    font-weight: $font-weight-bold;
    color: $color-secondary;
  }
}
</style>
