# LingoFlow Favorite Backup Schema 规范

本文档定义 Favorite 在 Backup v2 中的长期实体语义与验证边界。

本规范与 Favorite Entity 规范、Backup Schema 规范和 Backup v2 Envelope 规范共同约束 Favorite 的备份表达。它描述业务实体，不描述本地存储方式、代码接口、导出或恢复实现、用户界面及云同步协议。

当 Backup v2 声明支持 Favorite 时，其实体数据必须遵守本规范。本规范本身不构成对 Export、Restore 或 Envelope 实现状态的声明。

## 1. Favorite Backup Entity

在声明 Favorite 的 Backup Envelope 中，`favorites` 应作为独立的个人数据实体集合。集合中的每一项表达一个具有稳定身份的 Favorite，而不是本地收藏容器、内容索引或存储快照。

Favorite Backup Entity 应能够独立表达：

- 单词或词组收藏的稳定身份和类型。
- 用户保存的内容快照及用户元数据。
- 可选的来源信息和 Article 弱关联。
- 创建、更新、软删除与恢复所需的生命周期事实。

活动 Favorite 与仍处于保留范围内的软删除 Favorite 都属于该集合的备份范围。在本 Schema 的当前边界内，只要 Envelope 声明 `favorites`，该集合就按 Favorite 实体类型的完整备份范围解释；不得只导出活动 Favorite 却把该范围描述为完整。备份中没有出现某个 Favorite，不能自动解释为该 Favorite 已被删除。

## 2. Field Structure

Favorite Backup Entity 的字段按身份、内容快照、来源关联和生命周期划分。

### 2.1 Required Fields

- `id`：Favorite 的稳定身份。
- `type`：Favorite 类型，只能表达单词或词组。
- `text`：被收藏内容的主要文本快照。
- `createdAt`：Favorite 首次创建时间。
- `updatedAt`：Favorite 最近一次有效业务变化时间。
- `deletedAt`：软删除时间；活动 Favorite 为 `null`。

必需字段缺失、类型错误或语义无效时，该实体不能进入破坏性恢复流程。验证不得自动补字段、转换类型或生成身份与时间。

### 2.2 Content Snapshot Fields

Favorite 可以按业务需要保存以下已知内容快照字段：

- `displayText`：展示文本。
- `phonetic`：音标或发音说明。
- `partOfSpeech`：词性或其他内容说明。
- `meaning`：用户保存或编辑后的释义。
- `context`：上下文快照。
- `note`：用户备注。
- `tags`：用户标签集合。

这些字段一旦随 Favorite 保存并具有独立用户价值，就属于用户资产。即使其最初来自 Dictionary 或 Article，恢复时也不得使用当前可重建资源无提示替换。

内容快照的具体可选组合可以随 Favorite 类型和产品能力演进，但不能削弱稳定身份、用户内容保留和生命周期语义。

### 2.3 Source Association Fields

Favorite 可以包含可选来源信息，用于表达创建来源或对来源 Article 的弱关联。

`origin` 是可选的来源信息边界，可以为 `null`，也可以表达以下已知字段：

- `kind`：来源类别。
- `articleId`：来源 Article 的稳定身份。
- `articleTitleSnapshot`：为来源缺失后的展示而保留的标题快照。

来源快照与 Article 关联必须保持不同语义。标题或上下文不能替代 Article 身份，Article 身份也不能替代 Favorite 身份。

### 2.4 Field Type Rules

Favorite Backup Entity 的字段类型必须满足以下规则：

- `id` 是必需字段，必须是非空字符串，且不能包含首尾空白字符。
- `type` 是必需字段，只能是字符串 `"word"` 或 `"phrase"`。
- `text` 是必需字段，必须是至少包含一个非空白字符的字符串。验证必须保留原始文本，不得自动裁剪或规范化。
- `displayText`、`phonetic`、`partOfSpeech`、`meaning`、`context` 和 `note` 是可选字段；存在时必须是字符串。显式空字符串与字段缺失是不同的数据表达。
- `tags` 是可选字段；存在时必须是由字符串组成的非稀疏数组。
- `origin` 可以缺失、为 `null`，或为普通 JSON 对象。它不能是数组或其他非 JSON 对象。
- `origin.kind` 存在时必须是至少包含一个非空白字符的字符串。
- `origin.articleId` 存在时必须是非空字符串，且不能包含首尾空白字符。
- `origin.articleTitleSnapshot` 存在时必须是字符串。
- `createdAt`、`updatedAt` 和 `deletedAt` 必须满足本规范的 Time Rules。

所有字段都必须是实体自身的 JSON 数据字段。不能从原型链、accessor 或其他运行时行为推断字段；验证不得执行 getter 或 setter。

验证、导出和恢复不得：

- 自动 trim 或规范化字符串。
- 自动执行字符串、布尔值、数组或其他类型之间的转换。
- 自动补充空字符串、空数组、`null` 或其他默认值。
- 自动生成或替换 `id`。
- 自动生成、刷新或转换生命周期时间。

### 2.5 Collection Rules

`favorites` 集合必须满足以下规则：

- 集合必须是数组；对象 map、单个实体或其他容器不是合法的 `favorites` 集合。
- 空数组是合法集合，明确表示该备份范围内没有 Favorite 实体。
- Envelope 声明 `favorites` 时，该数组表示本 Schema 定义的完整 Favorite 集合。部分集合或部分恢复不是默认语义，未来如需支持，必须通过明确的新兼容边界定义。
- 每个数组项都必须是普通 JSON 对象，不能是 `null`、数组或其他值。
- 每个数组项都必须完整通过 Favorite Backup Entity 字段与生命周期验证。
- 同一集合内不得出现重复 `id`。
- 任意一项无效或出现重复 `id` 时，整个 `favorites` 集合应在写入前被拒绝。不能先恢复有效项，再把该集合报告为已通过验证。

## 3. Stable Identity

Favorite Backup Entity 必须保留其原始稳定 ID。

- ID 在创建、编辑、软删除、恢复、备份和跨环境传输中保持不变。
- ID 不得由 `text`、类型、大小写、规范化文本、内容 hash、来源 Article、时间或集合位置推导。
- 恢复不得为已有备份实体生成替代 ID。
- 已删除 Favorite 的 ID 不得分配给新的 Favorite。
- 内容相同不能证明两个 Favorite 是同一实体。

批次内重复 ID 表示身份不明确或备份损坏，应在写入前被拒绝。不同 ID 的实体始终具有独立身份。

## 4. Word and Phrase Types

Favorite 类型只能表达以下两类业务语义：

- `word`：单词收藏。
- `phrase`：由多个词或一个具有词组语义的文本形成的收藏。

类型是 Favorite 业务事实，但不是 Favorite 身份。

- 不得根据空格数量、词典命中结果或其他派生规则在恢复时重写类型。
- 同一 ID 出现不同类型时，应视为业务内容冲突，而不是自动转换。
- 不同 ID 即使类型和文本完全相同，也应作为独立 Favorite 保留。

## 5. Content Snapshot Boundary

Favorite 的内容快照必须在不依赖外部资源的情况下保持可理解。

- 释义、上下文、备注和标签不能被当作可重建缓存丢弃。
- Dictionary 条目、lemma、词典版本和当前命中状态不属于 Favorite 内容快照。
- 恢复不得重新查询 Dictionary 或 Article 来补造、规范化或覆盖用户保存的内容。
- 内容规范化可以服务于搜索与展示，但不能写回为身份事实或自动合并依据。
- 无法理解但仍属于 Favorite 用户资产的合法扩展内容，不得被无提示删除。

## 6. Article Weak Association

Favorite 对来源 Article 的关联是可选弱引用。

- 关联应使用 Article 的稳定身份，不使用标题、正文或来源地址推导关联身份。
- Article 不存在、尚未恢复、已软删除或不可访问时，Favorite 仍然有效。
- Article 缺失不能成为拒绝 Favorite 或丢弃内容快照的理由。
- 删除或恢复 Article 不级联删除、恢复或改写 Favorite。
- 来源标题等信息只能作为来源快照保留，不能被当作实时 Article 真值。

Favorite Schema 只验证关联字段本身的语义，不负责读取 Article、决定恢复顺序或修复来源关系。

## 7. Lifecycle Timestamps

### 7.1 `createdAt`

`createdAt` 表示 Favorite 首次创建时间。它在更新、软删除、恢复和备份恢复中保持不变。

### 7.2 `updatedAt`

`updatedAt` 表示 Favorite 内容快照、用户元数据、来源关联或生命周期状态最近一次发生有效变化的时间。

Learning State、派生视图或同步运行状态的变化不得无关刷新 Favorite 的 `updatedAt`。

### 7.3 `deletedAt`

`deletedAt` 表示 Favorite 进入软删除状态的时间。活动 Favorite 必须明确表达未删除状态。

生命周期时间应具有有效顺序：

- `createdAt` 不晚于 `updatedAt`。
- 存在 `deletedAt` 时，它不早于 `createdAt`，也不晚于 `updatedAt`。

时间字段不能代替稳定 ID，也不能被预设为所有冲突的唯一裁决依据。验证和恢复不得生成、刷新或重新解释备份中的生命周期时间。

### 7.4 Time Rules

Favorite Backup Entity 的生命周期时间使用规范化的 ISO 8601 UTC 字符串，采用带毫秒和 `Z` 时区标记的形式，例如：

```text
2026-08-24T10:00:00.000Z
```

唯一接受的规范形式为 `YYYY-MM-DDTHH:mm:ss.sssZ`；时间值本身也必须是有效日期与时间。

- `createdAt` 和 `updatedAt` 必须是合法的 ISO 8601 UTC 字符串。
- `deletedAt` 必须为 `null` 或合法的 ISO 8601 UTC 字符串。
- `createdAt` 必须早于或等于 `updatedAt`。
- `deletedAt` 非 `null` 时，必须晚于或等于 `createdAt`，且早于或等于 `updatedAt`。
- 验证不得把本地时间、带其他时区偏移的时间或可被宽松解析的字符串自动转换为规范化 UTC 时间。

## 8. Tombstone Semantics

带有有效删除状态的 Favorite 是 tombstone。

- tombstone 仍表示原稳定身份，不表示一个新的删除实体。
- tombstone 应保留恢复、冲突判断和删除事实传播所需的内容与生命周期信息。
- 本地不存在对应活动实体时，不能因此丢弃合法 tombstone。
- 备份中缺少某个 ID 不构成 tombstone，也不授权删除本地实体。
- 恢复 tombstone 不等于执行永久清理。
- tombstone 的最终清理条件和保留时间不由本规范规定。

Favorite 被软删除时，不级联删除其来源 Article、QueryEvent 或通过 Favorite ID 关联的独立 Learning State。

## 9. Conflict Principles

### 9.1 Same ID

同一稳定 ID 的本地与备份实体应按记录身份进行比较。

- 完全一致的实体为 `unchanged`，不需要写入。
- 本地不存在时，可以按备份中的原身份和生命周期恢复活动实体或 tombstone。
- `createdAt` 不一致表示身份或历史语义冲突，不能通过普通覆盖掩盖。
- 内容快照、用户元数据、来源关联或合法未知字段不一致时，应识别为内容冲突。
- 两条活动记录的业务内容相同但 `updatedAt` 或其他生命周期时间不一致时，应识别为生命周期或历史冲突，不能视为 `unchanged`。
- 活动状态与删除状态不一致时，应识别为生命周期冲突。
- 两个 tombstone 的内容或生命周期不一致时，仍可能构成冲突。

冲突处理不得静默覆盖重要用户内容、无提示复活已删除实体或无提示删除本地更新。`updatedAt` 可以提供判断信息，但不能单独决定整条记录的胜负。

### 9.2 Different IDs With Equal Content

不同稳定 ID 的 Favorite 即使类型、文本、释义和上下文完全相同，也必须作为独立记录处理。

- 不按内容自动去重。
- 不合并备注或标签。
- 不选择时间较新的记录替代另一条记录。
- 一个 ID 的 tombstone 不能作用于另一个 ID。

任何内容相似度或规范化结果都只能服务于非破坏性的提示和展示。

## 10. Unknown Field Compatibility

Favorite Backup Schema 应允许业务模型安全演进，同时保护用户内容。

### 10.1 Unknown User Asset Fields

- 合法、可由 JSON 完整表达且属于 Favorite 用户资产的未知字段，应在读取、评估和恢复往返中保留。
- 未知字段不得参与身份推导、内容去重或自动冲突裁决。
- 接收方若不能安全保留某个未知用户字段，不得执行会丢失该字段的破坏性恢复。
- accessor、Symbol、非有限数值、循环引用或其他无法安全表达的内容不属于合法备份字段。
- 未知字段不能绕过本规范对 Learning State、派生状态和同步运行状态的边界限制。

新增或改变字段语义时，应通过 Favorite Backup Entity Schema 自身的版本边界演进，不应无关改变 Backup Envelope 的外层含义。

### 10.2 Reserved Field Rules

以下属性名称属于本 Schema 的 reserved fields。它们表达 Favorite 边界之外的状态，在 Favorite Entity 的任何嵌套层级出现时都应被拒绝：

- Learning State：`mastered`、`reviewCount`、`dueAt`、`interval`、`proficiency`、`reviewInterval`、`nextReviewAt`。
- Dictionary derived state：`dictionaryFound`、`dictionaryVersion`。
- Sync metadata：`syncStatus`、`remoteId`、`serverRevision`、`deviceId`、`dirty`、`lastSyncedAt`、`vectorClock`。
- Local index：`normalizedKey`、`searchIndex`。

reserved field 不能通过嵌套对象、`origin`、标签或 unknown-field 机制进入 Favorite Entity。该规则是本 Favorite Backup Entity Schema 明确选择的兼容边界；未来如需增加或改变 reserved field 名称，应通过该 Backup Entity Schema 的版本边界明确演进，不能由读取方临时猜测。

除 reserved fields 和本规范明确排除的语义外，合法且确属 Favorite 用户资产的未知 JSON 字段可以保留，并继续遵循本节的完整往返规则。

## 11. Explicitly Excluded Fields

以下内容明确禁止进入 Favorite Backup Entity：

- `mastered` 或任何掌握度字段。
- Favorite Learning State 或其他复习状态。
- SRS、复习间隔、下次复习时间和学习算法字段。
- `dictionaryFound`、当前词典命中、词典版本、lemma 或其他派生与可重建状态。
- 规范化搜索键、排序索引、统计数量和筛选结果。
- 设备标识、远端标识、同步状态、上传队列、服务端 revision、最后同步时间及其他 sync metadata。
- 旧 Favorite map key、集合位置或任何内容派生身份。

这些信息不能以未知字段、标签或来源字段的形式伪装进入 Favorite。

## 12. Envelope Boundary

Backup Envelope 负责声明 `favorites` 集合及其 Entity Schema 版本，并承载对应数据。Envelope 不负责验证 Favorite 字段、解决冲突或执行恢复。

- Envelope 中的 Schema 声明和数据集合必须能够明确对应。
- Envelope 合法只表示容器和集合声明可识别，不表示 Favorite 可以安全恢复。
- Favorite 字段验证、批内身份检查、领域冲突评估和安全写入属于 Envelope 之后的独立边界。
- 本规范不新增或改变 Backup Envelope 的外层结构。

## 13. Legacy Compatibility Boundary

本规范不支持旧 Favorite 数据迁移。

- 旧 Favorite map、旧内容键和旧备份记录不属于 `favorites` Backup Entity 的合法输入。
- 不从旧单词或词组文本生成稳定 ID。
- 不使用确定性 ID、内容 hash 或旧 map key 模拟稳定身份。
- 不把旧 Favorite 中内嵌的学习状态转换为新 Favorite 字段。
- 不执行旧数据提取、转换、自动合并或隐式导入。

旧格式如继续存在，应保持在明确隔离的 legacy 边界内，不得静默进入新 Favorite Schema。任何改变该边界的需求都需要独立设计。

## 14. Out of Scope

本规范不设计：

- 本地存储引擎、数据库或存储键。
- Export、Restore、Repository 或其他代码接口。
- 文件读取、下载、序列化和用户界面。
- 具体冲突算法或覆盖操作流程。
- tombstone 的固定保留期限和永久清理机制。
- 云同步、账号、后端、CRDT 或传输协议。
