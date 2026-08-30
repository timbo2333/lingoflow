# LingoFlow History Baseline Backup Schema 规范

本文档定义 History Baseline 在 Backup v2 中的长期实体语义与验证边界。

本规范与 Backup Schema 规范、个人数据备份规范、QueryEvent Backup Schema 规范和 Backup v2 Envelope 规范共同约束 legacy query-history facts 的备份表达。它不描述本地存储、Repository/API、Schema Validator、Export、Restore、用户界面或云同步方案。

当 Backup v2 声明支持 History Baseline 时，其实体数据必须遵守本规范。本规范本身不构成对 Repository、Validator、Export、Restore 或 Envelope 接入状态的声明。

## 1. Independent History Baseline Entity

在声明 History Baseline 的 Backup Envelope 中，`historyBaselines` 应作为独立的个人数据实体集合。

History Baseline，也称 Migration Baseline，表达：

> 无法还原为逐次 QueryEvent 的 legacy query-history facts。

History Baseline 不是：

- QueryEvent 或伪造的逐次事件集合。
- 当前 Vocab cache 或 Vocab 导出。
- local migration control state。
- Dictionary / lemma resource。
- sync metadata、同步队列或设备注册信息。

Baseline 与 QueryEvent 可以共同作为查询历史的事实输入，但必须遵守第 5 节的不重复事实边界。Vocab 只能由这两个事实集合重建。

## 2. Field Structure

当前长期 Baseline Entity 的正式结构为：

```json
{
  "id": "baseline:opaque-id",
  "createdAt": "2026-08-24T10:00:00.000Z",
  "deviceId": "legacy-source",
  "records": {}
}
```

本地实现可以使用其他容器组织 Baseline，但 Backup Entity 集合和身份不依赖本地 map key。

### 2.1 Required Fields

每个 History Baseline Backup Entity 必须包含：

- `id`：Baseline 的 opaque stable identity。
- `createdAt`：该兼容快照在创建 Baseline 时采用的建立或来源时间。
- `deviceId`：建立 Baseline 时保存的来源 provenance snapshot。
- `records`：该 Baseline 所表达的 legacy aggregate facts。

本 Schema 没有已知的可选顶层正式字段。未来合法兼容扩展按第 10 节处理。

### 2.2 Top-Level Field Type Rules

- `id` 必须是非空字符串，至少包含一个非空白字符，且不能包含首尾空白；不允许 `null`。
- `createdAt` 必须是第 7 节定义的 canonical ISO 8601 UTC string；不允许 `null`。
- `deviceId` 必须是非空字符串，至少包含一个非空白字符，且不能包含首尾空白；不允许 `null`。
- `records` 必须是普通 JSON 对象；不允许 `null`、数组或其他值。
- 空 `records` 对象 `{}` 合法，因为当前用户删除 legacy history record 后可能留下仍具有稳定身份的空 Baseline。

`deviceId` 表达 Baseline 创建来源的 opaque provenance value。它可能是来源设备身份，也可能是明确的 legacy 来源标签。Restore 必须原样保留它，但不得把它设置为目标环境的当前设备身份，也不得将其解释为同步路由或冲突胜负依据。

验证、导出和恢复不得：

- trim、规范化或转换字符串。
- 把字符串转换为数字、布尔值或时间。
- 自动补 `id`、`createdAt`、`deviceId`、`records` 或其他默认值。
- 自动生成或替换 Baseline ID。
- 自动生成、刷新或转换时间。
- 修改 Schema 输入。

所有字段都必须是实体自身可枚举的 JSON 数据字段。不能从原型链或 accessor 推断字段；验证不得执行 getter 或 setter。

### 2.3 `records` Structure

`records` 是以 legacy aggregate record 定位键为属性名的普通 JSON 对象。每个属性值都必须是普通 JSON 对象。

record 定位键必须：

- 是非空字符串。
- 至少包含一个非空白字符。
- 不包含首尾空白。

定位键是 records map 内的 compatibility storage locator。它不是 Baseline record identity、Baseline Entity identity、QueryEvent identity 或 `word` 的规范化证明，也不要求与 record 的 `word` 字段相等。

#### 2.3.1 Opaque Locator Invariants

- Locator 是 `records` compatibility snapshot map 中的 opaque data key，不是 Baseline Entity field name，也不是 Baseline record field name。
- Locator 不参与 reserved-field name validation。即使 locator 的字符串恰好等于 `vocab`、`lemma`、`syncStatus`、`count` 或其他正式、reserved / forbidden field 名称，也不能仅因该名称拒绝 Baseline。
- Backup 必须原样保存每个 record 的 locator 及其与 record value 的实际对应关系。
- Validator 不得根据 `record.word` 重写 locator，也不得把 locator 当作规范化 word 的证明。
- Restore 不得重新计算、normalize、合并或替换 locator。
- 本规范不规定 lowercase、lemma、Unicode normalization 或其他 locator 生成算法。

删除或修改某个 Baseline record 时，Domain 操作必须依据实际保存的 record / locator 关系找到目标。长期行为不得假定 `locator === normalizeWord(record.word)`，也不得仅通过 `delete records[normalizeWord(word)]` 定义记录删除。

Backup Schema 只定义 locator 的长期保真与关系不变量，不负责实现删除、修改、查找算法或 Repository API，也不规定按 word 操作时应选择一个还是多个匹配 record。本规范不授权 Validator 或 Restore 为适配当前代码而改变 locator。

每个 Baseline record 的已知字段边界如下：

| 字段 | 必需性与类型 | 空值/空字符串 | 首尾空白 | 语义 |
| --- | --- | --- | --- | --- |
| `word` | required string | 禁止空字符串和 `null` | 禁止 | legacy aggregate 的词文本定位事实 |
| `count` | required positive safe integer | 必须大于 0 | 不适用 | 无法拆分的查询事实总数 |
| `articleCount` | optional non-negative safe integer | 允许 0；不允许 `null` | 不适用 | 可确认来自 Article 的事实数量 |
| `searchCount` | optional non-negative safe integer | 允许 0；不允许 `null` | 不适用 | 可确认来自 Search 的事实数量 |
| `firstSeen` | optional canonical UTC string | 禁止空字符串和 `null` | 禁止 | 可确认的最早查询时间 |
| `lastSeen` | optional canonical UTC string | 禁止空字符串和 `null` | 禁止 | 可确认的最近查询时间 |
| `displayWord` | optional string | 允许空字符串；不允许 `null` | 允许并原样保留 | legacy 展示文本快照 |
| `phonetic` | optional string | 允许空字符串；不允许 `null` | 允许并原样保留 | legacy 音标快照 |
| `pos` | optional string | 允许空字符串；不允许 `null` | 允许并原样保留 | legacy 词性快照 |
| `meaning` | optional string | 允许空字符串；不允许 `null` | 允许并原样保留 | legacy 释义快照 |
| `dictionaryFound` | optional boolean | 不允许 `null` | 不适用 | legacy 保存的词典命中快照 |
| `source` | optional string | 禁止空字符串和 `null` | 禁止 | legacy 保存的 opaque 来源快照 |

safe integer 指 JSON number 且满足安全整数范围。Validator 不得接受 numeric string、浮点计数、负数、`NaN` 或无限值，也不得自动取整。

record 还必须满足：

- `articleCount` 存在时不得大于 `count`。
- `searchCount` 存在时不得大于 `count`。
- 两个来源计数都存在时，其总和不得大于 `count`。
- `count` 与已知来源计数之间的差额表示 legacy history 中无法可靠分类的查询事实；不得补造来源。
- `firstSeen` 与 `lastSeen` 都存在时，`firstSeen` 必须早于或等于 `lastSeen`。
- 字段缺失与显式零或空字符串是不同表达，Validator 和 Restore 不得自动互换。

Baseline record 可以包含第 10 节允许的未来 legacy fact / snapshot extension。unknown field 不能改变 `word`、计数和时间的既有含义。

### 2.4 Collection Rules

`historyBaselines` 集合必须满足以下规则：

- 集合必须是数组；对象 map、单个 Baseline 或其他容器不是合法集合。
- 空数组是合法集合，表示该备份范围内当前没有 History Baseline。
- 每个数组项都必须是普通 JSON 对象，不能是 `null`、数组或其他值。
- 每个数组项都必须完整通过顶层字段、records、时间、unknown field 与 reserved field 验证。
- 同一集合内不得出现重复 `id`；即使重复项完全一致，也必须拒绝整个集合。
- 任意一项无效或出现重复 `id` 时，整个 `historyBaselines` 集合应在首次写入前被拒绝，不能部分接受有效项。
- 不同 `id` 即使具有完全相同的 `records`，仍是结构上合法的独立 Baseline。
- 当 Envelope 声明 `historyBaselines` 时，该数组表达导出范围内 History Baseline 的完整 current-set，而不是默认意义上的分页或任意子集；这不改变第 9 节“集合或 record 缺失不传播删除”的规则。

## 3. Stable Identity

`id` 是 History Baseline 的稳定身份，而不是 records 当前内容的校验值。

- ID 一旦建立，在 records 变化、导出、恢复和跨环境传输中保持不变。
- Restore 必须原样保留备份中的 ID。
- Restore 不得根据当前 `records`、`createdAt`、`deviceId` 或 unknown fields 重新计算 ID。
- 本规范不锁定 UUID、hash、随机数或其他具体生成算法。
- 校验 hash、内容签名和集合位置不能替代 Baseline identity。

现有 Baseline 可能具有最初由内容签名选定的 ID，但 records 随后仍可能因用户删除历史单词而变化。该历史创建方式不构成长期 identity 规则；保存后的 ID 必须作为 opaque value 使用，不能因其看似包含内容来源而重新解释或重算。

`createdAt` 是创建 Baseline 时归属于该兼容快照的稳定时间 metadata。对本地迁移，它可以是 Baseline 建立时间；对 legacy import，它可以保留来源备份已有的快照创建时间。它不是逐次查询时间，也不是 records 最后修改时间，records 变化不得刷新它。

### 3.1 Same ID

同一 ID 表示同一 Baseline identity：

- 所有正式字段和合法 unknown fields 完全一致时为 `unchanged`。
- `records`、`createdAt`、`deviceId`、其他正式字段或 unknown field 任意不同均为 `conflict`。
- 同 ID 不同内容不能通过重新生成另一个 ID、覆盖或合并来掩盖。

### 3.2 Different IDs With Equal Records

不同 ID 即使 `records` 完全相同，也允许作为独立 Baseline 存在。

- 不按 records 内容自动去重或合并。
- 不根据内容相等选择一个 ID。
- 两个 Baseline 都会作为独立兼容事实参与 Vocab 重建。

因此，合规的 migration / creation boundary 必须确保不同 ID 没有重复表达同一批底层 legacy facts。相同 records 可能来自不同且真实独立的 legacy 来源，也可能暴露错误的重复迁移；仅凭内容相等无法安全证明二者身份相同。

## 4. Legacy Facts and Records Boundary

Baseline `records` 表达已经存在、但无法恢复为逐次 QueryEvent 的 legacy aggregate facts。

- `count` 及可确认的来源计数是兼容事实，不是为提高恢复速度保存的当前缓存。
- `firstSeen`、`lastSeen` 和精简 Dictionary 字段是 legacy 历史仍能确认的时间或展示快照。
- Baseline 不声称知道每次查询的独立 ID、精确顺序或逐项 Dictionary snapshot。
- Restore 不得按 `count` 生成伪造 QueryEvent。
- Baseline 不得包含现代 QueryEvent 已经表达的事实。

`records` 的形状与当前 Vocab representation 相似，不改变两者的数据性质：

- Baseline records 是 Personal Data 中的 legacy compatibility facts。
- Vocab 是由事实重建的 Derived/Rebuildable View。
- 当前 Vocab 的展示、排序或缓存结果不得自动写回 Baseline。
- Dictionary 或 lemma 的完整资源不属于 Baseline record。

## 5. Migration Boundary

Migration Baseline 与 QueryEvent 不得重复表达同一次查询事实。

一个合规的数据状态可以同时具有：

- 进入 QueryEvent 模型之前无法拆分的 legacy Baseline facts。
- 进入 QueryEvent 模型之后形成的独立 QueryEvent facts。

迁移或生成流程必须具有明确的一次性边界，不能仅凭“Baseline 为空且 Vocab 非空”推断 Vocab 是 legacy history。若已经存在现代 QueryEvent，或无法安全判断 Vocab 中哪些内容属于 legacy，就不得把该 Vocab 再包装为新 Baseline。

当前本地迁移控制状态 `EnglishReaderV052HistoryMigrationState` 可以作为这一边界的实现例证，但它不是本 Schema 的字段或存储契约：

- Migration State 不是 Personal Data Entity。
- Migration State 不进入 Backup v2。
- Migration State 只属于 local migration control state。
- Backup Validator、exact-match 和 Restore conflict 不读取或比较 Migration State。
- 本规范不绑定该名称、localStorage key、值结构或持久化方式。

Schema validation 可以验证两个集合各自的字段结构，但不能从聚合 records 可靠识别它与单项 QueryEvent 是否表达同一底层事实。事实不重叠主要由合规的一次性 migration、Export 输入边界及不伪造事实原则保证。

### 5.1 Local Migration Control After Restore

当前名为 `EnglishReaderV052HistoryMigrationState` 的状态属于 local migration control state。它不属于 QueryEvent、History Baseline、Vocab 或 Backup v2 Personal Data。

因此，Backup 必须遵守以下边界：

- 不导出 Migration State。
- 不从备份输入恢复 Migration State。
- 不把 Migration State 放入 Backup Envelope data。
- 不把 Migration State 当作 QueryEvent、History Baseline 或 Vocab 的字段、identity 或 conflict 输入。

当且仅当本轮 Restore 声明 `queryEvents` 和／或 `historyBaselines` 时，未来 Backup Restore 协调层必须维护这一一次性 migration boundary。未声明 Query History 实体的 Restore 不得仅因本次恢复读取、改变或收口本地 Migration State。

以下顺序发生在 Backup 输入已经通过 Envelope、各 Entity Schema，以及所有不依赖迁移后本地事实快照的输入预检与关系检查之后；它不授权无效输入触发本地迁移写入。安全顺序为：

1. 在取得供本轮所有 Query History Domain Assessment 使用的稳定本地事实快照之前，先处理当前本地尚未完成的 legacy migration prerequisite，安全保存需要保留的本地 legacy facts。若该 prerequisite 无法安全准备，不得继续 Query History Restore，也不得提前标记 migration completed。
2. 重新取得迁移后的稳定本地事实 snapshot，并完成本轮所有 Backup Domain Assessment。
3. 只有全部 Domain Assessment 已达到可执行状态，且尚未写入任何来自 Backup 输入的 Query History fact 时，才收口本地 Migration State。第一笔 QueryEvent 或 History Baseline Backup fact 写入前，Migration State 必须已经处于安全 completed 状态。
4. Restore QueryEvent facts。
5. Restore History Baseline facts。
6. 最后根据 QueryEvent 与 History Baseline facts 重建 Vocab。

步骤 1 是独立的本地 migration prerequisite，不是从 Backup 输入恢复实体。它可以在 Restore 开始前由本地迁移流程完整完成；若协调层发现它尚未完成，则必须先安全准备该前置边界或停止 Query History Restore。作为本轮 Restore 的 prerequisite，步骤 1 可以建立 Migration Baseline，但本轮对 Migration State 的收口必须等待步骤 3。无论该本地流程何时建立 Baseline 或收口 State，都不得被报告为 Backup 输入的部分恢复结果。

步骤 4 和步骤 5 的首次 Backup 输入写入只能发生在步骤 1 之后取得稳定本地事实快照、完成本轮所有剩余输入预检、跨实体关系检查和 Domain Assessment，并按步骤 3 安全收口 Migration State 之后。上述顺序定义安全边界，不规定具体 Repository API 或存储协议。

若步骤 1 已建立 Migration Baseline，但步骤 3 尚未安全完成，且尚未写入任何来自 Backup 输入的 QueryEvent 或 History Baseline fact，则不得开始步骤 6。此时原 legacy Vocab 可以继续作为未完成 migration 的来源快照保留；prerequisite、Domain Assessment 或 Migration State 收口失败均不得触发 derived Vocab rebuild。该边界保留 Migration Baseline 与其来源 legacy Vocab 的严格一致性检查，使后续重试可以继续安全收口，而不把未完成 migration 的本地副作用误报为 Backup 恢复结果。

一旦步骤 3 已安全完成，后续 Backup fact Restore 即使发生 partial 或 interrupted，也不得重新打开 migration boundary；否则已经写入的现代 facts 或由其重建的 Vocab 可能再次被误识别为 legacy history。

Restore 明确禁止：

- 先重建 Vocab，再恢复 QueryEvent 或 History Baseline facts。
- 从 Backup 输入读取或恢复 Migration State。
- 仅因 Restore 创建了空 QueryEvent storage，就提前关闭尚未处理的本地 legacy Vocab migration。
- 将 restored Vocab 再转换为 History Baseline。
- 在 `queryEvents` 与 `historyBaselines` 二者均未声明的 Restore 中，仅因本次 Restore 修改本地 Migration State。

若 Restore 在 facts 写入过程中发生中断，后续处理必须避免制造重复 migration facts。具体 recovery、重试、回滚、事务或中断恢复机制属于后续实现设计；本规范不设计或要求全局事务。

## 6. Lifecycle and Mutation

History Baseline 不能被描述为完全 immutable event。

- `id` 建立后不可变。
- `createdAt` 表示创建 Baseline 时归属于兼容快照的稳定建立或来源时间，后续 records 变化不能重写它。
- 当前删除历史单词可能直接从 `records` 中移除对应 record，同时保留相同 Baseline ID。
- 本 Schema 没有 `updatedAt`、`deletedAt` 或 tombstone。
- records 变化没有可用于自动排序版本的生命周期时间。

因此，首版 Backup Restore 必须采用保守的 whole-entity identity comparison：

- 本地不存在 ID：按备份中的原 ID、`createdAt`、`deviceId`、records 和 unknown fields 返回 `restored`。
- 本地与备份完全一致：返回 `unchanged`，不写入。
- 同 ID 但 records 或其他内容不同：返回 `conflict`，本地保持不变。
- 不自动执行 field merge 或 records map merge。
- 不根据 `createdAt` 或任何推测时间执行 LWW。
- 不把本地缺失 record 解释为可以从旧备份自动补回的事实。

合法但冲突的 Baseline 不应被误报为 Schema `rejected`。`rejected` 用于无效实体或无效集合；`conflict` 表示两个结构合法但同身份内容不同的事实版本。

## 7. Time Rules

`createdAt`、`firstSeen` 和 `lastSeen` 在存在时都必须使用 canonical ISO 8601 UTC string，采用带毫秒和 `Z` 时区标记的形式，例如：

```text
2026-08-24T10:00:00.000Z
```

唯一接受的形式为 `YYYY-MM-DDTHH:mm:ss.sssZ`，并且字段值必须表示有效的日历日期和时间。

- 不接受 number timestamp、epoch 值或 numeric string。
- 不接受本地时间、其他时区 offset、缺少毫秒或缺少 `Z` 的时间。
- 不得 trim、自动转换、补造或使用宽松日期解析结果替换输入。
- Restore 必须原样保留合法时间。
- `createdAt` 不表示 records 的最后修改时间。
- `firstSeen` 和 `lastSeen` 都存在时必须满足 `firstSeen <= lastSeen`。

本 Schema 不要求 `createdAt` 与 record 的 `firstSeen` / `lastSeen` 建立人为顺序；兼容快照采用的建立或来源时间与其所捕获的 legacy query facts 时间没有统一的先后保证。

## 8. Restore Conflict Rules

History Baseline Restore 的结果边界如下：

| 条件 | 结果 | 约束 |
| --- | --- | --- |
| 本地不存在 `id`，输入合法 | `restored` | 原样保留 ID、时间、records 和 unknown fields |
| same ID + exact same entity | `unchanged` | 不写入 |
| same ID + different records/metadata | `conflict` | 本地保持不变，不 merge、不 LWW |
| different ID + same records | 独立 `restored` | 不按内容去重；创建边界负责防止重复事实 |
| 实体字段非法 | `rejected` | 在任何相关写入前结束该集合处理 |

exact-match 必须包含所有正式字段和合法 unknown fields。普通 JSON 对象属性顺序不影响结构相等；数组顺序及所有 JSON 值仍属于内容。

## 9. Current-Set and Delete Boundary

首版 `historyBaselines` 也采用 current-set 边界，没有 Baseline tombstone 或 record tombstone。

- Backup 包含导出时当前存在的 Baseline 及其当前 records。
- 备份中缺少某个 Baseline ID 不表示删除本地 Baseline。
- 同一 Baseline 中缺少某个 record 不授权删除或覆盖本地 record。
- Restore 不根据集合或 records 缺失传播删除。
- 旧备份可能重新带回用户后来从 Baseline records 中 hard-delete 的历史，但同 ID 内容差异必须表现为 `conflict`，不能自动复活或覆盖。
- 空 Baseline 仍保留其稳定身份，不等同于删除。

本规范不在首版引入 Baseline tombstone、record tombstone、删除同步或永久删除证明。

## 10. Unknown Field Compatibility

History Baseline Backup Schema 允许未来合法的 legacy fact、provenance 或 snapshot extension 出现在 Baseline 顶层或 record 内。

- unknown field 必须可以由 JSON 完整、安全地表达。
- 接收方必须在验证、评估、恢复及后续导出往返中原样保留。
- exact-match 比较必须包含所有 unknown field 及其嵌套内容。
- unknown field 不参与 ID 推导、内容去重或自动冲突裁决。
- Validator、Export 和 Restore 不得修改输入对象。
- 接收方不能无损保留合法 unknown field 时，不得执行会丢失该字段的破坏性恢复。

合法 JSON-safe 值可以由 `null`、boolean、string、有限 number、非稀疏数组和普通 JSON 对象递归组成。`undefined`、function、Symbol、BigInt、非有限 number、稀疏数组、循环引用、accessor、原型行为和非普通 JSON 对象都不合法。

### 10.1 Reserved Field Rules

以下属性名称属于本 Schema 的 reserved fields。除本规范明确允许的正式字段外，它们作为 Baseline Entity、Baseline record 或 extension object 的实际字段名出现时，应使实体无效：

- Unsupported lifecycle：`updatedAt`、`deletedAt`、`tombstone`。
- Embedded events：`queryEvents`、`queryEventIds`。
- Derived Vocab containers / local index：`vocab`、`vocabCache`、`normalizedKey`、`searchIndex`。
- Migration control：`migrationState`、`migrationCompleted`、`migrationVersion`。
- Sync metadata：`syncStatus`、`remoteId`、`serverRevision`、`dirty`、`lastSyncedAt`、`vectorClock`。
- Complete resource containers：`dictionaryResource`、`dictionaryEntries`、`dictionaryData`、`lemmaResource`、`lemmaMappings`、`lemmaData`。

Baseline 还禁止通过任何字段名嵌入完整 QueryEvent、当前 Vocab view、Migration State、Dictionary / lemma resource 或同步运行状态。`dictionaryFound` 作为第 2.3 节定义的单项 legacy snapshot 字段仍然合法，不表示完整 Dictionary resource。

Reserved-field name validation 必须递归作用于：

- Baseline Entity 的直接字段，以及这些字段 value 中的 extension objects / arrays。
- `records` 中每个 record value 的直接字段。
- 每个 record value 内的 nested extension objects / arrays。

该递归不作用于 `records` map 自身的 locator key。Validator 应把 `records` 的直接属性名解释为 opaque locator，从每个 locator 对应的 record value 开始恢复正常的 reserved-field 递归检查。Locator 仍必须满足第 2.3 节的字符串结构规则，但不能因名称与 reserved field 相同而被拒绝。

例如，以下 Baseline records 合法；`"lemma"` 只是 locator，不是 record field：

```json
{
  "lemma": {
    "word": "apple",
    "count": 2
  }
}
```

以下 Baseline records 非法；`syncStatus` 位于 record value 内，是 reserved field：

```json
{
  "legacy-key": {
    "word": "apple",
    "count": 2,
    "syncStatus": "dirty"
  }
}
```

当前 History Baseline Schema Validator 采用“locator opaque、record value 递归检查”的行为，符合本长期规范；本澄清不要求修改 Validator。

Reserved field 不能通过 record value 的嵌套对象、数组或 unknown-field 机制绕过。未来如需改变这些名称或引入新的正式字段，必须通过 History Baseline Backup Entity Schema 的版本边界明确演进。

## 11. Vocab and Migration State Boundary

Vocab 不进入 Backup v2。

- Vocab 是 Derived Data，也是 Derived/Rebuildable View。
- Vocab 应由 `queryEvents` 与 `historyBaselines` 重建。
- Vocab 不是第三个查询历史事实源。
- Vocab 的缺失、缓存时间、排序或展示内容不参与 Baseline identity 和 conflict 判断。

Migration State 也不进入 Backup v2。它是本地迁移控制状态，不是用户历史、Baseline metadata 或可迁移设置。

## 12. Known Specification Risks and Future Boundary

History Baseline 仍具有以下长期风险：

1. **历史 ID 来源与可变内容耦合。** 现有记录的 ID 可能最初来自内容签名，而 records 后续可以变化。长期规则只能把保存后的 ID 视为 opaque stable identity；不能从当前内容验证或重算身份。
2. **缺少 mutation lifecycle。** 当前没有 `updatedAt`、record deletion fact 或 tombstone，因此同 ID 不同 records 无法安全判断先后，只能保守返回 `conflict`。
3. **不同 ID 的重复事实无法由字段 Schema 可靠识别。** 两个独立来源可能合法地产生相同 aggregate，也可能是错误重复迁移；一次性 migration boundary 必须预防后者。
4. **hard delete 不可传播。** 备份缺失不表示删除，旧备份可能重新携带已经删除的 legacy record。
5. **历史输入未必天然符合长期字段约束。** Baseline 可能源自此前未经过本 Schema 验证的 legacy aggregate。非 canonical 时间、非法计数或其他不合规值不能由 Validator 自动转换；它们需要在 Backup v2 Schema 之外独立评估或修复，不能通过放宽事实边界静默进入新备份。

长期可以考虑把 Baseline 重构为 immutable snapshot，并以独立、明确的机制表达用户对 legacy history 的删除或屏蔽。但这需要重新设计删除身份、生命周期和恢复语义，不属于本 Schema 首版，也不能描述为当前已实现能力。

在当前边界内，本 Schema 首版允许的安全恢复语义仅包括：严格字段验证、原样恢复缺失 ID、exact-match `unchanged` 和 same-ID 差异 `conflict`。本规范不授权自动 merge，也不表示这些能力已经实现。

## 13. Envelope Boundary

Backup Envelope 负责在未来声明 `historyBaselines` 集合及其 Entity Schema 版本，并承载对应数据。Envelope 不负责判断 facts 是否重叠、验证 records、解决冲突或执行恢复。

- Envelope 中的 Schema 声明和数据集合必须明确对应。
- Envelope 合法只表示容器和集合声明可识别，不表示 Baseline 可以安全恢复。
- 字段验证、批内 ID 检查、migration invariant、领域冲突评估和安全写入属于 Envelope 之后的独立边界。
- 本规范不注册新实体，也不新增或改变 Backup Envelope 的外层结构。

## 14. Legacy Backup Boundary

旧 JSON Backup 的 legacy merge 仍存在一个独立问题：文件可能同时包含 `queryEvents` 与派生 `vocab`，但没有明确的 History Baseline。若旧 Restore 把该 `vocab` 转换为 Baseline，会与已有 QueryEvent 形成重复事实。

该问题属于独立的 legacy Restore issue，不属于新 `historyBaselines` Schema 的兼容输入：

- 新 Schema 不接受 legacy Vocab map 作为 `historyBaselines`。
- Schema Validator 不从 `vocab` 生成 Baseline ID、records 或时间。
- Restore 不应在新 Schema 边界内猜测哪些 Vocab count 尚未由 QueryEvent 表达。
- 不得为兼容旧 merge 错误而放宽 Migration Boundary 或重复事实规则。

本规范不声称该 legacy Restore 问题已解决，也不修改旧 JSON Backup。

## 15. Out of Scope

本规范不设计：

- localStorage key、数据库、map container 或其他本地持久化布局。
- Repository、Schema Validator、Export、Restore 或其 API。
- Backup v2 Envelope 的实体注册或实现修改。
- UUID、hash 或其他具体 ID 生成算法。
- Vocab projector、聚合展示或查询 UI。
- Baseline immutable snapshot 重构、tombstone、删除同步或永久清理。
- 旧 JSON Backup 的迁移与恢复修复。
- 云同步、账号、后端、CRDT、LWW、vector clock 或网络传输协议。
