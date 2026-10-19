# 塔罗插画投放目录

把图片包直接粘到本目录即可，**不需要改名**（脚本会尽量识别），粘完运行一次扫描：

```bash
cd frontend/miniapp
node scripts/scan-tarot-art.mjs
```

## 目录约定（推荐，但不是强制）

```
static/tarot/
├── back/          ← 卡背（1 张）
├── major/         ← 22 张大阿卡纳
└── minor/         ← 56 张小阿卡纳
```

也可以全部平铺在 `static/tarot/` 下，脚本同样能识别。

## 命名识别规则（脚本按优先级依次尝试）

**大阿卡纳**（任意一条命中即可）

| 能识别的写法 | 例子                                                   |
| ------------ | ------------------------------------------------------ |
| 序号 0–21    | `00_fool.webp`、`2-high-priestess.png`、`major_21.jpg` |
| 罗马数字     | `XXI_world.webp`、`iv_emperor.png`                     |
| 英文名       | `the_fool.webp`、`HighPriestess.png`                   |
| 中文名       | `愚者.webp`、`女祭司.png`、`圣杯七.webp`               |

**小阿卡纳**

| 能识别的写法 | 例子                                               |
| ------------ | -------------------------------------------------- |
| `花色_位阶`  | `cups_07.webp`、`wands-ace.png`、`swords_king.jpg` |
| 中文         | `圣杯七.webp`、`权杖侍从.png`、`星币国王.webp`     |

花色：`wands/cups/swords/pentacles` 或 `权杖/圣杯/宝剑/星币`
位阶：`ace/two…ten/page/knight/queen/king` 或 `1..10/侍从/骑士/王后/国王`

**卡背**：文件名含 `back`、`backside`、`背面`、`牌背`

## 支持格式

`.webp` `.png` `.jpg` `.jpeg` `.avif`

**优先 WebP**：同样画质下体积约为 PNG 的 1/5，78 张的差距是「能进包」和「进不了包」的区别。

## 扫描后会发生什么

1. 生成 `src/components/tarot/art-manifest.generated.ts`（**不要手改**，每次扫描覆盖）；
2. 打印覆盖率：78 张里哪些已就位、哪些还缺、哪些文件名没被识别（按提示改名即可）；
3. 打印总体积与告警：超过阈值会提醒——**78 张图不能长期放在主包**，
   正式环境请按 `docs/TAROT_ART_SPEC.md` §10 切到 CDN（填 `TAROT_ART_CDN` 即可，代码无需改）。

## 规格要求（详见 `docs/TAROT_ART_SPEC.md`）

- 比例 **3:5**（竖版），四边留 8% 安全区
- 小程序版建议 **720×1200 WebP，单张 ≤ 120KB**
- 画面内**不要有文字/数字/水印**（牌名与序号由 UI 文字层渲染）
