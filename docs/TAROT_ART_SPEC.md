# 塔罗牌美术规范 · Astral Grimoire｜星辰秘典

> 本文是**美术交付契约**：插画团队的产出标准，与前端接入的唯一依据。
> 配套代码：`frontend/miniapp/src/components/tarot/`（卡牌组件 + 资源清单）。
>
> ⚠ 当前仓库**没有**任何正式插画。占位用的是 `card-art.util.ts` 的图元组合，
> 仅用于加载占位 / 低端机降级 / 卡背辅助，**不是**牌面美术。一旦 `art-manifest.ts`
> 里某个 `cardId` 填了地址，该牌自动切换到真图，无需改任何页面代码。

---

## 1. 画布与安全区

| 项       | 规格                                             | 原因                                                        |
| -------- | ------------------------------------------------ | ----------------------------------------------------------- |
| 比例     | **3 : 5**（竖版）                                | 与组件 `CARD_RATIO = 1.64≈5/3` 一致；输出尺寸偏差会导致拉伸 |
| 母版     | **1440 × 2400 px**，PNG 无损（或 16-bit TIFF）   | 留出未来做高清版 / 印刷 / 分享大图的余量                    |
| 小程序版 | **720 × 1200 WebP**（quality 82），单张 ≤ 120 KB | 78 张 × 120 KB ≈ 9 MB，走 CDN 分发，不进主包                |
| 安全区   | 四边各留 **8%** 空白，主体不得进入               | 组件会在此区域叠金色边框与序号，主体压边会被切              |
| 主体聚焦 | 视觉重心落在 **上部 55%**                        | 下部 18% 会被牌名文字层覆盖，避免重要元素被遮               |
| 出血     | 母版额外留 40px                                  | 兼容未来的圆角裁切与出血裁边                                |

**禁止**：画面内出现任何文字、罗马数字、水印、签名、二维码。
序号与牌名由 **UI 文字层**渲染（见 §6），便于国际化与字体控制，也避免 AI 生成乱码。

---

## 2. 艺术风格定义（一段话的"风格锚"）

> **Astral Grimoire**：19 世纪欧洲铜版蚀刻（copperplate etching）的细密排线质感，
> 叠加暗色奇幻插画的光影，再以古典金箔（gilding）作局部提亮。
> 画面像一页被翻旧了的占星手稿：深蓝紫的夜空、月光作为唯一主光源、
> 极细的金色刻线勾勒轮廓与星图、人物与象征物严谨对称、
> 留白克制、细节密集但不喧闹。

**三个必须同时成立的特征**：

1. **排线质感**：暗部用平行细线（hatching）与交叉线（cross-hatching）表现，不是平滑的数码渐变；
2. **单一光源**：每张牌只有一个主光（月亮或星光），阴影方向一致；
3. **金线只描不填**：金色用于轮廓、星图、边框纹饰与高光线，**不做大面积金色填充**。

---

## 3. 调色板（与 UI 严格同源）

| 用途               | 色值                            | 说明                                            |
| ------------------ | ------------------------------- | ----------------------------------------------- |
| 夜空底色           | `#101422`                       | 与页面底色一致，牌面与页面能"融"在一起          |
| 次级夜幕           | `#1C2335` / `#252039`           | 背景层次，绝不用纯黑                            |
| 月光白             | `#F2EBDD`                       | 人物肌肤、衣料的高光面                          |
| 香槟金             | `#C9AB73`                       | 刻线、金箔、星图、金属纹饰                      |
| 星雾紫             | `#AFA3C8`                       | 远景、烟雾、帷幕的中间调                        |
| 暗银               | `#6E7285`                       | 阴影、金属冷调                                  |
| 强调点缀（极少量） | `#8C4A52` 暗红 / `#4A6B62` 暗绿 | 仅用于单张牌的叙事物件（血、藤蔓），占画面 < 5% |

**禁止**：高饱和霓虹、纯黑 `#000`、大面积亮金 `#FFD700`、赛博紫粉渐变。

---

## 4. 大阿卡纳：22 张叙事纲要

每张必须包含「**主体 + 空间 + 象征物 + 光源**」四要素。
下表是叙事骨架，不是画面细节的唯一答案；但象征物必须齐。

| #     | 牌       | 主体                                         | 关键象征物                                                   | 光源             |
| ----- | -------- | -------------------------------------------- | ------------------------------------------------------------ | ---------------- |
| 0     | 愚者     | 年轻旅人站在云雾悬崖边缘，背包轻简，白犬随行 | 初升朝阳、脚下深渊云海、悬崖边缘的裂石、背后星图             | 东方晨曦（暖）   |
| I     | 魔术师   | 站立施术者，一手上指天一手下指地             | 桌上四元素（杖/杯/剑/币）、头顶无限符号、腰缠蛇、垂落红袍    | 桌面烛光（暖）   |
| II    | 女祭司   | 月光长袍女性端坐                             | 黑白双柱（B/J）、手中卷轴、脚下新月、星图帷幕、帷幕后的石榴  | 月光（冷）       |
| III   | 女皇     | 丰饶女性半卧于自然                           | 十二星冠、麦田、瀑布、软垫与纹章盾、金星符号                 | 正午柔光         |
| IV    | 皇帝     | 石座上的君王，铠甲外罩红袍                   | 石座上的公羊头、手中权杖与宝球、背后群山                     | 冷峻侧光         |
| V     | 教皇     | 三重冠冕的宗教人物                           | 三重十字杖、两名信徒、脚下交叉钥匙、石柱                     | 圣殿高位光       |
| VI    | 恋人     | 一对裸身男女相对而立                         | 上方天使/太阳、身后知识树与生命树、蛇、远山                  | 上部逆光         |
| VII   | 战车     | 披甲驾驭者立于战车                           | 黑白双兽（斯芬克斯）、车体星纹、驾驭者手持权杖、背后城墙     | 侧上方硬光       |
| VIII  | 力量     | 女性轻柔合拢狮口                             | 狮子鬃毛、无限符号、花冠腰带、远处山峦                       | 柔和顶光         |
| IX    | 隐者     | 灰袍老者独行雪峰                             | 提灯（内有六角星）、长杖、脚下冰峰、灯笼光晕                 | 提灯自发光       |
| X     | 命运之轮 | 巨大轮盘悬于云端                             | 轮上四方活物（人/鹰/狮/牛）、轮心符号、轮轴、云海            | 轮心辉光         |
| XI    | 正义     | 端坐的审判者                                 | 天平、直剑、紫帷幕、双柱、冠冕                               | 正面均匀冷光     |
| XII   | 倒吊人   | 单足倒悬于 T 形木架                          | 倒吊者光环、绑腿绳结、交叉双腿、背后金光                     | 头部光环（暖）   |
| XIII  | 死神     | 披甲骷髅骑士缓行                             | 白骨旗帜（白玫瑰纹）、镰刀、倒伏的王冠与权杖、远处双塔与日出 | 地平线晨光       |
| XIV   | 节制     | 天使单足踏水单足踏岸                         | 两只杯间倒流的水、额前太阳符号、鸢尾花、蜿蜒小径             | 水面反光         |
| XV    | 恶魔     | 羊角恶魔踞于石台                             | 倒五芒星、松散锁链、被锁的男女、火炬                         | 下方火光（橙红） |
| XVI   | 塔       | 高塔被闪电击中                               | 坠落的人、王冠被击飞、火焰、雨点、黑色天幕                   | 闪电（瞬时强光） |
| XVII  | 星星     | 裸身女性在水边倾倒双壶                       | 一大七小共八颗星、水池、朱鹭、远处树                         | 星光（冷而柔）   |
| XVIII | 月亮     | 月下小径，狼与犬对月                         | 十六芒大月（含侧脸）、双塔、水中螯虾、蜿蜒水滴小径           | 月光（冷）       |
| XIX   | 太阳     | 白衣孩童骑白马                               | 十六芒太阳、向日葵墙、红色旗帜、花园                         | 正面正午强光     |
| XX    | 审判     | 天使吹响号角于云端                           | 十字旗号角、从棺中升起的人群、冰原、远山                     | 天使背光         |
| XXI   | 世界     | 舞者悬于花环之中                             | 椭圆花环（月桂）、四角四活物、双杖、紫色飘带                 | 环心柔光         |

---

## 5. 小阿卡纳：56 张的组合规则

小牌**不逐张写叙事**，而是「花色场景 × 位阶动作」，这样 56 张既统一又可区分：

| 花色           | 场景基调                     | 主体倾向                 | 主色倾向      |
| -------------- | ---------------------------- | ------------------------ | ------------- |
| 权杖 Wands     | 荒原 / 火山坡 / 生长中的藤蔓 | 行动中的人、火、手       | 暖棕 + 火星橙 |
| 圣杯 Cups      | 湖畔 / 圣殿 / 夜空倒影       | 情感、杯、水、拥抱       | 青蓝 + 月白   |
| 宝剑 Swords    | 高地 / 风暴 / 石阶           | 思维、刃、冲突、风       | 冷银 + 深灰   |
| 星币 Pentacles | 花园 / 工坊 / 石墙           | 劳作、币、土地、手工艺品 | 暗金 + 苔绿   |

**位阶的画面动作**（同一花色按此递进）：

| 位阶        | 画面动作                                           |
| ----------- | -------------------------------------------------- |
| Ace         | 一只自云中伸出的手托起该花色的单一象征物，圣光降临 |
| 二 ~ 五     | 象征物数量 = 牌面数字，人物交互从"接触"到"摩擦"    |
| 六 ~ 十     | 象征物数量 = 数字，场景从"回稳"走向"收束/过载"     |
| 侍从 Page   | 年轻学徒手持单一象征物，姿态试探                   |
| 骑士 Knight | 骑乘者持象征物冲刺，动势强烈                       |
| 王后 Queen  | 端坐者持象征物，姿态内敛，背景有帷幕               |
| 国王 King   | 王者端坐石座持象征物，姿态外放，背景有王座纹饰     |

例：**圣杯七** = 迷雾中人物 + 七只漂浮圣杯，每只杯中呈现不同幻象（宝冠、宝石、蛇、城堡、月桂、龙、人面），光源为自上而下的冷光。

---

## 6. 牌面边框、序号与文字系统（**UI 层渲染，不进图**）

组件已实现（`TarotCard.vue`），插画只负责画面本体：

```
┌─────────────────────────┐  ← 外框：1rpx 香槟金 #C9AB73（0.42 透明度）
│  ┌───────────────────┐  │  ← 内框：1rpx 金线（0.22 透明度），距外框 3.2%
│  │                   │  │
│  │      插画区        │  │  ← 3:5 母版等比铺满，安全区 8%
│  │                   │  │
│  │                   │  │
│  └───────────────────┘  │
│  ────────────────────    │  ← 38% 宽渐变金线
│        愚者 THE FOOL      │  ← 衬线字体，22rpx，月光白
└─────────────────────────┘
```

- **序号**：大阿卡纳显示罗马数字（`0 / I / II … XXI`），小阿卡纳显示花色符号；居中于顶部，衬线字体 20rpx；
- **牌名**：中文为主、可选英文副行；**动态文本永不使用子集字体**（见 §8）；
- **逆位**：整张牌旋转 180°（组件已实现），**不是**只改标签。

---

## 7. 生成提示词模板（可直接粘贴到 Midjourney / SD / 即梦 / 可灵）

**统一风格前缀**（每条提示词都必须带，保证 78 张同源）：

```
copperplate etching tarot card illustration, dark astral fantasy, fine parallel hatching,
single moonlight light source, antique gold leaf linework only on outlines and star charts,
deep navy #101422 background, moon ivory #F2EBDD highlights, champagne gold #C9AB73 linework,
dusty lilac #AFA3C8 atmosphere, symmetric classical composition, 19th century occult grimoire plate,
muted desaturated palette, no text, no letters, no numbers, no watermark,
vertical composition 3:5 aspect ratio, high detail, engraved texture
```

**负面提示词**（Negvative prompt，必须带）：

```
text, letters, typography, numbers, watermark, signature, logo, frame border, neon, cyberpunk,
oversaturated, pure black background, glossy digital gradient, anime, cartoon, chibi, 3d render,
blurry, low contrast, extra limbs, deformed hands, cropped subject, borders cut off
```

**单张牌提示词结构**：

```
{风格前缀} — subject: {主体描述}, surroundings: {空间描述}, symbols: {象征物逐个列出},
lighting: {光源}, mood: {情绪词}
```

**三张样卡的完整提示词**（先做这三张，验收通过再批量）：

**① 愚者 The Fool**

```
copperplate etching tarot card illustration, dark astral fantasy, fine parallel hatching, ...
— subject: a young androgynous traveler in a patchwork cloak stands at the very edge of a
cliff, stepping forward, one arm holding a small bundle on a staff over the shoulder,
a small white dog leaps at their heel; surroundings: the cliff edge cracks into mist,
a vast sea of clouds below, distant snow peaks, a faint star chart spread across the sky
behind them; symbols: rising sun disc on the horizon, white rose in hand, bundle on staff,
cracked stone edge; lighting: warm dawn light from the eastern horizon rimming the figure,
cool moonlight from behind; mood: innocent courage, threshold
```

**② 女祭司 The High Priestess**

```
... — subject: a woman in flowing moon-ivory robes sits perfectly still between two pillars,
dark robe with silver crescent embroidery, a scroll half-open on her lap,
a triple-moon crown; surroundings: black pillar on the left and white pillar on the right,
deep indigo veil behind her embroidered with a star map, a still water surface at her feet;
symbols: crescent moon at her feet, scroll, pomegranate veil, pillar letters,
a faint lunar disc halo behind her head; lighting: single cold moonlight from upper left,
soft rim light on the veil; mood: silence, withheld knowledge
```

**③ 圣杯七 Seven of Cups**

```
... — subject: a hooded figure seen from behind stands in mist, arms slightly raised,
facing seven ornate chalices floating in the air; surroundings: fog, no horizon,
dim star field above; symbols: seven floating cups each containing a different vision —
a golden crown, a glowing jewel, a coiled serpent, a small castle, a laurel wreath,
a dragon, a veiled human face; lighting: cold top-down light catching only the chalice rims
and the figure's shoulders; mood: illusion, temptation, choice
```

---

## 8. 中文字体方案（合法商用 + 可靠回退）

| 层级                               | 字体                                        | 来源与授权                                      | 实现                                                             |
| ---------------------------------- | ------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| 标题（塔罗牌 / 牌阵名 / 章节标题） | **思源宋体 Source Han Serif SC**（子集）    | SIL Open Font License 1.1，**允许商用与子集化** | 子集化到 ~260 字，woff2 约 60–90 KB，`uni.loadFontFace` 动态加载 |
| 正文（解读、说明、标签）           | 系统无衬线（PingFang SC / 系统 serif 回退） | 系统内置                                        | 沿用 `$arcana-font-sans`                                         |

**铁律**：子集字体**只用于固定的、可控的字符串**（页面标题、牌阵名、章节标题、78 张牌名）。
动态内容（AI/服务端返回的解读正文、用户昵称、日期）**一律不套子集字体** ——
子集缺字会渲染成方框，这比"字体不统一"严重得多。

子集生成命令（构建期执行，不入仓）：

```bash
pyftsubset SourceHanSerifSC-Regular.otf \
  --text-file=docs/tarot-font-glyphs.txt \
  --output-file=static/fonts/arcana-serif-subset.woff2 \
  --flavor=woff2 --layout-features='*' --no-hinting
```

---

## 9. 命名、目录与接入契约

**文件命名**（小写下划线，与后端 `card.id` 一一对应）：

```
assets/tarot/major/00_fool.webp
assets/tarot/major/02_high_priestess.webp
assets/tarot/minor/cups_07.webp
assets/tarot/back/back_default.webp
```

**接入方式**：只需在 `frontend/miniapp/src/components/tarot/art-manifest.ts` 里填地址：

```ts
export const TAROT_ART_MANIFEST: Readonly<Record<string, string>> = {
  'MAJOR-00': 'https://cdn.example.com/tarot/major/00_fool.webp',
  'MAJOR-02': 'https://cdn.example.com/tarot/major/02_high_priestess.webp',
  'CUPS-SEVEN': 'https://cdn.example.com/tarot/minor/cups_07.webp',
};
```

未填的牌自动使用图元占位（不会白屏、不会布局跳动）。填一张生效一张，无需发版。

---

## 10. 加载性能与后备

| 策略       | 做法                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| 不进主包   | 图片全部走 CDN；`project.config.json` 不动，包内零插画                        |
| 尺寸自适应 | 按卡牌显示宽度请求合适尺寸（`?w=360` / `?w=720`），列表用小的、大图用大的     |
| 预取       | 抽卡页在洗牌动画期间预取该牌阵将用到的 N 张（`uni.getImageInfo` 预热）        |
| 缓存       | 小程序本地缓存由基础库按 URL 自动管理；不重复下载                             |
| 失败回退   | `image` 的 `error` 事件 → 回落图元占位（**不空白、不抖动**），并记一条日志    |
| 弱网       | 图元占位先渲染，真图加载完成后淡入（`opacity` 过渡 200ms），避免闪烁          |
| 低端机     | 连续 2 次加载失败或系统 `prefers-reduced-motion` 时，本会话内直接使用图元占位 |

---

## 11. 授权与合规

- 插画若由第三方生成/购买，必须留存**授权凭证**（商用范围、期限、可否二次修改），存入 `docs/`；
- 不得使用任何现有商业塔罗牌（Rider-Waite、Thoth 等）的扫描图或近似重绘；
- 字体子集必须使用 OFL 授权字体（思源系列），并在《开源许可清单》登记；
- 图片不得含 OCR 可识别的文字（防止生成乱码被当成牌面文字）。
