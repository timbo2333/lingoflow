# LingoFlow Favorite Learning State Backup Schema 规范

本文档定义 Favorite Learning State 在 Backup v2 中的长期实体语义与验证边界。

本规范与 Favorite Entity 规范、Favorite Backup Schema 规范、Backup Schema 规范和 Backup v2 Envelope 规范共同约束学习状态的备份表达。它不描述本地存储、代码接口、导出或恢复实现、学习算法及云同步方案。

当 Backup v2 声明支持 Favorite Learning State 时，其实体数据必须遵守本规范。本规范本身不构成对 Export、Restore 或 Envelope 实现状态的声明。

## 1. Independent Backup Entity

在声明 Favorite Learning State 的 Backup Envelope 中，`favoriteLearningStates` 应作为独立的个人数据实体集合。

Favorite Learning State 表达用户针对某个 Favorite 明确保存的学习状态。它不是 Favorite 内容字段、标签、派生视图或同步运行状态。

- Learning State 通过 Favorite 的稳定身份建立关联。
- Learning State 具有独立于 Favorite 内容变化的生命周期。
- Learning State 的变化不得修改 Favorite 的内容、身份或更新时间。
- Favorite 的删除、恢复或内容更新不得无提示改写 Learning State。

本 Schema 只表达 `mastered` 状态，不定义复习系统或学习算法。

活动 Favorite Learning State 与仍处于安全保留范围内的 tombstone 都属于 `favoriteLearningStates` 的备份范围。在本 Schema 的当前边界内，只要 Envelope 声明该集合，就按 Favorite Learning State 实体类型的完整备份范围解释；不得只导出活动状态却把该范围描述为完整。如有意省略该集合，Envelope 必须明确不声明该实体范围。

## 2. Field Structure

### 2.1 Required Fields

每个 Favorite Learning State Backup Entity 由以下字段组成：

- `favoriteId`：所关联 Favorite 的稳定 ID。
- `mastered`：用户明确保存的掌握状态。
- `createdAt`：该 Learning State 首次建立的时间。
- `updatedAt`：该 Learning State 最近一次有效变化时间。
- `deletedAt`：该 Learning State 的软删除时间；活动状态为 `null`。

这些字段共同表达 mastered-only Learning State 的完整业务事实。缺失字段、额外算法字段、类型错误或生命周期无效时，实体不能进入破坏性恢复流程。

验证不得自动生成 `favoriteId`、时间或 `mastered`，也不得使用默认值修复缺失事实。

### 2.2 Field Type Rules

- `favoriteId` 是必需字段，必须是非空字符串，且不能包含首尾空白字符。
- `mastered` 是必需字段，必须是布尔值 `true` 或 `false`。
- `createdAt` 和 `updatedAt` 是必需字段，必须满足本规范的 Time Rules。
- `deletedAt` 是必需字段，必须为 `null` 或满足本规范 Time Rules 的时间字符串。
- 本 mastered-only Schema 不接受上述五个字段之外的额外字段。未来学习事实必须通过新的 Schema 边界演进。

验证不得 trim `favoriteId`，不得把 truthy、falsy、数字、字符串或其他值转换为 boolean，也不得补充默认状态、关联身份或生命周期时间。

所有字段都必须是实体自身可枚举的 JSON 数据字段。不能从原型链或 accessor 推断字段；验证不得执行 getter 或 setter。

### 2.3 Collection Rules

`favoriteLearningStates` 集合必须满足以下规则：

- 集合必须是数组；对象 map、单个状态或其他容器不是合法集合。
- 空数组是合法集合，明确表示该备份范围内没有 Favorite Learning State。
- Envelope 声明 `favoriteLearningStates` 时，该数组表示本 Schema 定义的完整 Learning State 集合。部分集合或部分恢复不是默认语义，未来如需支持，必须通过明确的新兼容边界定义。
- 每个数组项都必须是普通 JSON 对象，不能是 `null`、数组或其他值。
- 每个数组项都必须完整通过 Favorite Learning State 字段与生命周期验证。
- 同一集合内不得出现重复 `favoriteId`。
- 任意一项无效或出现重复 `favoriteId` 时，整个 `favoriteLearningStates` 集合应在写入前被拒绝。不能先恢复有效项，再把该集合报告为已通过验证。

## 3. Identity and Favorite Association

在 `favoriteLearningStates` 实体边界内，Learning State 通过 `favoriteId` 确定其一对一关联身份。

- `favoriteId` 必须精确引用 Favorite 的稳定 ID。
- 不得使用 Favorite 文本、类型、规范化内容、旧 map key 或内容 hash 建立关联。
- 同一批次中不能出现多个相同 `favoriteId` 的 Learning State。
- 不同 `favoriteId` 的状态始终独立，即使对应 Favorite 内容相同。
- Learning State 不得重新关联到另一个 Favorite。

Favorite 可以处于活动或软删除状态。Favorite 的 tombstone 不使其 Learning State 自动失效，也不构成级联删除依据。

Schema 验证只确认 `favoriteId` 的结构和批内唯一性，不读取 Favorite。跨集合完整性应在 Envelope 解包和实体 Schema 验证之后单独检查：

- 未解析的关联必须被明确识别。
- 未解析关联不能按内容猜测目标。
- 未解析关联不能导致 Learning State 被静默丢弃或改挂到其他 Favorite。
- 当备份同时声明 Favorite 与 Learning State 集合时，关联完整性问题应在破坏性写入前报告。

### 3.1 Relationship Rules

Favorite 是否存在不属于 Favorite Learning State Schema validation 的判断范围。跨实体关系检查属于 Restore Assessment 阶段，并且应在任何相关写入之前完成。

- 每条 Learning State 都必须解析到同一 Backup 中的 Favorite，或目标环境中已经存在的本地 Favorite。
- Backup 中的 Favorite 与本地 Favorite 都可以处于活动或 tombstone 状态；两者都能满足该稳定身份关联。
- Favorite tombstone 是可解析的原稳定身份，不能仅因 Favorite 已软删除而把 Learning State 判为无效。
- 无法通过同一 Backup 或本地 Favorite 解析的 `favoriteId` 必须得到明确的 unresolved 结果，并使整次 Restore 在首次写入前结束；相关 Learning State 不得被写入、静默丢弃或改挂到其他 Favorite。
- 关系检查不得自动创建 Favorite 或生成替代 Favorite ID。
- Favorite 缺失或未包含在当前备份中，不得自动删除 Learning State 或生成 Learning State tombstone；本地 Favorite 处于 tombstone 状态也不得触发该行为。
- Favorite 存在但 Learning State 缺失时，不得自动创建状态，也不得把缺失状态解释为 `mastered: false`。
- 跨实体关系检查不改变实体 Schema validation 的结果，也不把关系问题伪装成字段类型错误。

## 4. `mastered` Semantics

`mastered` 是布尔业务事实：

- `true` 表示用户明确保存了已掌握状态。
- `false` 表示用户明确保存了未掌握状态。

`mastered` 不表达熟练度、记忆强度、复习结果、复习次数或算法评分。

恢复不得根据 Favorite 内容、标签、查询次数、阅读行为或词典状态推断 `mastered`。不同来源中的 `mastered` 也不得使用逻辑 OR、逻辑 AND 或其他简化规则自动合并。

## 5. Missing State and Explicit False

不存在 Learning State 与存在 `mastered: false` 的 Learning State 是不同的数据事实。

- 不存在状态表示用户没有可恢复的显式 Learning State 记录。
- `mastered: false` 表示存在一条明确的用户状态及其生命周期历史。
- 展示层可以将两者呈现为相似状态，但 Backup Schema 不得因此折叠两者。
- 备份中缺少某个 `favoriteId` 的 Learning State，不授权创建 `mastered: false`。
- 恢复 Favorite 时不得自动为其创建 Learning State。
- 恢复 Learning State 时不得为缺失 Favorite 生成替代 Favorite。

## 6. Lifecycle Fields

### 6.1 `createdAt`

`createdAt` 表示该 Learning State 首次被明确建立的时间。后续 mastered 变化、软删除和恢复不得改变它。

### 6.2 `updatedAt`

`updatedAt` 表示 `mastered` 或该 Learning State 生命周期最近一次发生有效变化的时间。

Favorite 内容、Favorite 来源关联、Favorite 删除状态或同步运行状态的变化，不应无关刷新 Learning State 的 `updatedAt`。

### 6.3 `deletedAt`

`deletedAt` 表示 Learning State 自身进入软删除状态的时间。活动 Learning State 必须明确表达未删除状态。

生命周期时间应满足：

- `createdAt` 不晚于 `updatedAt`。
- 存在 `deletedAt` 时，它不早于 `createdAt`，也不晚于 `updatedAt`。

时间字段不能代替 `favoriteId`，也不能被预设为所有冲突的唯一裁决依据。备份验证和恢复不得重写或补造这些时间。

### 6.4 Time Rules

Favorite Learning State 的生命周期时间使用规范化的 ISO 8601 UTC 字符串，采用带毫秒和 `Z` 时区标记的形式，例如：

```text
2026-08-24T10:00:00.000Z
```

唯一接受的规范形式为 `YYYY-MM-DDTHH:mm:ss.sssZ`；时间值本身也必须是有效日期与时间。

- `createdAt` 和 `updatedAt` 必须是合法的 ISO 8601 UTC 字符串。
- `deletedAt` 必须为 `null` 或合法的 ISO 8601 UTC 字符串。
- `createdAt` 必须早于或等于 `updatedAt`。
- `deletedAt` 非 `null` 时，必须晚于或等于 `createdAt`，且早于或等于 `updatedAt`。
- 验证不得把本地时间、带其他时区偏移的时间或可被宽松解析的字符串自动转换为规范化 UTC 时间。

## 7. Tombstone Semantics

带有有效删除状态的 Favorite Learning State 是该 Learning State 的 tombstone。

- tombstone 保留原 `favoriteId`、最后可恢复的 `mastered` 值和生命周期事实。
- Learning State tombstone 不等同于 `mastered: false`。
- Favorite tombstone 不自动产生 Learning State tombstone。
- Learning State tombstone 不自动删除或恢复 Favorite。
- 本地不存在活动 Learning State 时，不能因此丢弃备份中的合法 tombstone。
- 备份中缺少某条 Learning State 不表示该状态已被删除。
- 恢复 tombstone 不等于永久清理。

Learning State tombstone 在安全清理前仍属于用户个人数据。其固定保留时间和最终清理条件不由本规范规定。

## 8. Conflict Principles

### 8.1 Different `favoriteId`

不同 `favoriteId` 的 Learning State 始终是独立记录，不因 Favorite 内容相同而合并。

### 8.2 Same `favoriteId`

同一 `favoriteId` 的本地与备份状态应按同一 Learning State 进行比较。

- 完全一致的状态为 `unchanged`，不需要写入。
- 本地不存在时，可以按备份中的原状态和生命周期恢复活动记录或 tombstone。
- `createdAt` 不一致表示身份或历史语义冲突。
- `mastered` 不一致表示学习状态冲突。
- 两条活动记录的 `mastered` 与 `createdAt` 相同但 `updatedAt` 或其他生命周期时间不一致时，应识别为生命周期或历史冲突，不能视为 `unchanged`。
- 活动状态与 tombstone 不一致表示生命周期冲突。
- 两个 tombstone 的 `mastered` 或生命周期不一致时仍可能构成冲突。

冲突不得通过以下方式静默解决：

- 对 `mastered` 使用逻辑 OR 或 AND。
- 仅根据 `updatedAt` 对整条记录执行最后写入获胜。
- 把 tombstone 自动转换为 `mastered: false`。
- 自动恢复已删除状态。
- 丢弃无法理解的学习事实。

无法安全自动处理时，应保留本地和备份信息的可恢复边界，并返回明确的冲突结果。

## 9. Unknown Fields and Future Evolution

本 Schema 是 mastered-only Learning State 边界。未声明的 SRS、复习算法或同步字段不属于合法扩展。

- 读取方不得接受未知学习字段后在恢复时静默丢弃。
- 无法按本 Schema 完整理解和保留的额外字段，应在写入前被明确拒绝。
- 未来若增加新的学习事实，应先定义清晰的业务语义、身份和生命周期，再通过独立 Schema 演进。
- 新的学习系统可以扩展现有实体或建立新的关联实体，但不能无提示改变 `mastered` 的既有含义。
- 新 Schema 不能把算法缓存、复习计划或同步运行状态伪装成 mastered-only 数据。

实体 Schema 的演进独立于 Backup Envelope 外层版本。只有 Envelope 自身含义改变时，才需要改变 Envelope 版本。

## 10. Explicitly Excluded Fields

以下内容明确禁止进入 mastered-only Favorite Learning State Backup Entity：

- SRS 间隔、ease、复习队列、下次复习时间或到期时间。
- 复习次数、正确率、连续记录、记忆强度、熟练度或评分。
- 算法版本、调度器内部状态和算法缓存。
- Favorite 文本、类型、释义、上下文、备注、标签或来源快照。
- Dictionary 命中、查询次数、阅读行为和其他派生状态。
- 设备标识、远端标识、同步状态、上传队列、服务端 revision、最后同步时间及其他 sync metadata。

这些信息不能作为未知字段混入 `favoriteLearningStates`。

## 11. Envelope Boundary

Backup Envelope 负责声明 `favoriteLearningStates` 集合及其 Entity Schema 版本，并承载对应数据。Envelope 不负责解释 `mastered`、验证关联、解决冲突或执行恢复。

- Envelope 中的 Schema 声明与数据集合必须明确对应。
- `favoriteLearningStates` 必须与 `favorites` 保持独立实体集合，不能嵌入 Favorite 记录。
- Envelope 合法只表示容器和集合声明可识别，不保证关联完整或恢复安全。
- 字段验证、批内唯一性、跨集合关联、领域冲突和安全写入属于 Envelope 之后的独立边界。
- 本规范不新增或改变 Backup Envelope 的外层结构。

## 12. Legacy Compatibility Boundary

本规范不支持从旧 Favorite 数据迁移 Learning State。

- 不读取旧 Favorite map 中内嵌的 `mastered`。
- 不按旧 Favorite 内容键建立 `favoriteId` 关联。
- 不从旧文本、类型或内容 hash 生成关联身份。
- 不自动把旧收藏中的缺失 `mastered` 解释为显式 `false`。
- 不执行旧学习状态提取、转换、自动合并或隐式导入。

旧格式如继续存在，应保持在明确隔离的 legacy 边界内。任何改变该边界的需求都必须独立设计。

## 13. Out of Scope

本规范不设计：

- 本地存储方式、数据库结构或存储键。
- Export、Restore、Repository 或其他代码接口。
- SRS、复习计划、评分或调度算法。
- 具体冲突算法和覆盖流程。
- tombstone 的固定保留期限与永久清理机制。
- 文件读取、下载、用户界面、云同步、账号、后端或传输协议。
