<script setup lang="ts">
/**
 * 我的本命星盘（分包 pkgZodiac）
 *
 * ## 这一页在卖什么
 *
 * 星座运势那一层只用**太阳星座**（出生日期决定的那个），是本模块最浅的一层。
 * 星盘是专业用户真正在意的东西：同一个太阳星座的人，星盘可以完全不同 ——
 * 十大行星各在什么星座什么度数、上升点（ASC）与天顶（MC）、十二宫、相互相位、
 * 元素与宫位的分布。这才是"准不准"之外的**信息量**差别。
 *
 * ## 页面结构（阅读顺序：先给结论，再给细节，最后给解释）
 *
 *   ① 三巨头卡（太阳 / 月亮 / 上升）—— 所有人可见，一眼就知道"这张盘是谁的"
 *   ② 出生信息不全 → 补全卡（时间 + 出生城市），并**说明为什么必须要**
 *   ③ 会员：完整盘（行星表 / 十二宫 / 相位 / 分布 / 命主星）
 *      非会员：解锁引导（列出会员能看到什么，而不是把内容糊掉）
 *   ④ 精度说明 + 合规声明（均由服务端下发）
 *
 * ## 三条前端纪律
 *
 *   ① **不做任何本地计算**：星座、度数、宫位、相位全部来自服务端。前端一旦"顺手"
 *      算一下，就会出现前端显示狮子、后端显示处女这类无法解释的矛盾；
 *   ② **打码式隐藏不允许**：非会员的 `chart` 后端**根本不返回**，前端只渲染 `preview`。
 *      不要为了"占位好看"去伪造一个空壳盘；
 *   ③ 提示语与声明**原样展示**：`noTimeNotice` / `noPlaceNotice` / `precisionNote` /
 *      `disclaimer` 都是服务端下发的，前端不得改写或省略。
 */

import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';

import { getNatalChart, searchBirthCities, type BirthCity, type ZodiacChart } from '@/api/zodiac';
import { http } from '@/api/request';
import { ApiError, ERROR_CODES } from '@/api/types';

const loading = ref(true);
const loadError = ref('');
/** 未设置出生日期（后端 `30019`）：此时页面只展示"先选生日"的引导 */
const needsBirthday = ref(false);
const data = ref<ZodiacChart | null>(null);

/** 出生城市选择器 */
const cityKeyword = ref('');
const cityOptions = ref<BirthCity[]>([]);
const cityPanelOpen = ref(false);
const saving = ref(false);

const chart = computed(() => data.value?.chart ?? null);
const preview = computed(() => data.value?.preview ?? null);
const access = computed(() => data.value?.access ?? null);

/** 缺什么就提示什么（两条提示可能同时出现：既没时间也没城市） */
const notices = computed<string[]>(() => {
  const list: string[] = [];

  if (chart.value?.noTimeNotice) list.push(chart.value.noTimeNotice);
  if (chart.value?.noPlaceNotice) list.push(chart.value.noPlaceNotice);

  // 非会员时后端不返回 chart，提示语藏在 preview 的 hasBirthTime/hasBirthPlace 里
  if (chart.value === null && preview.value !== null) {
    if (!preview.value.hasBirthTime) {
      list.push('补上出生时间，就能解锁上升星座与十二宫（上升星座约每 2 小时换一个，没有时间就没有答案）。');
    }
    if (!preview.value.hasBirthPlace) {
      list.push('补上出生城市，才能算出上升星座 —— 中国东西两端的地方时相差 4 个多小时，按固定城市猜会错一个星座。');
    }
  }

  return list;
});

/** 出生时间选择器（`HH:mm`），默认 12:00 */
const timeDraft = ref('12:00');

/** 按 key 取行星位置（**不用数组下标**：顺序一变，太阳月亮就会互换，而且看不出错） */
const bodyOf = (key: string) => chart.value?.positions.find((item) => item.key === key) ?? null;

const ascendantOf = () => chart.value?.angles.ascendant ?? null;

onLoad(() => {
  void bootstrap();
});

const bootstrap = async (): Promise<void> => {
  loading.value = true;
  loadError.value = '';

  try {
    data.value = await getNatalChart();
    needsBirthday.value = false;
    timeDraft.value = data.value.birthInfo.birthTime ?? '12:00';
  } catch (error) {
    if (error instanceof ApiError && error.code === ERROR_CODES.ZODIAC_BIRTHDAY_REQUIRED) {
      needsBirthday.value = true;
      return;
    }

    console.error('[zodiac] 星盘加载失败：', error);
    loadError.value = '加载失败，请稍后再试';
  } finally {
    loading.value = false;
  }
};

/** 保存出生时间（走统一的用户资料接口，而不是本模块自己写库） */
const saveTime = async (): Promise<void> => {
  if (saving.value) return;

  saving.value = true;
  try {
    await http.patch('/users/me', { birthTime: timeDraft.value });
    uni.showToast({ title: '已记住出生时间', icon: 'none' });
    await bootstrap();
  } catch (error) {
    console.error('[zodiac] 保存出生时间失败：', error);
    uni.showToast({ title: '保存失败，请稍后再试', icon: 'none' });
  } finally {
    saving.value = false;
  }
};

const onTimeChange = (event: { detail: { value: string } }): void => {
  timeDraft.value = event.detail.value;
};

/** 搜索框回车（模板里不做类型断言：小程序模板编译器对 `as` 支持不一致） */
const onCitySearchConfirm = (event: { detail: { value: string } }): void => {
  void searchCity(event.detail.value);
};

/** 打开出生城市选择器并拉热门城市 */
const openCityPanel = async (): Promise<void> => {
  cityPanelOpen.value = true;

  if (cityOptions.value.length === 0) {
    await searchCity('');
  }
};

const searchCity = async (keyword: string): Promise<void> => {
  cityKeyword.value = keyword;

  try {
    cityOptions.value = await searchBirthCities(keyword);
  } catch (error) {
    console.error('[zodiac] 城市搜索失败：', error);
    cityOptions.value = [];
  }
};

/**
 * 选中出生城市
 *
 * ⚠ 四个字段**一起提交**：城市名只是给人看的，经纬度才是算上升星座的依据。
 * 只存城市名的话，后端少了经度就算不出恒星时 —— 那种"存了个看起来对的值、
 * 结果算不出来"的数据最难排查。
 */
const pickCity = async (city: BirthCity): Promise<void> => {
  if (saving.value) return;

  saving.value = true;
  try {
    await http.patch('/users/me', {
      birthPlace: city.name,
      birthLatitude: city.latitude,
      birthLongitude: city.longitude,
      birthTimezoneOffset: city.timezoneOffset,
    });
    cityPanelOpen.value = false;
    uni.showToast({ title: `出生地已设为${city.name}`, icon: 'none' });
    await bootstrap();
  } catch (error) {
    console.error('[zodiac] 保存出生城市失败：', error);
    uni.showToast({ title: '保存失败，请稍后再试', icon: 'none' });
  } finally {
    saving.value = false;
  }
};

/** 相位的配色：和谐=绿、紧张=橙、中性=灰（只影响观感，不表达吉凶判断） */
const aspectClass = (nature: string): string =>
  nature === 'HARMONIOUS'
    ? 'chart__aspect--good'
    : nature === 'TENSE'
      ? 'chart__aspect--tense'
      : 'chart__aspect--neutral';

const goIndex = (): void => {
  uni.navigateTo({ url: '/pkgZodiac/pages/index' });
};

/** 元素分布条的宽度（至少 6%，否则 0 个和 1 个看起来一样） */
const barWidth = (percent: number): string => `${Math.max(6, percent)}%`;
</script>

<template>
  <view class="chart page-container">
    <view v-if="loading" class="card chart__state">
      <text>正在把你的出生时刻还原成一张星图…</text>
    </view>

    <view v-else-if="loadError" class="card chart__state">
      <text class="chart__state-title">{{ loadError }}</text>
      <button class="chart__state-action" @tap="bootstrap">重新加载</button>
    </view>

    <!-- 没设出生日期：星盘的唯一硬前提，先去选 -->
    <view v-else-if="needsBirthday" class="card chart__setup">
      <text class="chart__setup-title">先选一次你的出生日期</text>
      <text class="chart__setup-desc">
        星盘要按你出生那一刻的星空来算，所以出生日期是前提。回上一页选好日期，这里立刻就有内容。
      </text>
      <button class="chart__setup-button" @tap="goIndex">去选出生日期</button>
    </view>

    <template v-else-if="data">
      <!-- ① 三巨头 -->
      <view class="chart__hero">
        <text class="chart__hero-title">你的三巨头</text>
        <text class="chart__hero-desc">太阳是"你想成为的样子"，月亮是"你私下的样子"，上升是"别人第一眼看到的你"</text>

        <view class="chart__hero-grid">
          <view class="chart__hero-item">
            <text class="chart__hero-label">☉ 太阳</text>
            <text class="chart__hero-value">{{ preview ? preview.sun.signName : bodyOf('SUN')?.signName }}</text>
            <text class="chart__hero-sub">{{ preview ? preview.sun.elementLabel : bodyOf('SUN')?.position }}</text>
          </view>
          <view class="chart__hero-item">
            <text class="chart__hero-label">☽ 月亮</text>
            <text class="chart__hero-value">{{ preview ? preview.moon.signName : bodyOf('MOON')?.signName }}</text>
            <text class="chart__hero-sub">
              {{
                preview ? (preview.moon.uncertain ? '位置待确认' : preview.moon.elementLabel) : bodyOf('MOON')?.position
              }}
            </text>
          </view>
          <view class="chart__hero-item">
            <text class="chart__hero-label">ASC 上升</text>
            <text class="chart__hero-value">{{
              chart ? (ascendantOf()?.signName ?? '待补全') : (preview?.ascendant?.signName ?? '待补全')
            }}</text>
            <text class="chart__hero-sub">
              {{ chart ? (ascendantOf()?.position ?? '需要出生时间与城市') : '补全出生信息即可解锁' }}
            </text>
          </view>
        </view>

        <text v-if="data.birthInfo.birthPlace || data.birthInfo.birthTime" class="chart__hero-meta">
          {{ data.birthInfo.birthday }}
          {{ data.birthInfo.birthTime ? ` ${data.birthInfo.birthTime}` : '' }}
          {{ data.birthInfo.birthPlace ? ` · ${data.birthInfo.birthPlace}` : '' }}
        </text>
      </view>

      <!-- ② 补全出生信息（缺什么补什么） -->
      <view v-if="notices.length > 0" class="card chart__notice">
        <text class="chart__notice-title">还差一点信息</text>
        <view v-for="(notice, index) in notices" :key="index" class="chart__notice-item">
          <text class="chart__notice-dot">·</text>
          <text class="chart__notice-text">{{ notice }}</text>
        </view>

        <!-- 出生时间 -->
        <view v-if="!data.birthInfo.birthTime" class="chart__fill">
          <text class="chart__fill-label">出生时间</text>
          <picker mode="time" :value="timeDraft" @change="onTimeChange">
            <view class="chart__fill-picker">
              <text class="chart__fill-value">{{ timeDraft }}</text>
              <text class="chart__fill-arrow">选择 ›</text>
            </view>
          </picker>
          <button class="chart__fill-button" :disabled="saving" @tap="saveTime">保存时间</button>
        </view>

        <!-- 出生城市 -->
        <view v-if="data.birthInfo.placeResolvedFrom === 'MISSING'" class="chart__fill">
          <text class="chart__fill-label">出生城市</text>
          <button class="chart__fill-button" @tap="openCityPanel">选择出生城市</button>
        </view>
      </view>

      <!-- ③ 非会员：解锁引导（列清楚能拿到什么，而不是把内容糊掉） -->
      <view v-if="access && !access.chartUnlocked" class="card chart__locked">
        <text class="chart__locked-title">完整星盘是会员内容</text>
        <text class="chart__locked-desc">{{ access.membershipHint }}</text>
        <view v-for="(item, index) in access.lockedSections" :key="index" class="chart__locked-item">
          <text class="chart__locked-check">✓</text>
          <text class="chart__locked-text">{{ item }}</text>
        </view>
      </view>

      <!-- ③ 会员：完整星盘 -->
      <template v-if="chart">
        <view class="card chart__block">
          <text class="chart__block-title">十大行星</text>
          <text class="chart__block-desc"
            >由内到外：太阳、月亮、水星、金星、火星、木星、土星、天王星、海王星、冥王星</text
          >
          <view v-for="item in chart.positions" :key="item.key" class="chart__row">
            <text class="chart__row-icon">{{ item.symbol }}</text>
            <text class="chart__row-name">{{ item.name }}</text>
            <text class="chart__row-value">{{ item.position }}</text>
            <text v-if="item.house" class="chart__row-house">第{{ item.house }}宫</text>
            <text v-if="item.retrograde" class="chart__row-tag">逆行</text>
            <text v-if="item.uncertain" class="chart__row-tag chart__row-tag--warn">待确认</text>
          </view>
        </view>

        <view v-if="chart.angles.ascendant && chart.angles.midheaven" class="card chart__block">
          <text class="chart__block-title">四轴</text>
          <view class="chart__row">
            <text class="chart__row-icon">ASC</text>
            <text class="chart__row-name">上升点</text>
            <text class="chart__row-value">{{ chart.angles.ascendant.position }}</text>
          </view>
          <view class="chart__row">
            <text class="chart__row-icon">MC</text>
            <text class="chart__row-name">天顶</text>
            <text class="chart__row-value">{{ chart.angles.midheaven.position }}</text>
          </view>
          <text v-if="chart.chartRuler" class="chart__block-note">
            命主星（上升星座的守护星）：{{ chart.chartRuler.planetName }}，落在 {{ chart.chartRuler.position }}
          </text>
        </view>

        <view v-if="chart.houses" class="card chart__block">
          <text class="chart__block-title">十二宫</text>
          <text class="chart__block-desc">
            采用整宫制：上升星座即第 1 宫，之后每宫一个星座。不同分宫制（如 Placidus）结果会不一样，不是算错。
          </text>
          <view class="chart__houses">
            <view v-for="house in chart.houses" :key="house.index" class="chart__house">
              <text class="chart__house-index">{{ house.index }}</text>
              <text class="chart__house-sign">{{ house.signName }}</text>
            </view>
          </view>
        </view>

        <view v-if="chart.aspects.length > 0" class="card chart__block">
          <text class="chart__block-title">行星相位</text>
          <text class="chart__block-desc">越靠前越接近精确角度（合 0°、六合 60°、刑 90°、拱 120°、冲 180°）</text>
          <view
            v-for="(aspect, index) in chart.aspects"
            :key="index"
            class="chart__aspect"
            :class="aspectClass(aspect.nature)"
          >
            <text class="chart__aspect-text">{{ aspect.fromName }} {{ aspect.symbol }} {{ aspect.toName }}</text>
            <text class="chart__aspect-name">{{ aspect.name }}</text>
            <text class="chart__aspect-orb">偏差 {{ aspect.orb.toFixed(2) }}°</text>
          </view>
        </view>

        <view class="card chart__block">
          <text class="chart__block-title">元素分布</text>
          <text class="chart__block-desc">按十大行星统计（不含四轴）。缺失的元素往往比"最多的那个"更值得留意</text>
          <view v-for="entry in chart.elementDistribution" :key="entry.key" class="chart__dist">
            <view class="chart__dist-head">
              <text class="chart__dist-label">{{ entry.label }}</text>
              <text class="chart__dist-count">{{ entry.count }} 个 · {{ entry.percent }}%</text>
            </view>
            <view class="chart__dist-track">
              <view class="chart__dist-bar" :style="{ width: barWidth(entry.percent) }" />
            </view>
            <text class="chart__dist-desc">{{ entry.description }}</text>
          </view>
          <text v-if="chart.missingElements.length === 0" class="chart__block-note"
            >四元素都占到了，属于比较少见的均衡盘。</text
          >
        </view>

        <view class="card chart__block">
          <text class="chart__block-title">宫位类型分布</text>
          <view v-for="entry in chart.modeDistribution" :key="entry.key" class="chart__dist">
            <view class="chart__dist-head">
              <text class="chart__dist-label">{{ entry.label }}</text>
              <text class="chart__dist-count">{{ entry.count }} 个 · {{ entry.percent }}%</text>
            </view>
            <view class="chart__dist-track">
              <view class="chart__dist-bar" :style="{ width: barWidth(entry.percent) }" />
            </view>
            <text class="chart__dist-desc">{{ entry.description }}</text>
          </view>
        </view>

        <view v-if="chart.stelliums.length > 0" class="card chart__block">
          <text class="chart__block-title">星群</text>
          <text class="chart__block-desc">同一星座聚集 3 个及以上行星，这个星座的特质会被明显放大</text>
          <view v-for="item in chart.stelliums" :key="item.sign" class="chart__stellium">
            <text class="chart__stellium-sign">{{ item.signName }}</text>
            <text class="chart__stellium-bodies">{{ item.bodies.join('、') }}</text>
          </view>
        </view>

        <view class="card chart__block">
          <text class="chart__block-title">这张盘是怎么算出来的</text>
          <text class="chart__block-note">{{ chart.precisionNote }}</text>
        </view>
      </template>

      <!-- 合规声明：服务端下发，原样展示 -->
      <view class="card chart__disclaimer">
        <text class="chart__disclaimer-text">{{ data.disclaimer }}</text>
      </view>
    </template>

    <!-- 出生城市选择面板 -->
    <view v-if="cityPanelOpen" class="chart__mask" @tap="cityPanelOpen = false">
      <view class="chart__panel" @tap.stop>
        <text class="chart__panel-title">选择出生城市</text>
        <input
          class="chart__panel-input"
          type="text"
          :value="cityKeyword"
          placeholder="输入城市名，如 杭州 / 乌鲁木齐"
          @confirm="onCitySearchConfirm"
        />
        <scroll-view class="chart__panel-list" scroll-y>
          <view
            v-for="city in cityOptions"
            :key="`${city.region}-${city.name}`"
            class="chart__panel-item"
            @tap="pickCity(city)"
          >
            <text class="chart__panel-city">{{ city.name }}</text>
            <text class="chart__panel-region">{{ city.region }}</text>
          </view>
          <view v-if="cityOptions.length === 0" class="chart__panel-empty">
            <text>没有匹配的城市，换个说法试试（也可以输入省份名）</text>
          </view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
.chart {
  &__state {
    text-align: center;
  }

  &__state-title {
    display: block;
    margin-bottom: $space-md;
  }

  &__state-action,
  &__setup-button,
  &__fill-button {
    margin-top: $space-md;
    color: $color-text-inverse;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__setup {
    padding: $space-lg $space-md;
  }

  &__setup-title {
    display: block;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
  }

  &__setup-desc {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__hero {
    padding: $space-lg $space-md;
    background: linear-gradient(160deg, $color-primary-dark, $color-primary);
    border-radius: $radius-lg;
  }

  &__hero-title {
    display: block;
    color: $color-text-inverse;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
  }

  &__hero-desc {
    display: block;
    margin-top: $space-xs;
    color: $color-text-inverse;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    opacity: 0.85;
  }

  &__hero-grid {
    display: flex;
    margin-top: $space-md;
  }

  &__hero-item {
    flex: 1;
    text-align: center;
  }

  &__hero-label {
    display: block;
    color: $color-text-inverse;
    font-size: $font-size-xs;
    opacity: 0.85;
  }

  &__hero-value {
    display: block;
    margin-top: $space-xxs;
    color: $color-text-inverse;
    font-size: $font-size-lg;
    font-weight: $font-weight-bold;
  }

  &__hero-sub {
    display: block;
    margin-top: 2rpx;
    color: $color-text-inverse;
    font-size: $font-size-xs;
    opacity: 0.75;
  }

  &__hero-meta {
    display: block;
    margin-top: $space-md;
    color: $color-text-inverse;
    font-size: $font-size-xs;
    text-align: center;
    opacity: 0.8;
  }

  &__notice {
    margin-top: $space-md;
    border-left: 6rpx solid $color-warning;
  }

  &__notice-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__notice-item {
    display: flex;
    align-items: flex-start;
    margin-top: $space-xs;
  }

  &__notice-dot {
    margin-right: $space-xs;
    color: $color-warning;
  }

  &__notice-text {
    flex: 1;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-regular;
  }

  &__fill {
    margin-top: $space-md;
    padding-top: $space-md;
    border-top: 1rpx solid $color-divider;
  }

  &__fill-label {
    display: block;
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__fill-picker {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-sm 0;
  }

  &__fill-value {
    font-size: $font-size-md;
    color: $color-primary;
  }

  &__fill-arrow {
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__locked {
    margin-top: $space-md;
    border-left: 6rpx solid $color-primary;
  }

  &__locked-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__locked-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-secondary;
  }

  &__locked-item {
    display: flex;
    align-items: flex-start;
    margin-top: $space-xs;
  }

  &__locked-check {
    margin-right: $space-xs;
    color: $color-primary;
  }

  &__locked-text {
    flex: 1;
    font-size: $font-size-sm;
    line-height: $line-height-base;
    color: $color-text-regular;
  }

  &__block {
    margin-top: $space-md;
  }

  &__block-title {
    display: block;
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__block-desc {
    display: block;
    margin-top: $space-xxs;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-placeholder;
  }

  &__block-note {
    display: block;
    margin-top: $space-sm;
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-secondary;
  }

  &__row {
    display: flex;
    align-items: center;
    padding: $space-sm 0;
    border-bottom: 1rpx solid $color-divider;
  }

  &__row-icon {
    width: 56rpx;
    font-size: $font-size-md;
    color: $color-primary;
  }

  &__row-name {
    width: 110rpx;
    font-size: $font-size-sm;
  }

  &__row-value {
    flex: 1;
    font-size: $font-size-sm;
    font-weight: $font-weight-medium;
  }

  &__row-house {
    margin-left: $space-xs;
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__row-tag {
    padding: 2rpx $space-xs;
    margin-left: $space-xs;
    font-size: $font-size-xs;
    color: $color-primary;
    background-color: $color-primary-fade;
    border-radius: $radius-xs;
  }

  &__row-tag--warn {
    color: $color-warning;
    background-color: $color-warning-fade;
  }

  &__houses {
    display: flex;
    flex-wrap: wrap;
    margin-top: $space-sm;
  }

  &__house {
    width: 25%;
    padding: $space-xs 0;
    text-align: center;
  }

  &__house-index {
    display: block;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__house-sign {
    display: block;
    margin-top: 2rpx;
    font-size: $font-size-sm;
    font-weight: $font-weight-medium;
  }

  &__aspect {
    display: flex;
    align-items: center;
    padding: $space-sm 0;
    border-bottom: 1rpx solid $color-divider;
  }

  &__aspect--good &__aspect-name {
    color: $color-success;
  }

  &__aspect--tense &__aspect-name {
    color: $color-warning;
  }

  &__aspect--neutral &__aspect-name {
    color: $color-text-secondary;
  }

  &__aspect-text {
    flex: 1;
    font-size: $font-size-sm;
  }

  &__aspect-name {
    width: 90rpx;
    font-size: $font-size-xs;
    text-align: center;
  }

  &__aspect-orb {
    width: 150rpx;
    font-size: $font-size-xs;
    color: $color-text-placeholder;
    text-align: right;
  }

  &__dist {
    margin-top: $space-md;
  }

  &__dist-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  &__dist-label {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__dist-count {
    font-size: $font-size-xs;
    color: $color-text-secondary;
  }

  &__dist-track {
    height: 12rpx;
    margin-top: $space-xs;
    overflow: hidden;
    background-color: $color-bg-hover;
    border-radius: $radius-round;
  }

  &__dist-bar {
    height: 100%;
    background-color: $color-primary;
    border-radius: $radius-round;
  }

  &__dist-desc {
    display: block;
    margin-top: $space-xs;
    font-size: $font-size-xs;
    line-height: $line-height-base;
    color: $color-text-placeholder;
  }

  &__stellium {
    margin-top: $space-sm;
  }

  &__stellium-sign {
    font-size: $font-size-sm;
    font-weight: $font-weight-semibold;
  }

  &__stellium-bodies {
    margin-left: $space-sm;
    font-size: $font-size-sm;
    color: $color-text-secondary;
  }

  &__disclaimer {
    margin-top: $space-md;
  }

  &__disclaimer-text {
    font-size: $font-size-xs;
    line-height: $line-height-loose;
    color: $color-text-placeholder;
  }

  &__mask {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: $z-index-mask;
    background-color: $color-bg-mask;
  }

  &__panel {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
    padding: $space-lg $space-md;
    background-color: $color-bg-card;
    border-radius: $radius-lg $radius-lg 0 0;
  }

  &__panel-title {
    font-size: $font-size-md;
    font-weight: $font-weight-semibold;
  }

  &__panel-input {
    padding: $space-sm;
    margin-top: $space-sm;
    font-size: $font-size-sm;
    background-color: $color-bg-hover;
    border-radius: $radius-sm;
  }

  &__panel-list {
    // 与聊天页同样的坑：只给 flex:1 的话，scroll-view 会按内容撑开而不滚动
    flex: 1;
    height: 0;
    min-height: 0;
    margin-top: $space-sm;
  }

  &__panel-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: $space-sm 0;
    border-bottom: 1rpx solid $color-divider;
  }

  &__panel-city {
    font-size: $font-size-sm;
  }

  &__panel-region {
    font-size: $font-size-xs;
    color: $color-text-placeholder;
  }

  &__panel-empty {
    padding: $space-lg 0;
    font-size: $font-size-sm;
    color: $color-text-placeholder;
    text-align: center;
  }
}
</style>
