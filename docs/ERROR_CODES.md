# SoulMap AI 错误码总表（自动生成）

> ⚠ **本文件由 `scripts/generate-error-code-doc.mjs` 自动生成，请勿手工编辑。**
>
> 唯一事实源：`backend/src/common/errors/error-code.ts`。
> 修改错误码请改源码，然后执行 `node scripts/generate-error-code-doc.mjs` 重新生成。
> CI 会用 `--check` 模式校验本文件与源码是否同步。

编码规则：`AABBB` = 模块（2 位）+ 序号（3 位），见 `PROJECT_ARCHITECTURE.md` §6.2。

本次生成基于 151 个错误码定义。

## 0. 分段汇总

| 段 | 模块 | 区间 | 错误码数量 |
|---|---|---|---|
| 0 | 成功 | 0 | 1 |
| 10 | 通用 / 参数校验 | 10000–10999 | 13 |
| 20 | 认证与鉴权 | 20000–20999 | 23 |
| 30 | 用户与隐私 | 30000–30999 | 19 |
| 40 | 测试与人格 | 40000–40999 | 14 |
| 50 | AI / 报告 | 50000–50999 | 22 |
| 60 | 关系与匹配 | 60000–60999 | 13 |
| 70 | 支付与会员 | 70000–70999 | 20 |
| 80 | 存储与文件 | 80000–80999 | 16 |
| 90 | 系统与第三方 | 90000–90999 | 10 |
| — | **合计** | — | **151** |

## 1. 成功（0）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `SUCCESS` | 0 | — | ok |

## 2. 通用 / 参数校验（10000–10999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `UNKNOWN` | 10000 | 500 | 服务开小差了，请稍后重试 |
| `PARAM_INVALID` | 10001 | 400 | 请求参数不合法 |
| `RESOURCE_NOT_FOUND` | 10002 | 404 | 请求的资源不存在 |
| `RESOURCE_CONFLICT` | 10003 | 409 | 资源状态冲突，请刷新后重试 |
| `METHOD_NOT_ALLOWED` | 10004 | 405 | 请求方法不被支持 |
| `PAYLOAD_TOO_LARGE` | 10005 | 413 | 请求内容过大 |
| `UNSUPPORTED_MEDIA_TYPE` | 10006 | 415 | 不支持的内容类型 |
| `RATE_LIMITED` | 10007 | 429 | 操作过于频繁，请稍后再试 |
| `OPERATION_FORBIDDEN` | 10008 | 403 | 当前操作不被允许 |
| `IDEMPOTENCY_KEY_MISSING` | 10009 | 400 | 缺少幂等键 X-Idempotency-Key |
| `IDEMPOTENCY_CONFLICT` | 10010 | 409 | 重复的请求，请勿重复提交 |
| `VERSION_OUTDATED` | 10011 | 409 | 数据版本已过期，请刷新后重试 |
| `ADMIN_ORIGIN_FORBIDDEN` | 10019 | 403 | 请求来源不合法 |

## 3. 认证与鉴权（20000–20999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `UNAUTHORIZED` | 20000 | 401 | 请先登录 |
| `TOKEN_EXPIRED` | 20001 | 401 | 登录状态已过期，请重新登录 |
| `TOKEN_INVALID` | 20002 | 401 | 登录凭证无效，请重新登录 |
| `TOKEN_REVOKED` | 20003 | 401 | 登录凭证已失效，请重新登录 |
| `REFRESH_TOKEN_INVALID` | 20004 | 401 | 登录续期凭证无效，请重新登录 |
| `REFRESH_TOKEN_REUSED` | 20005 | 401 | 检测到凭证异常复用，已退出全部设备，请重新登录 |
| `WECHAT_CODE_INVALID` | 20006 | 400 | 微信登录凭证无效，请重试 |
| `WECHAT_API_ERROR` | 20007 | 502 | 微信服务暂时不可用，请稍后重试 |
| `WECHAT_SESSION_EXPIRED` | 20008 | 401 | 微信会话已过期，请重新授权 |
| `PERMISSION_DENIED` | 20009 | 403 | 没有操作权限 |
| `ACCOUNT_BANNED` | 20010 | 403 | 账号已被限制使用，如有疑问请联系客服 |
| `LOGIN_TOO_MANY_ATTEMPTS` | 20011 | 429 | 尝试次数过多，请稍后再试 |
| `ADMIN_CREDENTIALS_INVALID` | 20012 | 401 | 账号或密码错误 |
| `REALM_MISMATCH` | 20013 | 403 | 登录凭证与当前端不匹配 |
| `ACCOUNT_IN_DELETION_GRACE` | 20014 | 403 | 账号正在注销冷静期，如需继续使用请先撤销注销申请 |
| `SESSION_NOT_FOUND` | 20015 | 404 | 登录会话不存在 |
| `SESSION_REVOKED` | 20016 | 401 | 登录会话已被撤销，请重新登录 |
| `ADMIN_CONFIRM_PASSWORD_REQUIRED` | 20017 | 401 | 该操作需要二次确认密码 |
| `ADMIN_CONFIRM_PASSWORD_INVALID` | 20018 | 401 | 二次确认密码错误 |
| `ADMIN_IP_NOT_ALLOWED` | 20020 | 403 | 当前 IP 不在允许范围内 |
| `ADMIN_ACCOUNT_DISABLED` | 20021 | 403 | 管理员账号已被禁用 |
| `ADMIN_NOT_FOUND` | 20022 | 404 | 管理员不存在 |
| `ROLE_NOT_FOUND` | 20023 | 404 | 角色不存在 |

## 4. 用户与隐私（30000–30999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `USER_NOT_FOUND` | 30000 | 404 | 用户不存在 |
| `USER_PROFILE_INCOMPLETE` | 30001 | 400 | 请先完善个人资料 |
| `CONSENT_REQUIRED` | 30002 | 403 | 请先同意用户协议与隐私政策 |
| `DATA_EXPORT_IN_PROGRESS` | 30003 | 409 | 数据导出任务正在进行中，请稍候 |
| `DATA_EXPORT_NOT_READY` | 30004 | 409 | 数据导出尚未完成，请稍后重试 |
| `DELETION_ALREADY_REQUESTED` | 30005 | 409 | 注销申请已提交，无需重复提交 |
| `DELETION_NOT_REQUESTED` | 30006 | 409 | 当前没有待处理的注销申请 |
| `DELETION_GRACE_PERIOD_PASSED` | 30007 | 409 | 注销冷静期已过，无法撤销 |
| `PHONE_DECRYPT_FAILED` | 30008 | 400 | 手机号解密失败，请重试 |
| `AGE_RESTRICTED` | 30009 | 403 | 该功能暂不面向未满 18 周岁用户开放 |
| `NICKNAME_INVALID` | 30010 | 400 | 昵称长度需在 1–20 个字符之间 |
| `CONTENT_BLOCKED` | 30011 | 400 | 内容包含不适宜的信息，请修改后重试 |
| `PROFILE_EDIT_LOCKED` | 30012 | 403 | 账号注销冷静期内无法修改资料，如需继续使用请先撤销注销申请 |
| `DELETION_NOT_CANCELLABLE` | 30013 | 409 | 冷静期已结束，注销申请无法撤销 |
| `DELETION_ALREADY_COMPLETED` | 30014 | 409 | 账号已注销完成，无法再次操作 |
| `INCLUDE_FIELD_INVALID` | 30015 | 400 | include 参数包含不支持的值 |
| `AVATAR_INVALID` | 30016 | 400 | 头像文件不合法 |
| `CONSENT_VERSION_STALE` | 30017 | 409 | 协议版本已更新，请重新阅读并确认 |
| `PHONE_ALREADY_BOUND` | 30018 | 409 | 该手机号已绑定其他账号 |

## 5. 测试与人格（40000–40999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `TEST_DEFINITION_NOT_FOUND` | 40000 | 404 | 测试不存在 |
| `TEST_DEFINITION_INACTIVE` | 40001 | 409 | 该测试已下架 |
| `TEST_SESSION_NOT_FOUND` | 40002 | 404 | 测试记录不存在 |
| `TEST_SESSION_NOT_OWNED` | 40003 | 403 | 无权访问该测试记录 |
| `TEST_SESSION_EXPIRED` | 40004 | 409 | 测试已超时，请重新开始 |
| `TEST_SESSION_ALREADY_SUBMITTED` | 40005 | 409 | 该测试已提交，不能重复提交 |
| `TEST_ANSWER_INCOMPLETE` | 40006 | 400 | 还有题目未作答，请完成全部题目 |
| `TEST_ANSWER_INVALID` | 40007 | 400 | 答案格式不合法 |
| `QUESTION_NOT_IN_PAPER` | 40008 | 400 | 题目不属于当前试卷 |
| `QUESTION_NOT_FOUND` | 40009 | 404 | 题目不存在 |
| `PERSONALITY_PROFILE_NOT_FOUND` | 40010 | 404 | 尚未生成人格画像，请先完成测试 |
| `PERSONALITY_PROFILE_BUILDING` | 40011 | 409 | 人格画像正在生成中，请稍候 |
| `MBTI_TYPE_INVALID` | 40012 | 404 | MBTI 类型不合法 |
| `ENGINE_VERSION_UNSUPPORTED` | 40013 | 400 | 算法版本不受支持 |

## 6. AI / 报告（50000–50999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `AI_PROVIDER_UNAVAILABLE` | 50000 | 503 | AI 服务暂时不可用，请稍后重试 |
| `AI_PROVIDER_TIMEOUT` | 50001 | 504 | AI 服务响应超时，请稍后重试 |
| `AI_PROVIDER_RATE_LIMITED` | 50002 | 429 | AI 服务繁忙，请稍后重试 |
| `AI_PROVIDER_AUTH_FAILED` | 50003 | 502 | AI 服务配置异常，请联系客服 |
| `AI_OUTPUT_INVALID` | 50004 | 502 | AI 返回内容格式异常，请重试 |
| `AI_CONTENT_BLOCKED` | 50005 | 400 | 内容包含不适宜的信息，请调整后重试 |
| `AI_QUOTA_EXCEEDED` | 50006 | 403 | AI 使用次数已用完，可升级会员继续使用 |
| `AI_COST_BUDGET_EXCEEDED` | 50007 | 503 | 今日 AI 服务已达上限，请明日再试 |
| `AI_CONVERSATION_NOT_OWNED` | 50009 | 403 | 无权访问该对话 |
| `AI_CONVERSATION_CLOSED` | 50010 | 409 | 该对话已结束 |
| `AI_PROMPT_TEMPLATE_NOT_FOUND` | 50011 | 500 | 提示词模板不存在 |
| `AI_PROMPT_VARIABLE_MISSING` | 50012 | 500 | 提示词变量缺失 |
| `AI_PROMPT_RENDER_FAILED` | 50013 | 500 | 提示词渲染失败 |
| `AI_SAFETY_INTERVENTION` | 50014 | 200 | 你的安全很重要，建议联系信任的人或专业机构 |
| `AI_STREAM_ABORTED` | 50015 | 499 | AI 回复已中断 |
| `AI_REPORT_NOT_FOUND` | 50016 | 404 | 报告不存在 |
| `AI_REPORT_GENERATING` | 50017 | 409 | 报告正在生成中，请稍候 |
| `AI_REPORT_GENERATION_FAILED` | 50018 | 502 | 报告生成失败，请重试 |
| `AI_REPORT_NOT_UNLOCKED` | 50019 | 403 | 该报告尚未解锁 |
| `AI_REPORT_REGENERATE_FORBIDDEN` | 50020 | 403 | 当前权益不支持重新生成报告 |
| `AI_REQUEST_REJECTED` | 50021 | 400 | AI 请求参数不被接受，请联系客服 |
| `AI_CONVERSATION_NOT_FOUND` | 50022 | 404 | 对话不存在 |

## 7. 关系与匹配（60000–60999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `RELATIONSHIP_NOT_FOUND` | 60000 | 404 | 关系不存在 |
| `RELATIONSHIP_NOT_OWNED` | 60001 | 403 | 无权访问该关系 |
| `RELATIONSHIP_ALREADY_EXISTS` | 60002 | 409 | 你们已经是好友/情侣关系了 |
| `RELATIONSHIP_INVITE_NOT_FOUND` | 60003 | 404 | 邀请不存在或已失效 |
| `RELATIONSHIP_INVITE_EXPIRED` | 60004 | 410 | 邀请已过期，请重新邀请 |
| `RELATIONSHIP_INVITE_USED` | 60005 | 409 | 该邀请已被使用 |
| `RELATIONSHIP_INVITE_SELF` | 60006 | 400 | 不能邀请自己 |
| `RELATIONSHIP_INVITE_LIMIT` | 60007 | 429 | 邀请次数已达上限 |
| `RELATIONSHIP_STATUS_INVALID` | 60008 | 409 | 当前关系状态不支持该操作 |
| `COMPATIBILITY_PEER_NOT_READY` | 60009 | 409 | 对方还未完成测试，暂时无法生成匹配报告 |
| `COMPATIBILITY_REPORT_NOT_FOUND` | 60010 | 404 | 匹配报告不存在 |
| `COMPATIBILITY_GENERATING` | 60011 | 409 | 匹配报告正在生成中，请稍候 |
| `COMPATIBILITY_FEATURE_DISABLED` | 60012 | 403 | 情侣匹配功能暂未开放 |

## 8. 支付与会员（70000–70999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `PRODUCT_NOT_FOUND` | 70000 | 404 | 商品不存在 |
| `PRODUCT_OFF_SHELF` | 70001 | 409 | 商品已下架 |
| `ORDER_NOT_FOUND` | 70002 | 404 | 订单不存在 |
| `ORDER_NOT_OWNED` | 70003 | 403 | 无权访问该订单 |
| `ORDER_STATUS_INVALID` | 70004 | 409 | 订单状态不支持该操作 |
| `ORDER_EXPIRED` | 70005 | 410 | 订单已过期，请重新下单 |
| `ORDER_ALREADY_PAID` | 70006 | 409 | 订单已支付 |
| `PAYMENT_FAILED` | 70007 | 502 | 支付失败，请重试 |
| `PAYMENT_SIGN_INVALID` | 70008 | 400 | 支付签名校验失败 |
| `PAYMENT_NOTIFY_INVALID` | 70009 | 400 | 支付回调数据非法 |
| `PAYMENT_NOTIFY_DUPLICATED` | 70010 | 200 | 支付回调重复通知 |
| `PAYMENT_AMOUNT_MISMATCH` | 70011 | 400 | 支付金额不匹配 |
| `REFUND_NOT_ALLOWED` | 70012 | 409 | 该订单不支持退款 |
| `REFUND_FAILED` | 70013 | 502 | 退款失败，请联系客服 |
| `MEMBERSHIP_NOT_FOUND` | 70014 | 404 | 会员信息不存在 |
| `MEMBERSHIP_EXPIRED` | 70015 | 403 | 会员已过期 |
| `ENTITLEMENT_REQUIRED` | 70016 | 403 | 该内容需要付费解锁 |
| `ENTITLEMENT_NOT_FOUND` | 70017 | 404 | 权益不存在 |
| `PAYMENT_FEATURE_DISABLED` | 70018 | 403 | 支付功能暂未开放 |
| `ORDER_IN_PROGRESS` | 70019 | 409 | 存在进行中的订单或退款，请先处理后重试 |

## 9. 存储与文件（80000–80999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `FILE_TOO_LARGE` | 80000 | 413 | 文件过大 |
| `FILE_TYPE_NOT_ALLOWED` | 80001 | 415 | 不支持的文件类型 |
| `FILE_UPLOAD_FAILED` | 80002 | 502 | 文件上传失败，请重试 |
| `OSS_NOT_CONFIGURED` | 80003 | 500 | 文件存储服务未配置 |
| `SIGNED_URL_EXPIRED` | 80004 | 410 | 下载链接已过期 |
| `EXPORT_TASK_NOT_FOUND` | 80005 | 404 | 导出任务不存在 |
| `EXPORT_TASK_FAILED` | 80006 | 500 | 导出失败，请重试 |
| `STORAGE_SCENE_NOT_ALLOWED` | 80007 | 400 | 该上传场景暂未开放 |
| `OBJECT_KEY_INVALID` | 80008 | 400 | 文件标识不合法 |
| `OBJECT_NOT_OWNED` | 80009 | 403 | 无权访问该文件 |
| `OBJECT_NOT_FOUND` | 80010 | 404 | 文件不存在或已被清理 |
| `SIGN_URL_FAILED` | 80011 | 502 | 生成下载链接失败，请重试 |
| `STS_ASSUME_ROLE_FAILED` | 80012 | 502 | 上传凭证签发失败，请重试 |
| `STORAGE_CALLBACK_INVALID` | 80013 | 401 | 回调校验失败 |
| `FILE_MAGIC_MISMATCH` | 80014 | 400 | 文件内容与声明类型不符 |
| `FILE_SAFETY_VIOLATION` | 80015 | 451 | 文件内容未通过安全检测 |

## 10. 系统与第三方（90000–90999）

| 常量名 | 错误码 | HTTP | 用户可见文案 |
|---|---|---|---|
| `INTERNAL_ERROR` | 90000 | 500 | 服务开小差了，请稍后重试 |
| `SERVICE_UNAVAILABLE` | 90001 | 503 | 服务暂时不可用，请稍后重试 |
| `DATABASE_ERROR` | 90002 | 500 | 数据服务异常，请稍后重试 |
| `CACHE_ERROR` | 90003 | 500 | 缓存服务异常，请稍后重试 |
| `QUEUE_ERROR` | 90004 | 500 | 任务队列异常，请稍后重试 |
| `OUTBOX_PUBLISH_FAILED` | 90005 | 500 | 消息投递失败 |
| `THIRD_PARTY_ERROR` | 90006 | 502 | 第三方服务异常，请稍后重试 |
| `MAINTENANCE_MODE` | 90007 | 503 | 系统维护中，请稍后访问 |
| `CONFIG_MISSING` | 90008 | 500 | 服务配置缺失，请联系客服 |
| `SERVICE_SHUTTING_DOWN` | 90009 | 503 | 服务正在重启，请稍后重试 |

## 前端同步

前端只需声明「会做分支处理」的错误码子集，不要求全量镜像。已存在的子集：

| 文件 | 说明 |
|---|---|
| `frontend/miniapp/src/api/types.ts` | ERROR_CODES（小程序端子集） |
| `frontend/admin/src/constants/error-code.ts` | ErrorCode（管理后台子集） |

新增前端分支处理时，必须从本表取值，禁止在业务代码里写裸数字。

